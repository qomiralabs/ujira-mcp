// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// What the database itself holds about an API token, whatever the code above
// it does: one prefix across every tenant, only a hash of the secret, a
// revocation that sticks, the closed scope list, the required expiry and the
// rotation lineage.

import { createHash, randomUUID } from 'node:crypto';

import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import type { Database } from './database.js';
import { entryPoints, type CreatedPrincipal } from './repositories/entry-points.js';
import { apiTokens, projects, type NewApiToken } from './repositories/tenancy.js';
import { databaseAsServiceRoles } from './testing/databases.js';
import { createTestDatabase, type TestDatabase } from './testing/harness.js';

const adminUrl = inject('dbAdminUrl');
const roleUrls = inject('dbRoleUrls');

const EXPIRES_AT = new Date('2100-01-01T00:00:00Z');

const ALL_SCOPES = [
  'payouts:read',
  'payouts:write',
  'approvals:write',
  'recipients:read',
  'recipients:write',
  'mandates:read',
  'mandates:write',
  'receipts:read',
  'webhooks:manage',
  'corridors:read',
];

let database: TestDatabase;
let db: Database;
let alpha: CreatedPrincipal;
let bravo: CreatedPrincipal;

function prefix(): string {
  return `ujk_test_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

function newToken(overrides: Partial<NewApiToken> = {}): NewApiToken {
  return {
    prefix: prefix(),
    secretSha256: Buffer.alloc(32, 1),
    scopes: ['payouts:read'],
    expiresAt: EXPIRES_AT,
    ...overrides,
  };
}

async function principal(name: string): Promise<CreatedPrincipal> {
  return db.unscoped(async (tx) =>
    entryPoints.createPrincipal(tx, {
      name,
      projectName: name,
      ownerWallet: `G${randomUUID().replace(/-/g, '').toUpperCase()}`,
    }),
  );
}

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

beforeAll(async () => {
  database = await createTestDatabase(adminUrl, import.meta.url);
  db = databaseAsServiceRoles(roleUrls, database);
  alpha = await principal('alpha');
  bravo = await principal('bravo');
});

afterAll(async () => {
  await db.close();
  await database.drop();
});

describe('authenticating a token', () => {
  it('authenticate_token returns one row for its prefix only', async () => {
    const secret = createHash('sha256').update('alpha secret').digest();
    const alphaPrefix = prefix();
    const created = await db.tenant(alpha).transaction(async (tx) =>
      apiTokens.create(tx, {
        prefix: alphaPrefix,
        secretSha256: secret,
        scopes: ['payouts:write'],
        expiresAt: EXPIRES_AT,
      }),
    );
    const bravoPrefix = prefix();
    await db
      .tenant(bravo)
      .transaction(async (tx) =>
        apiTokens.create(tx, newToken({ prefix: bravoPrefix, secretSha256: Buffer.alloc(32, 2) })),
      );

    const found = await db.unscoped(async (tx) => entryPoints.authenticateToken(tx, alphaPrefix));
    expect(found).toEqual({
      tokenId: created.id,
      principalId: alpha.principalId,
      projectId: alpha.projectId,
      secretSha256: secret,
      scopes: ['payouts:write'],
      expiresAt: EXPIRES_AT,
      revokedAt: null,
    });
    expect(
      (await db.unscoped(async (tx) => entryPoints.authenticateToken(tx, bravoPrefix)))
        ?.principalId,
    ).toBe(bravo.principalId);
    expect(
      await db.unscoped(async (tx) => entryPoints.authenticateToken(tx, prefix())),
    ).toBeUndefined();
    // The function is the only way to the table without a context.
    expect(
      await codeOf(
        db.unscoped(async (tx) => sql`select count(*) from ujira.api_tokens`.execute(tx)),
      ),
    ).toBe('UJ001');
  });

  it('keeps every prefix unique across tenants', async () => {
    const input = newToken();
    await db.tenant(alpha).transaction(async (tx) => apiTokens.create(tx, input));
    expect(
      await codeOf(db.tenant(bravo).transaction(async (tx) => apiTokens.create(tx, input))),
    ).toBe('23505');
  });

  it('stores only a 32 byte hash of the secret', async () => {
    expect(
      await codeOf(
        db
          .tenant(alpha)
          .transaction(async (tx) =>
            apiTokens.create(tx, newToken({ secretSha256: Buffer.alloc(31, 3) })),
          ),
      ),
    ).toBe('23514');
  });

  it('keeps a revoked token revoked, and its prefix and secret as they were', async () => {
    const token = await db
      .tenant(alpha)
      .transaction(async (tx) => apiTokens.create(tx, newToken()));
    expect(await db.tenant(alpha).transaction(async (tx) => apiTokens.revoke(tx, token.id))).toBe(
      true,
    );
    // Already revoked: nothing left to revoke.
    expect(await db.tenant(alpha).transaction(async (tx) => apiTokens.revoke(tx, token.id))).toBe(
      false,
    );
    expect(
      await codeOf(
        db
          .tenant(alpha)
          .transaction(async (tx) =>
            sql`update ujira.api_tokens set revoked_at = null where id = ${token.id}`.execute(tx),
          ),
      ),
    ).toBe('UJ006');
    expect(
      await codeOf(
        db
          .tenant(alpha)
          .transaction(async (tx) =>
            sql`update ujira.api_tokens set prefix = ${prefix()} where id = ${token.id}`.execute(
              tx,
            ),
          ),
      ),
    ).toBe('UJ006');
    const page = await db
      .tenant(alpha)
      .transaction(async (tx) => apiTokens.list(tx, { limit: 100 }));
    expect(page.items.find((item) => item.id === token.id)?.revokedAt).toBeInstanceOf(Date);
  });
});

describe('scopes', () => {
  it('an unknown scope is refused', async () => {
    expect(
      await codeOf(
        db
          .tenant(alpha)
          .transaction(async (tx) =>
            apiTokens.create(tx, newToken({ scopes: ['payouts:read', 'payouts:admin'] })),
          ),
      ),
    ).toBe('23514');
  });

  it('accepts every listed scope, all ten on one token', async () => {
    const token = await db
      .tenant(alpha)
      .transaction(async (tx) => apiTokens.create(tx, newToken({ scopes: ALL_SCOPES })));
    expect(token.scopes).toEqual(ALL_SCOPES);
  });

  it('refuses a token with no scopes', async () => {
    expect(
      await codeOf(
        db.tenant(alpha).transaction(async (tx) => apiTokens.create(tx, newToken({ scopes: [] }))),
      ),
    ).toBe('23514');
  });

  it('refuses more than ten scopes, even repeats of listed ones', async () => {
    expect(
      await codeOf(
        db
          .tenant(alpha)
          .transaction(async (tx) =>
            apiTokens.create(tx, newToken({ scopes: [...ALL_SCOPES, 'payouts:read'] })),
          ),
      ),
    ).toBe('23514');
  });

  it('has no default, so a write that names no scopes fails rather than storing none', async () => {
    expect(
      await codeOf(
        db.tenant(alpha).transaction(async (tx) =>
          sql`
            insert into ujira.api_tokens (principal_id, project_id, prefix, secret_sha256, expires_at)
            values (
              ujira.current_principal_id(),
              ujira.current_project_id(),
              ${prefix()},
              ${Buffer.alloc(32, 1)},
              ${EXPIRES_AT}
            )
          `.execute(tx),
        ),
      ),
    ).toBe('23502');
  });
});

describe('expiry', () => {
  it('null expires_at is refused', async () => {
    expect(
      await codeOf(
        db.tenant(alpha).transaction(async (tx) =>
          sql`
            insert into ujira.api_tokens (principal_id, project_id, prefix, secret_sha256, scopes, expires_at)
            values (
              ujira.current_principal_id(),
              ujira.current_project_id(),
              ${prefix()},
              ${Buffer.alloc(32, 1)},
              ${['payouts:read']},
              null
            )
          `.execute(tx),
        ),
      ),
    ).toBe('23502');
  });

  it('an existing token cannot have its expiry taken away', async () => {
    const token = await db
      .tenant(alpha)
      .transaction(async (tx) => apiTokens.create(tx, newToken()));
    expect(
      await codeOf(
        db
          .tenant(alpha)
          .transaction(async (tx) =>
            sql`update ujira.api_tokens set expires_at = null where id = ${token.id}`.execute(tx),
          ),
      ),
    ).toBe('23502');
  });

  it('reads back the expiry it was given, and only ever shortens it', async () => {
    const token = await db
      .tenant(alpha)
      .transaction(async (tx) => apiTokens.create(tx, newToken()));
    expect(token.expiresAt).toEqual(EXPIRES_AT);
    const sooner = new Date('2099-01-01T00:00:00Z');
    expect(
      await db
        .tenant(alpha)
        .transaction(async (tx) => apiTokens.shortenExpiry(tx, token.id, sooner)),
    ).toEqual(sooner);
    expect(
      await db
        .tenant(alpha)
        .transaction(async (tx) => apiTokens.shortenExpiry(tx, token.id, EXPIRES_AT)),
    ).toEqual(sooner);
  });
});

describe('prefix and name', () => {
  it('still holds the format the API issues', async () => {
    const token = await db
      .tenant(alpha)
      .transaction(async (tx) =>
        apiTokens.create(tx, newToken({ prefix: 'ujk_live_abcdefghijklmnop' })),
      );
    expect(token.prefix).toBe('ujk_live_abcdefghijklmnop');
    expect(
      await codeOf(
        db
          .tenant(alpha)
          .transaction(async (tx) => apiTokens.create(tx, newToken({ prefix: 'has space here' }))),
      ),
    ).toBe('23514');
  });

  it('keeps a name of 1 to 100 characters, or none', async () => {
    const named = await db
      .tenant(alpha)
      .transaction(async (tx) => apiTokens.create(tx, newToken({ name: 'payroll runner' })));
    expect(named.name).toBe('payroll runner');
    const unnamed = await db
      .tenant(alpha)
      .transaction(async (tx) => apiTokens.create(tx, newToken()));
    expect(unnamed.name).toBeNull();
    for (const name of ['', 'x'.repeat(101)]) {
      expect(
        await codeOf(
          db.tenant(alpha).transaction(async (tx) => apiTokens.create(tx, newToken({ name }))),
        ),
      ).toBe('23514');
    }
  });
});

describe('last used', () => {
  it('writes once, then not again for five minutes', async () => {
    const token = await db
      .tenant(alpha)
      .transaction(async (tx) => apiTokens.create(tx, newToken()));
    expect(token.lastUsedAt).toBeNull();
    const touch = async (): Promise<boolean> =>
      db.tenant(alpha).transaction(async (tx) => apiTokens.touchLastUsed(tx, token.id));
    expect(await touch()).toBe(true);
    expect(await touch()).toBe(false);
    const stamped = await db.tenant(alpha).transaction(async (tx) => apiTokens.get(tx, token.id));
    expect(stamped?.lastUsedAt).toBeInstanceOf(Date);

    // Six minutes on, as far as the row can tell.
    await db.tenant(alpha).transaction(async (tx) =>
      sql`
        update ujira.api_tokens set last_used_at = now() - interval '6 minutes'
         where id = ${token.id}
      `.execute(tx),
    );
    expect(await touch()).toBe(true);
  });

  it('can still be written on a token that has been revoked', async () => {
    const token = await db
      .tenant(alpha)
      .transaction(async (tx) => apiTokens.create(tx, newToken()));
    await db.tenant(alpha).transaction(async (tx) => apiTokens.revoke(tx, token.id));
    expect(
      await db.tenant(alpha).transaction(async (tx) => apiTokens.touchLastUsed(tx, token.id)),
    ).toBe(true);
  });
});

describe('rotation lineage', () => {
  it('records which token a rotated one came from', async () => {
    const first = await db
      .tenant(alpha)
      .transaction(async (tx) => apiTokens.create(tx, newToken()));
    expect(first.rotatedFromId).toBeNull();
    const second = await db
      .tenant(alpha)
      .transaction(async (tx) => apiTokens.create(tx, newToken({ rotatedFromId: first.id })));
    expect(second.rotatedFromId).toBe(first.id);
    expect(
      (await db.tenant(alpha).transaction(async (tx) => apiTokens.successorOf(tx, first.id)))?.id,
    ).toBe(second.id);
  });

  it('gives a token one successor only, however many rotations race', async () => {
    const parent = await db
      .tenant(alpha)
      .transaction(async (tx) => apiTokens.create(tx, newToken()));
    const results = await Promise.all(
      Array.from({ length: 4 }, async () =>
        db
          .tenant(alpha)
          .transaction(async (tx) =>
            apiTokens.createSuccessor(tx, { ...newToken(), rotatedFromId: parent.id }),
          ),
      ),
    );
    expect(results.filter((result) => result !== undefined)).toHaveLength(1);
  });

  it('refuses a parent that does not exist', async () => {
    expect(
      await codeOf(
        db
          .tenant(alpha)
          .transaction(async (tx) =>
            apiTokens.create(tx, newToken({ rotatedFromId: randomUUID() })),
          ),
      ),
    ).toBe('23503');
  });

  it('refuses a parent in another tenant', async () => {
    const other = await db
      .tenant(bravo)
      .transaction(async (tx) => apiTokens.create(tx, newToken()));
    expect(
      await codeOf(
        db
          .tenant(alpha)
          .transaction(async (tx) => apiTokens.create(tx, newToken({ rotatedFromId: other.id }))),
      ),
    ).toBe('23503');
  });

  it('refuses a parent in another project of the same principal', async () => {
    const secondProject = await db
      .tenant(alpha)
      .transaction(async (tx) => projects.create(tx, { name: 'second' }));
    const parent = await db
      .tenant({ principalId: alpha.principalId, projectId: secondProject })
      .transaction(async (tx) => apiTokens.create(tx, newToken()));
    expect(
      await codeOf(
        db
          .tenant(alpha)
          .transaction(async (tx) => apiTokens.create(tx, newToken({ rotatedFromId: parent.id }))),
      ),
    ).toBe('23503');
  });
});

describe('the active key limit', () => {
  it('refuses a key past the limit', async () => {
    const project = await db
      .tenant(alpha)
      .transaction(async (tx) => projects.create(tx, { name: 'limited' }));
    const context = { principalId: alpha.principalId, projectId: project };
    const within = async (): Promise<string | undefined> =>
      (
        await db
          .tenant(context)
          .transaction(async (tx) => apiTokens.createWithinLimit(tx, newToken(), 2))
      )?.id;
    const first = await within();
    if (first === undefined) throw new Error('expected the first key within the limit');
    expect(await within()).toBeDefined();
    expect(await within()).toBeUndefined();
    // A revoked key frees its place.
    await db.tenant(context).transaction(async (tx) => apiTokens.revoke(tx, first));
    expect(await within()).toBeDefined();
    expect(await within()).toBeUndefined();
  });

  it('counts a key in its rotation overlap once, by its successor', async () => {
    const project = await db
      .tenant(alpha)
      .transaction(async (tx) => projects.create(tx, { name: 'rotating' }));
    const context = { principalId: alpha.principalId, projectId: project };
    const old = await db
      .tenant(context)
      .transaction(async (tx) => apiTokens.createWithinLimit(tx, newToken(), 1));
    if (old === undefined) throw new Error('expected a key within the limit');
    const successor = await db
      .tenant(context)
      .transaction(async (tx) =>
        apiTokens.createSuccessor(tx, { ...newToken(), rotatedFromId: old.id }),
      );
    expect(successor?.rotatedFromId).toBe(old.id);
    expect(
      await db
        .tenant(context)
        .transaction(async (tx) => apiTokens.createWithinLimit(tx, newToken(), 1)),
    ).toBeUndefined();
  });
});
