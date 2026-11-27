// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// Embed sessions and settings against a real database, as the app and the
// worker reach them: what is stored, what the lookup finds, what the prune
// removes, and that no method reaches another tenant's rows. Two principals
// with two projects each; the matrix fails when a method is added without a
// case.

import { createHash, randomBytes, randomUUID } from 'node:crypto';

import type { Kysely } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import type { Database, ProjectContext } from '../database.js';
import type { Schema } from '../schema.js';
import { testAccount, testAccounts, testContract, testHex32 } from '../testing/accounts.js';
import { insertProject, insertTenant } from '../testing/admin-tenants.js';
import { caseProblems } from '../testing/cross-tenant.js';
import { databaseAsServiceRoles } from '../testing/databases.js';
import { createTestDatabase, type TestDatabase } from '../testing/harness.js';
import {
  embedRepositories,
  embedRetention,
  embedSessions,
  embedSettings,
  embedTokens,
} from './embed-sessions.js';
import { mandates } from './mandates.js';
import { recipients } from './recipients.js';
import { RepositoryInputError } from './values.js';

const adminUrl = inject('dbAdminUrl');
const roleUrls = inject('dbRoleUrls');

interface Rows {
  readonly context: ProjectContext;
  readonly recipientId: string;
  readonly sessionId: string;
  readonly hash: Buffer;
}

let database: TestDatabase;
let admin: pg.Client;
let db: Database;
let a: { first: Rows; second: Rows };
let b: { first: Rows; second: Rows };

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

const hash = (): Buffer => createHash('sha256').update(randomBytes(32)).digest();

async function recipientIn(context: ProjectContext): Promise<string> {
  return db.tenant(context).transaction(async (tx) => {
    const mandate = await mandates.create(
      tx,
      {
        name: 'Payroll',
        network: 'stellar:testnet',
        contractAddress: testContract(),
        asset: 'USDC',
        scale: 7,
        agent: { address: testAccount() },
        principalWallet: testAccount(),
      },
      testAccounts,
    );
    const recipient = await recipients.create(tx, {
      mandateId: mandate.id,
      label: `Ada ${randomUUID().slice(0, 8)}`,
      recipientRef: testHex32(),
    });
    return recipient.id;
  });
}

async function rows(context: ProjectContext): Promise<Rows> {
  const recipientId = await recipientIn(context);
  const tokenHash = hash();
  const session = await db
    .tenant(context)
    .transaction(async (tx) =>
      embedSessions.create(tx, { recipientId, tokenSha256: tokenHash, lifetimeSeconds: 1800 }),
    );
  return { context, recipientId, sessionId: session.id, hash: tokenHash };
}

async function world(name: string) {
  const first = await insertTenant(admin, name);
  const second = {
    principalId: first.principalId,
    projectId: await insertProject(admin, first.principalId, `${name} two`),
  };
  return { first: await rows(first), second: await rows(second) };
}

const asA = async <T>(work: (tx: Kysely<Schema>) => Promise<T>): Promise<T> =>
  db.tenant(a.first.context).transaction(work);
const foreign = (): readonly Rows[] => [b.first, b.second, a.second];

async function revokedAt(id: string): Promise<Date | null | undefined> {
  const result = await admin.query<{ revoked_at: Date | null }>(
    'select revoked_at from ujira.embed_sessions where id = $1',
    [id],
  );
  return result.rows[0]?.revoked_at;
}

beforeAll(async () => {
  database = await createTestDatabase(adminUrl, import.meta.url);
  admin = new pg.Client({ connectionString: database.url });
  await admin.connect();
  db = databaseAsServiceRoles(roleUrls, database);
  a = await world('alpha');
  b = await world('bravo');
});

afterAll(async () => {
  await db.close();
  await admin.end();
  await database.drop();
});

describe('embed sessions', () => {
  it('stores the hash only, with an expiry counted from the database clock', async () => {
    const recipientId = await recipientIn(a.first.context);
    const tokenHash = hash();
    const made = await asA(async (tx) =>
      embedSessions.create(tx, { recipientId, tokenSha256: tokenHash, lifetimeSeconds: 1800 }),
    );
    expect(made.expiresAt.getTime() - made.createdAt.getTime()).toBe(1_800_000);
    expect(made).toMatchObject({
      recipientId,
      revokedAt: null,
      projectId: a.first.context.projectId,
    });
    const stored = await admin.query<{ token_sha256: Buffer }>(
      'select token_sha256 from ujira.embed_sessions where id = $1',
      [made.id],
    );
    expect(stored.rows[0]?.token_sha256.equals(tokenHash)).toBe(true);
  });

  it('refuses a lifetime outside 5 minutes to 7 days, here and in the row check', async () => {
    const recipientId = a.first.recipientId;
    for (const lifetimeSeconds of [299, 604_801, 1.5]) {
      await expect(
        asA(async (tx) =>
          embedSessions.create(tx, { recipientId, tokenSha256: hash(), lifetimeSeconds }),
        ),
      ).rejects.toBeInstanceOf(RepositoryInputError);
    }
    const planted = admin.query(
      `insert into ujira.embed_sessions (principal_id, project_id, recipient_id, token_sha256, expires_at)
       values ($1, $2, $3, $4, now() + interval '8 days')`,
      [a.first.context.principalId, a.first.context.projectId, recipientId, hash()],
    );
    expect(await codeOf(planted)).toBe('23514');
  });

  it('refuses one token hash twice', async () => {
    const again = asA(async (tx) =>
      embedSessions.create(tx, {
        recipientId: a.first.recipientId,
        tokenSha256: a.first.hash,
        lifetimeSeconds: 1800,
      }),
    );
    expect(await codeOf(again)).toBe('23505');
  });

  it('lists newest first, by recipient, a page at a time', async () => {
    const context = await insertTenant(admin, 'Paging');
    const recipientId = await recipientIn(context);
    const other = await recipientIn(context);
    const made: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      made.push(
        (
          await db
            .tenant(context)
            .transaction(async (tx) =>
              embedSessions.create(tx, { recipientId, tokenSha256: hash(), lifetimeSeconds: 600 }),
            )
        ).id,
      );
    }
    await db
      .tenant(context)
      .transaction(async (tx) =>
        embedSessions.create(tx, { recipientId: other, tokenSha256: hash(), lifetimeSeconds: 600 }),
      );
    const first = await db
      .tenant(context)
      .transaction(async (tx) => embedSessions.list(tx, { recipientId, limit: 2 }));
    expect(first.items.map((s) => s.id)).toEqual([made[2], made[1]]);
    expect(first.next).not.toBeNull();
    const second = await db
      .tenant(context)
      .transaction(async (tx) =>
        embedSessions.list(tx, { recipientId, limit: 2, after: first.next ?? '' }),
      );
    expect(second.items.map((s) => s.id)).toEqual([made[0]]);
    expect(second.next).toBeNull();
    const all = await db
      .tenant(context)
      .transaction(async (tx) => embedSessions.list(tx, { limit: 100 }));
    expect(all.items).toHaveLength(4);
  });

  it('revokes once: a repeat keeps the first time', async () => {
    const own = await rows(a.first.context);
    const once = await asA(async (tx) => embedSessions.revoke(tx, own.sessionId));
    expect(once?.revokedAt).toBeInstanceOf(Date);
    const twice = await asA(async (tx) => embedSessions.revoke(tx, own.sessionId));
    expect(twice?.revokedAt).toEqual(once?.revokedAt);
    expect(await asA(async (tx) => embedSessions.revoke(tx, randomUUID()))).toBeUndefined();
  });
});

describe('the embed token lookup', () => {
  it('finds a live session by its hash, whatever the tenant, with its project origins', async () => {
    await asA(async (tx) => embedSettings.setAllowedOrigins(tx, ['https://shop.example.com']));
    const found = await db.unscoped(async (tx) => embedTokens.resolve(tx, a.first.hash));
    expect(found).toEqual({
      sessionId: a.first.sessionId,
      principalId: a.first.context.principalId,
      projectId: a.first.context.projectId,
      recipientId: a.first.recipientId,
      expiresAt: expect.any(Date) as Date,
      allowedOrigins: ['https://shop.example.com'],
    });
    const other = await db.unscoped(async (tx) => embedTokens.resolve(tx, b.first.hash));
    expect(other?.allowedOrigins).toEqual([]);
  });

  it('finds nothing for an unknown, a revoked or a lapsed session', async () => {
    expect(await db.unscoped(async (tx) => embedTokens.resolve(tx, hash()))).toBeUndefined();
    const revoked = await rows(a.first.context);
    await asA(async (tx) => embedSessions.revoke(tx, revoked.sessionId));
    expect(await db.unscoped(async (tx) => embedTokens.resolve(tx, revoked.hash))).toBeUndefined();
    const lapsed = await rows(a.first.context);
    await admin.query(
      `update ujira.embed_sessions
          set created_at = now() - interval '1 hour', expires_at = now() - interval '1 minute'
        where id = $1`,
      [lapsed.sessionId],
    );
    expect(await db.unscoped(async (tx) => embedTokens.resolve(tx, lapsed.hash))).toBeUndefined();
  });
});

describe('embed settings', () => {
  it('replaces the whole list, and holds only origins as a browser sends them', async () => {
    const context = await insertTenant(admin, 'Origins');
    const run = <T>(work: (tx: Kysely<Schema>) => Promise<T>) =>
      db.tenant(context).transaction(work);
    expect(await run((tx) => embedSettings.allowedOrigins(tx))).toEqual([]);
    expect(
      await run((tx) =>
        embedSettings.setAllowedOrigins(tx, ['https://a.example.com', 'http://localhost:5173']),
      ),
    ).toEqual(['https://a.example.com', 'http://localhost:5173']);
    expect(
      await run((tx) => embedSettings.setAllowedOrigins(tx, ['https://b.example.com:8443'])),
    ).toEqual(['https://b.example.com:8443']);
    expect(await run((tx) => embedSettings.allowedOrigins(tx))).toEqual([
      'https://b.example.com:8443',
    ]);
    for (const bad of [
      'http://a.example.com',
      'https://a.example.com/',
      'https://A.example.com',
      'a b',
    ]) {
      expect(await codeOf(run((tx) => embedSettings.setAllowedOrigins(tx, [bad]))), bad).toBe(
        '23514',
      );
    }
    const eleven = Array.from({ length: 11 }, (_, i) => `https://s${String(i)}.example.com`);
    await expect(run((tx) => embedSettings.setAllowedOrigins(tx, eleven))).rejects.toBeInstanceOf(
      RepositoryInputError,
    );
  });
});

describe('the embed session prune', () => {
  it('removes sessions a week past their end, and nothing newer, as the worker', async () => {
    const old = await rows(a.first.context);
    const recent = await rows(a.first.context);
    await admin.query(
      `update ujira.embed_sessions
          set created_at = now() - interval '9 days', expires_at = now() - interval '8 days'
        where id = $1`,
      [old.sessionId],
    );
    await admin.query(
      `update ujira.embed_sessions
          set created_at = now() - interval '3 days', expires_at = now() - interval '2 days'
        where id = $1`,
      [recent.sessionId],
    );
    let removed = 0;
    for (;;) {
      const batch = await db.unscoped(
        async (tx) => embedRetention.deleteExpired(tx, 100),
        'worker',
      );
      if (batch === 0) break;
      removed += batch;
    }
    expect(removed).toBeGreaterThanOrEqual(1);
    expect(await revokedAt(old.sessionId)).toBeUndefined();
    expect(await revokedAt(recent.sessionId)).toBeNull();
    expect(
      await codeOf(db.unscoped(async (tx) => embedRetention.deleteExpired(tx, 0), 'worker')),
    ).toBe('22023');
    // The app may not prune.
    expect(await codeOf(db.unscoped(async (tx) => embedRetention.deleteExpired(tx, 1)))).toBe(
      '42501',
    );
  });
});

const cases: Record<string, () => Promise<void>> = {
  'embedSessions.create': async () => {
    for (const other of foreign()) {
      const planted = asA(async (tx) =>
        embedSessions.create(tx, {
          recipientId: other.recipientId,
          tokenSha256: hash(),
          lifetimeSeconds: 600,
        }),
      );
      expect(await codeOf(planted)).toBe('23503');
    }
  },
  'embedSessions.get': async () => {
    for (const other of foreign()) {
      expect(await asA(async (tx) => embedSessions.get(tx, other.sessionId))).toBeUndefined();
    }
    expect(await asA(async (tx) => embedSessions.get(tx, a.first.sessionId))).toBeDefined();
  },
  'embedSessions.list': async () => {
    const own = await asA(async (tx) => embedSessions.list(tx, { limit: 100 }));
    const ids = new Set(own.items.map((s) => s.id));
    for (const other of foreign()) expect(ids.has(other.sessionId)).toBe(false);
    for (const other of foreign()) {
      const theirs = await asA(async (tx) =>
        embedSessions.list(tx, { recipientId: other.recipientId, limit: 100 }),
      );
      expect(theirs.items).toEqual([]);
    }
  },
  'embedSessions.revoke': async () => {
    for (const other of foreign()) {
      expect(await asA(async (tx) => embedSessions.revoke(tx, other.sessionId))).toBeUndefined();
      expect(await revokedAt(other.sessionId)).toBeNull();
    }
  },
  'embedSettings.allowedOrigins': async () => {
    await db
      .tenant(b.first.context)
      .transaction(async (tx) =>
        embedSettings.setAllowedOrigins(tx, ['https://bravo.example.com']),
      );
    expect(await asA(async (tx) => embedSettings.allowedOrigins(tx))).not.toContain(
      'https://bravo.example.com',
    );
  },
  'embedSettings.setAllowedOrigins': async () => {
    await asA(async (tx) => embedSettings.setAllowedOrigins(tx, ['https://alpha.example.com']));
    const theirs = await db
      .tenant(b.second.context)
      .transaction(async (tx) => embedSettings.allowedOrigins(tx));
    expect(theirs).not.toContain('https://alpha.example.com');
    const second = await db
      .tenant(a.second.context)
      .transaction(async (tx) => embedSettings.allowedOrigins(tx));
    expect(second).not.toContain('https://alpha.example.com');
  },
};

describe('across tenants', () => {
  it('has a case for every repository method, and no case without one', () => {
    expect(caseProblems(embedRepositories, Object.keys(cases))).toEqual([]);
  });

  it.each(Object.keys(cases))('%s cannot reach another tenant', async (name) => {
    const run = cases[name];
    if (run === undefined) throw new Error(`no case named ${name}`);
    await run();
  });
});
