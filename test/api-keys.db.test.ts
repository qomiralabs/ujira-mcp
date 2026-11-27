// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The API key routes and key authentication against a real database, logged
// in as the app is in production: the row holds a prefix and a hash, never
// the key; creating and revoking write the audit chain; a key works in its
// own project, with its own scopes, until it is revoked or expires; and no
// person can see or revoke another principal's keys.

import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { createV1App } from '../src/api/app.js';
import { createAuthenticate } from '../src/api/authenticate.js';
import { apiKeyRoutes } from '../src/api/routes/api-keys.js';
import { authRoutes } from '../src/api/routes/auth.js';
import { createApiKeyService } from '../src/auth/api-key-service.js';
import { databaseApiKeyRecords, databaseTokenStore } from '../src/auth/api-key-store.js';
import { postgresSignInStore } from '../src/auth/postgres-store.js';
import { SignIn } from '../src/auth/sign-in.js';
import { createTokenAuthenticator } from '../src/auth/token-auth.js';
import { hashSecret, issueToken, parseToken } from '../src/auth/token.js';
import {
  apiTokens,
  audit,
  entryPoints,
  members,
  type Database,
  type ProjectContext,
} from '../src/db/index.js';
import {
  createTestDatabase,
  databaseAsServiceRoles,
  type TestDatabase,
} from '../src/db/testing/index.js';
import { codeOf, probeRoutes, requestFor, type Request } from './api-key-helpers.js';
import { clientFor, ORIGIN, signInWith, verifier, wallet, type Call } from './sign-in-helpers.js';

const adminUrl = inject('dbAdminUrl');
const roleUrls = inject('dbRoleUrls');

let database: TestDatabase;
let db: Database;
let request: Request;
let call: Call;
const lines: string[] = [];

beforeAll(async () => {
  database = await createTestDatabase(adminUrl, import.meta.url);
  db = databaseAsServiceRoles(roleUrls, database);
  const log = (line: string) => {
    lines.push(line);
  };
  const signIn = new SignIn({ store: postgresSignInStore(db), verifier, origin: ORIGIN, log });
  const tokens = createTokenAuthenticator({
    store: databaseTokenStore(db),
    environment: 'test',
    log,
  });
  const keys = createApiKeyService({
    records: databaseApiKeyRecords(db),
    environment: 'test',
    onRevoked: (prefix) => {
      tokens.forget(prefix);
    },
  });
  const authenticate = createAuthenticate({ tokens, session: { signIn, origin: ORIGIN } });
  const app = createV1App({
    routes: [
      ...authRoutes({ signIn, origin: ORIGIN }),
      ...apiKeyRoutes({ keys, authenticate }),
      ...probeRoutes(authenticate),
    ],
    log,
  }).app;
  request = requestFor(app);
  call = clientFor(app);
});

afterAll(async () => {
  await db.close();
  await database.drop();
});

interface Person extends ProjectContext {
  readonly memberId: string;
  readonly cookie: string;
}

async function signedIn(kp: ReturnType<typeof wallet>, tenant: ProjectContext): Promise<Person> {
  const { token, answer } = await signInWith(call, kp, { client: `client-${randomUUID()}` });
  if (token === undefined) throw new Error('sign in failed');
  const member = answer.json?.['member'] as { id: string };
  return { ...tenant, memberId: member.id, cookie: token };
}

/** A new principal with its first project, and its owner signed in. */
async function owner(): Promise<Person> {
  const kp = wallet();
  const made = await db.unscoped((tx) =>
    entryPoints.createPrincipal(tx, {
      name: 'Acme',
      projectName: 'Main',
      ownerWallet: kp.publicKey(),
    }),
  );
  return signedIn(kp, { principalId: made.principalId, projectId: made.projectId });
}

async function joined(tenant: ProjectContext, role: 'admin' | 'developer' | 'viewer') {
  const kp = wallet();
  await db
    .tenant(tenant)
    .transaction((tx) => members.add(tx, { walletAddress: kp.publicKey(), role }));
  return signedIn(kp, tenant);
}

async function createKey(
  person: Person,
  scopes: readonly string[],
): Promise<{ secret: string; id: string }> {
  const created = await request('POST', '/v1/api-keys', {
    cookie: person.cookie,
    project: person.projectId,
    body: { name: 'Payroll runner', scopes },
  });
  expect(created.status).toBe(201);
  const apiKey = created.json?.['apiKey'] as { id: string };
  return { secret: String(created.json?.['secret']), id: apiKey.id };
}

function tenantOf(person: Person): ProjectContext {
  return { principalId: person.principalId, projectId: person.projectId };
}

describe('API keys on Postgres', () => {
  it('stores a prefix and the hash of the secret, never the key, and audits the creation', async () => {
    const alice = await owner();
    const { secret, id } = await createKey(alice, ['payouts:read']);
    const parsed = parseToken(secret);
    if (parsed === null) throw new Error('not a key');

    const row = await db.tenant(tenantOf(alice)).transaction((tx) => apiTokens.get(tx, id));
    expect(row).toMatchObject({ projectId: alice.projectId, prefix: parsed.prefix });
    expect(row?.scopes).toEqual(['payouts:read']);
    const found = await db.unscoped((tx) => entryPoints.authenticateToken(tx, parsed.prefix));
    expect(found?.secretSha256).toEqual(hashSecret(parsed.secret));
    expect(JSON.stringify(row)).not.toContain(parsed.secret);

    const entries = await db
      .tenant(tenantOf(alice))
      .transaction((tx) => audit.list(tx, { limit: 50 }));
    expect(entries.items.filter((e) => e.action.startsWith('api_key.'))).toEqual([
      expect.objectContaining({
        action: 'api_key.created',
        actorKind: 'member',
        actorId: alice.memberId,
        metadata: { target_type: 'api_key', target_id: id },
      }),
    ]);
  });

  it('runs a key as its own tenant, records its use, and stops it when revoked', async () => {
    const alice = await owner();
    const { secret, id } = await createKey(alice, ['payouts:read']);
    const probe = await request('GET', '/v1/probe', { key: secret });
    expect(probe.status).toBe(200);
    expect(probe.json).toEqual({ kind: 'key', ...tenantOf(alice) });
    const used = await db.tenant(tenantOf(alice)).transaction((tx) => apiTokens.get(tx, id));
    expect(used?.lastUsedAt).toBeInstanceOf(Date);

    const revoked = await request('DELETE', `/v1/api-keys/${id}`, {
      cookie: alice.cookie,
      project: alice.projectId,
    });
    expect(revoked.status).toBe(200);
    const after = await request('GET', '/v1/probe', { key: secret });
    expect(after.status).toBe(401);
    expect(codeOf(after)).toBe('TOKEN_INVALID');

    const entries = await db
      .tenant(tenantOf(alice))
      .transaction((tx) => audit.list(tx, { limit: 50 }));
    // create_principal writes the principal's own first row.
    expect(entries.items.map((e) => e.action)).toEqual([
      'principal.created',
      'api_key.created',
      'api_key.revoked',
    ]);
    expect(entries.items[2]).toMatchObject({ action: 'api_key.revoked', actorId: alice.memberId });
  });

  it('answers FORBIDDEN to a key without the scope, and to developers managing keys', async () => {
    const alice = await owner();
    const { secret } = await createKey(alice, ['payouts:read']);
    const write = await request('POST', '/v1/probe', {
      key: secret,
      body: { n: 1 },
      headers: { 'idempotency-key': 'run-1' },
    });
    expect(write.status).toBe(403);
    expect(codeOf(write)).toBe('FORBIDDEN');

    const developer = await joined(tenantOf(alice), 'developer');
    const refused = await request('POST', '/v1/api-keys', {
      cookie: developer.cookie,
      project: developer.projectId,
      body: { name: 'mine', scopes: ['payouts:write'] },
    });
    expect(refused.status).toBe(403);
    expect(codeOf(refused)).toBe('FORBIDDEN');
    const admin = await joined(tenantOf(alice), 'admin');
    await createKey(admin, ['payouts:write']);
  });

  it('refuses an expired key and a live key, and records both without losing a record', async () => {
    const alice = await owner();
    const issued = issueToken('test');
    await db.tenant(tenantOf(alice)).transaction((tx) =>
      apiTokens.create(tx, {
        name: 'old',
        prefix: issued.prefix,
        secretSha256: issued.secretSha256,
        scopes: ['payouts:read'],
        expiresAt: new Date(Date.now() - 1000),
      }),
    );
    const expired = await request('GET', '/v1/probe', { key: issued.token });
    expect(codeOf(expired)).toBe('TOKEN_INVALID');
    const live = await request('GET', '/v1/probe', { key: issueToken('live').token });
    expect(codeOf(live)).toBe('TOKEN_ENVIRONMENT_MISMATCH');
    expect(lines.some((line) => line.startsWith('event=security_event_failed'))).toBe(false);
  });

  it("never shows or revokes another principal's keys", async () => {
    const alice = await owner();
    const bob = await owner();
    const alicesKey = await createKey(alice, ['payouts:read']);
    await createKey(bob, ['payouts:read']);

    const reach = await request('GET', '/v1/api-keys', {
      cookie: bob.cookie,
      project: alice.projectId,
    });
    expect(reach.status).toBe(404);
    const own = await request('GET', '/v1/api-keys', {
      cookie: bob.cookie,
      project: bob.projectId,
    });
    const items = own.json?.['items'] as { id: string; principalId: string }[];
    expect(items).toHaveLength(1);
    expect(items.every((k) => k.principalId === bob.principalId)).toBe(true);

    const revoke = await request('DELETE', `/v1/api-keys/${alicesKey.id}`, {
      cookie: bob.cookie,
      project: bob.projectId,
    });
    expect(revoke.status).toBe(404);
    expect((await request('GET', '/v1/probe', { key: alicesKey.secret })).status).toBe(200);
    // Bob's tenant cannot read Alice's row at all.
    expect(
      await db.tenant(tenantOf(bob)).transaction((tx) => apiTokens.get(tx, alicesKey.id)),
    ).toBeUndefined();
  });

  it('never logs a key, its prefix or its secret', () => {
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(line).not.toMatch(/ujk_/);
  });
});
