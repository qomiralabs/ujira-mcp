// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// Wallet sign in and sessions against a real database, as the app and the
// worker log in: a challenge is spent once, a session is found only by the
// hash of its secret, and the project a request names resolves only for a
// person who is an active member of the principal that owns it.

import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { sql } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import type { Database } from './database.js';
import { entryPoints, type CreatedPrincipal } from './repositories/entry-points.js';
import { authChallenges, authRetention, sessions } from './repositories/sessions.js';
import { members, projects } from './repositories/tenancy.js';
import { databaseAsServiceRoles } from './testing/databases.js';
import { createTestDatabase, type TestDatabase } from './testing/harness.js';

const adminUrl = inject('dbAdminUrl');
const roleUrls = inject('dbRoleUrls');

const IDLE_SECONDS = 30 * 24 * 60 * 60;
const ABSOLUTE_SECONDS = 90 * 24 * 60 * 60;

let database: TestDatabase;
let db: Database;
let admin: pg.Client;

beforeAll(async () => {
  database = await createTestDatabase(adminUrl, import.meta.url);
  db = databaseAsServiceRoles(roleUrls, database);
  admin = new pg.Client({ connectionString: database.url });
  await admin.connect();
});

afterAll(async () => {
  await admin.end();
  await db.close();
  await database.drop();
});

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

function wallet(): string {
  return `G${randomUUID().replace(/-/g, '').toUpperCase()}`;
}

function newSecret(): Buffer {
  return createHash('sha256').update(randomBytes(32)).digest();
}

async function principalOwnedBy(owner: string, name = 'Acme'): Promise<CreatedPrincipal> {
  return db.unscoped(async (tx) =>
    entryPoints.createPrincipal(tx, { name, projectName: 'Main', ownerWallet: owner }),
  );
}

async function signIn(address: string): Promise<{ secret: Buffer; memberId: string }> {
  const secret = newSecret();
  const created = await db.unscoped(async (tx) =>
    sessions.create(tx, {
      tokenSha256: secret,
      walletAddress: address,
      idleSeconds: IDLE_SECONDS,
      absoluteSeconds: ABSOLUTE_SECONDS,
    }),
  );
  return { secret, memberId: created.memberId };
}

async function resolve(secret: Buffer, projectId: string | null = null) {
  return db.unscoped(async (tx) => sessions.resolve(tx, secret, projectId));
}

describe('challenges', () => {
  it('is spent once, by the wallet it was issued to', async () => {
    const address = wallet();
    const message = `ujira.co wants you to sign in with ${address}`;
    const issued = await db.unscoped(async (tx) =>
      authChallenges.create(tx, { walletAddress: address, message, ttlSeconds: 600 }),
    );
    const lifetime = issued.expiresAt.getTime() - Date.now();
    expect(lifetime).toBeGreaterThan(9 * 60 * 1000);
    // The database clock sets it, so allow for the two clocks differing a little.
    expect(lifetime).toBeLessThanOrEqual(10 * 60 * 1000 + 5000);
    const consume = async (by: string) =>
      db.unscoped(async (tx) => authChallenges.consume(tx, issued.challengeId, by));
    // Another wallet learns nothing and spends nothing.
    expect(await consume(wallet())).toBeUndefined();
    expect(await consume(address)).toBe(message);
    expect(await consume(address)).toBeUndefined();
    expect(
      await db.unscoped(async (tx) => authChallenges.consume(tx, randomUUID(), address)),
    ).toBeUndefined();
  });

  it('cannot be spent once it has lapsed', async () => {
    const address = wallet();
    const issued = await db.unscoped(async (tx) =>
      authChallenges.create(tx, { walletAddress: address, message: 'sign me', ttlSeconds: 60 }),
    );
    await admin.query(
      `update ujira.auth_challenges
          set created_at = now() - interval '2 minutes', expires_at = now() - interval '1 minute'
        where id = $1`,
      [issued.challengeId],
    );
    expect(
      await db.unscoped(async (tx) => authChallenges.consume(tx, issued.challengeId, address)),
    ).toBeUndefined();
  });

  it('lasts from one second to ten minutes and no longer', async () => {
    for (const ttlSeconds of [0, 601]) {
      expect(
        await codeOf(
          db.unscoped(async (tx) =>
            authChallenges.create(tx, { walletAddress: wallet(), message: 'm', ttlSeconds }),
          ),
        ),
      ).toBe('22023');
    }
    expect(
      await codeOf(
        db.unscoped(async (tx) =>
          authChallenges.create(tx, {
            walletAddress: 'not a wallet',
            message: 'm',
            ttlSeconds: 60,
          }),
        ),
      ),
    ).toBe('23514');
  });
});

describe('sessions', () => {
  it('belong to the same member a principal already knows the wallet by', async () => {
    const address = wallet();
    const owned = await principalOwnedBy(address);
    const { secret, memberId } = await signIn(address);
    expect(memberId).toBe(owned.memberId);
    const resolved = await resolve(secret);
    expect(resolved).toMatchObject({ memberId, walletAddress: address, access: null });
    const stored = await admin.query<{ token_sha256: Buffer }>(
      'select token_sha256 from ujira.sessions where id = $1',
      [resolved?.sessionId],
    );
    expect(stored.rows).toEqual([{ token_sha256: secret }]);
  });

  it('make a member of a wallet that belongs to no principal yet', async () => {
    const { secret, memberId } = await signIn(wallet());
    expect((await resolve(secret))?.memberId).toBe(memberId);
    expect(await db.unscoped(async (tx) => sessions.principals(tx, secret))).toEqual([]);
    expect(await db.unscoped(async (tx) => sessions.projects(tx, secret))).toEqual([]);
  });

  it('resolve a project only for an active member of the principal that owns it', async () => {
    const address = wallet();
    const mine = await principalOwnedBy(address);
    const theirs = await principalOwnedBy(wallet());
    const { secret } = await signIn(address);
    expect((await resolve(secret, mine.projectId))?.access).toEqual({
      principalId: mine.principalId,
      projectId: mine.projectId,
      role: 'owner',
    });
    expect((await resolve(secret, theirs.projectId))?.access).toBeNull();
    expect((await resolve(secret, randomUUID()))?.access).toBeNull();

    // Added to the other principal, the project resolves, with the role given
    // there; removed again, it stops on the next request.
    const added = await db
      .tenant(theirs)
      .transaction(async (tx) => members.add(tx, { walletAddress: address, role: 'viewer' }));
    expect((await resolve(secret, theirs.projectId))?.access).toEqual({
      principalId: theirs.principalId,
      projectId: theirs.projectId,
      role: 'viewer',
    });
    await db
      .tenant(theirs)
      .transaction(async (tx) => members.setStatus(tx, added.memberId, 'removed'));
    expect((await resolve(secret, theirs.projectId))?.access).toBeNull();
    expect((await resolve(secret, mine.projectId))?.access?.role).toBe('owner');
  });

  it('list the principals and projects the person may act for, and nobody else', async () => {
    const address = wallet();
    const first = await principalOwnedBy(address, 'First');
    const second = await principalOwnedBy(address, 'Second');
    const stranger = await principalOwnedBy(wallet(), 'Stranger');
    const extra = await db
      .tenant(second)
      .transaction(async (tx) => projects.create(tx, { name: 'Payroll' }));
    const { secret } = await signIn(address);

    expect(await db.unscoped(async (tx) => sessions.principals(tx, secret))).toEqual([
      { principalId: first.principalId, name: 'First', role: 'owner' },
      { principalId: second.principalId, name: 'Second', role: 'owner' },
    ]);
    const listed = await db.unscoped(async (tx) => sessions.projects(tx, secret));
    expect(listed.map((project) => project.projectId).sort()).toEqual(
      [first.projectId, second.projectId, extra].sort(),
    );
    expect(listed.map((project) => project.principalId)).not.toContain(stranger.principalId);
    expect(listed.find((project) => project.projectId === extra)).toMatchObject({
      principalId: second.principalId,
      name: 'Payroll',
    });
  });

  it('extend the idle window up to the absolute expiry, and never bring a lapsed session back', async () => {
    const { secret } = await signIn(wallet());
    const before = await resolve(secret);
    const extended = await db.unscoped(async (tx) =>
      sessions.touch(tx, secret, ABSOLUTE_SECONDS * 2),
    );
    expect(extended).toEqual(before?.absoluteExpiresAt);
    await admin.query(
      `update ujira.sessions set idle_expires_at = now() - interval '1 second' where token_sha256 = $1`,
      [secret],
    );
    expect(await resolve(secret)).toBeUndefined();
    expect(await db.unscoped(async (tx) => sessions.touch(tx, secret, 60))).toBeUndefined();
    expect(await db.unscoped(async (tx) => sessions.principals(tx, secret))).toEqual([]);
  });

  it('end when revoked, once', async () => {
    const address = wallet();
    await principalOwnedBy(address);
    const { secret } = await signIn(address);
    expect(await db.unscoped(async (tx) => sessions.revoke(tx, secret, 'signed_out'))).toBe(true);
    expect(await db.unscoped(async (tx) => sessions.revoke(tx, secret, 'signed_out'))).toBe(false);
    expect(await resolve(secret)).toBeUndefined();
    expect(await db.unscoped(async (tx) => sessions.projects(tx, secret))).toEqual([]);
    expect(
      await codeOf(db.unscoped(async (tx) => sessions.revoke(tx, newSecret(), 'Not A Code'))),
    ).toBeUndefined();
    const { secret: other } = await signIn(address);
    expect(await codeOf(db.unscoped(async (tx) => sessions.revoke(tx, other, 'Not A Code')))).toBe(
      '23514',
    );
  });

  it('refuse a lifetime under a second and a secret hash that is not 32 bytes', async () => {
    const attempt = (secret: Buffer, idleSeconds: number) =>
      codeOf(
        db.unscoped(async (tx) =>
          sessions.create(tx, {
            tokenSha256: secret,
            walletAddress: wallet(),
            idleSeconds,
            absoluteSeconds: ABSOLUTE_SECONDS,
          }),
        ),
      );
    expect(await attempt(newSecret(), 0)).toBe('22023');
    expect(await attempt(Buffer.alloc(31, 1), IDLE_SECONDS)).toBe('23514');
  });
});

describe('who reaches the tables', () => {
  it('is no service role: the app reaches them only through the functions', async () => {
    for (const table of ['ujira.sessions', 'ujira.auth_challenges', 'ujira.members']) {
      expect(
        await codeOf(
          db.unscoped(async (tx) => sql.raw(`select count(*) from ${table}`).execute(tx)),
        ),
        table,
      ).toBe('42501');
    }
  });

  it('lets the worker prune lapsed challenges and old sessions, and not the app', async () => {
    const address = wallet();
    await db.unscoped(async (tx) =>
      authChallenges.create(tx, { walletAddress: address, message: 'old', ttlSeconds: 60 }),
    );
    await admin.query(
      `update ujira.auth_challenges
          set created_at = now() - interval '1 day', expires_at = now() - interval '1 day' + interval '1 minute'
        where wallet_address = $1`,
      [address],
    );
    const { secret } = await signIn(address);
    await admin.query(
      `update ujira.sessions
          set created_at = now() - interval '100 days',
              idle_expires_at = now() - interval '40 days',
              absolute_expires_at = now() - interval '31 days'
        where token_sha256 = $1`,
      [secret],
    );
    const { secret: live } = await signIn(address);

    expect(
      await codeOf(db.unscoped(async (tx) => authRetention.deleteExpiredSessions(tx, 100))),
    ).toBe('42501');
    let challenges = 0;
    for (;;) {
      const removed = await db.unscoped(
        async (tx) => authRetention.deleteExpiredChallenges(tx, 100),
        'worker',
      );
      if (removed === 0) break;
      challenges += removed;
    }
    expect(challenges).toBeGreaterThanOrEqual(1);
    let pruned = 0;
    for (;;) {
      const removed = await db.unscoped(
        async (tx) => authRetention.deleteExpiredSessions(tx, 100),
        'worker',
      );
      if (removed === 0) break;
      pruned += removed;
    }
    expect(pruned).toBeGreaterThanOrEqual(1);
    const left = await admin.query<{ token_sha256: Buffer }>(
      'select token_sha256 from ujira.sessions where token_sha256 = any($1::bytea[])',
      [[secret, live]],
    );
    expect(left.rows).toEqual([{ token_sha256: live }]);
    expect(
      await codeOf(
        db.unscoped(async (tx) => authRetention.deleteExpiredChallenges(tx, 0), 'worker'),
      ),
    ).toBe('22023');
  });
});
