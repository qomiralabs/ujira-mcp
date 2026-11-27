// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The sign in routes against a real database, logged in as the app is in
// production, with wallets made in the test: a challenge is spent once, a
// session is found only by the hash of its cookie, sign out ends it, and
// /v1/me shows a person only the principals they belong to.

import { createHash, randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { createV1App } from '../src/api/app.js';
import { authRoutes } from '../src/api/routes/auth.js';
import { postgresSignInStore } from '../src/auth/postgres-store.js';
import { sessionTokenHash } from '../src/auth/session-token.js';
import { SignIn, SIGN_IN_LIMITS, type SignInStore } from '../src/auth/sign-in.js';
import { entryPoints, type Database } from '../src/db/index.js';
import {
  createTestDatabase,
  databaseAsServiceRoles,
  type TestDatabase,
} from '../src/db/testing/index.js';
import {
  clientFor,
  errorCode,
  ORIGIN,
  signBase64,
  signInWith,
  verifier,
  wallet,
  type Call,
} from './sign-in-helpers.js';

const adminUrl = inject('dbAdminUrl');
const roleUrls = inject('dbRoleUrls');

let database: TestDatabase;
let db: Database;
let store: SignInStore;
let call: Call;
const lines: string[] = [];

beforeAll(async () => {
  database = await createTestDatabase(adminUrl, import.meta.url);
  db = databaseAsServiceRoles(roleUrls, database);
  store = postgresSignInStore(db);
  const log = (line: string) => {
    lines.push(line);
  };
  const signIn = new SignIn({ store, verifier, origin: ORIGIN, log });
  call = clientFor(createV1App({ routes: authRoutes({ signIn, origin: ORIGIN }), log }).app);
});

afterAll(async () => {
  await db.close();
  await database.drop();
});

// Each test signs in from its own client address, so the per client buckets
// of one test never run out in another.
function client(): string {
  return `client-${randomUUID()}`;
}

describe('sign in on Postgres', () => {
  it('trades a signed challenge for a session once, and signs out for good', async () => {
    const kp = wallet();
    const from = client();
    const { answer, token, challengeId, message } = await signInWith(call, kp, { client: from });
    expect(answer.status).toBe(200);
    expect(answer.json).toMatchObject({ member: { address: kp.publicKey() }, principals: [] });
    expect(token).toBeDefined();

    // The cookie resolves through its hash, and nothing else does.
    const hash = sessionTokenHash(token ?? '');
    expect(hash).toBeDefined();
    expect(await store.resolveSession(hash ?? Buffer.alloc(32), null)).toMatchObject({
      walletAddress: kp.publicKey(),
    });
    const other = createHash('sha256')
      .update(token ?? '')
      .digest();
    expect(await store.resolveSession(other, null)).toBeUndefined();

    const reused = await call('POST', '/v1/auth/session', {
      body: { challengeId, address: kp.publicKey(), signature: signBase64(kp, message) },
      client: from,
    });
    expect(reused.status).toBe(401);
    expect(errorCode(reused)).toBe('SESSION_INVALID');

    const me = await call('GET', '/v1/me', { cookie: token ?? '' });
    expect(me.status).toBe(200);
    expect(me.json).toEqual(answer.json);

    const out = await call('DELETE', '/v1/auth/session', { cookie: token ?? '' });
    expect(out.status).toBe(200);
    expect(errorCode(await call('GET', '/v1/me', { cookie: token ?? '' }))).toBe('SESSION_INVALID');
    expect(await store.resolveSession(hash ?? Buffer.alloc(32), null)).toBeUndefined();
  });

  it('spends the challenge on a bad signature and records the security event', async () => {
    const kp = wallet();
    const from = client();
    const challenge = await call('POST', '/v1/auth/challenge', {
      body: { address: kp.publicKey() },
      client: from,
    });
    expect(challenge.status).toBe(201);
    const message = String(challenge.json?.['message']);
    const forged = await call('POST', '/v1/auth/session', {
      body: {
        challengeId: challenge.json?.['challengeId'],
        address: kp.publicKey(),
        signature: signBase64(wallet(), message),
      },
      client: from,
    });
    // A 500 here would mean the event could not be written.
    expect(forged.status).toBe(401);
    expect(errorCode(forged)).toBe('SESSION_INVALID');
    const retry = await call('POST', '/v1/auth/session', {
      body: {
        challengeId: challenge.json?.['challengeId'],
        address: kp.publicKey(),
        signature: signBase64(kp, message),
      },
      client: from,
    });
    expect(errorCode(retry)).toBe('SESSION_INVALID');
  });

  it('shows each person only the principals they belong to', async () => {
    const alice = wallet();
    const bob = wallet();
    const acme = await db.unscoped((tx) =>
      entryPoints.createPrincipal(tx, {
        name: 'Acme',
        projectName: 'Main',
        ownerWallet: alice.publicKey(),
      }),
    );
    const globex = await db.unscoped((tx) =>
      entryPoints.createPrincipal(tx, {
        name: 'Globex',
        projectName: 'Main',
        ownerWallet: bob.publicKey(),
      }),
    );
    const a = await signInWith(call, alice, { client: client() });
    const b = await signInWith(call, bob, { client: client() });
    expect(a.answer.json).toEqual({
      member: { id: acme.memberId, address: alice.publicKey() },
      principals: [{ id: acme.principalId, name: 'Acme', role: 'owner' }],
    });
    const meB = await call('GET', '/v1/me', { cookie: b.token ?? '' });
    expect(meB.json).toEqual({
      member: { id: globex.memberId, address: bob.publicKey() },
      principals: [{ id: globex.principalId, name: 'Globex', role: 'owner' }],
    });
    // Alice's session names no project of Bob's.
    const hashA = sessionTokenHash(a.token ?? '') ?? Buffer.alloc(32);
    expect((await store.resolveSession(hashA, globex.projectId))?.access).toBeNull();
    expect((await store.resolveSession(hashA, acme.projectId))?.access).toEqual({
      principalId: acme.principalId,
      projectId: acme.projectId,
      role: 'owner',
    });
  });

  it('rate limits challenges for one address in the database buckets', async () => {
    const kp = wallet();
    // Sent together, so the once a second refill cannot keep up however slow the runner.
    const answers = await Promise.all(
      Array.from({ length: SIGN_IN_LIMITS.challengePerAddress.capacity * 4 }, () =>
        call('POST', '/v1/auth/challenge', { body: { address: kp.publicKey() }, client: client() }),
      ),
    );
    const statuses = answers.map((a) => a.status);
    expect(statuses.filter((s) => s === 201).length).toBeGreaterThanOrEqual(
      SIGN_IN_LIMITS.challengePerAddress.capacity,
    );
    const limited = answers.filter((a) => a.status === 429);
    expect(limited.length).toBeGreaterThan(0);
    expect(limited[0]?.headers.get('retry-after')).toBe('1');
    expect(statuses.every((s) => s === 201 || s === 429)).toBe(true);
  });

  it('never logs the token or the address', () => {
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).not.toMatch(/G[A-Z2-7]{55}/);
      expect(line).not.toMatch(/[A-Za-z0-9_-]{43}/);
    }
  });
});
