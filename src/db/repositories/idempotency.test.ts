// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The records behind the Idempotency-Key header, against a real database as the
// role the API runs as. The races are real ones, on two pools.

import { createHash, randomUUID } from 'node:crypto';

import { sql } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import type { Database, ProjectContext } from '../database.js';
import { insertProject, insertTenant } from '../testing/admin-tenants.js';
import { databaseAsServiceRoles } from '../testing/databases.js';
import { createTestDatabase, type TestDatabase } from '../testing/harness.js';
import { idempotencyKeys, type Reservation } from './idempotency.js';

const adminUrl = inject('dbAdminUrl');
const roleUrls = inject('dbRoleUrls');

let database: TestDatabase;
let admin: pg.Client;
let db: Database;
let other: Database;
let alpha: ProjectContext;
let bravo: ProjectContext;

const hash = (text: string): Buffer => createHash('sha256').update(text).digest();
const REQUEST = hash('POST /v1/things {"name":"Ada"}');

async function reserve(
  key: string,
  options: {
    tenant?: ProjectContext;
    request?: Buffer;
    on?: Database;
    leaseSeconds?: number;
  } = {},
): Promise<Reservation> {
  return (options.on ?? db).tenant(options.tenant ?? alpha).transaction(async (tx) =>
    idempotencyKeys.reserve(tx, {
      key,
      requestSha256: options.request ?? REQUEST,
      leaseSeconds: options.leaseSeconds ?? 60,
    }),
  );
}

function leaseOf(reservation: Reservation): string {
  if (reservation.kind !== 'started') throw new Error(`expected a lease, got ${reservation.kind}`);
  return reservation.leaseId;
}

async function finish(key: string, leaseId: string, status = 201, body = '{"id":"x"}') {
  return db
    .tenant(alpha)
    .transaction(async (tx) =>
      idempotencyKeys.complete(tx, { key, leaseId, status, requestId: 'req_original', body }),
    );
}

async function age(key: string, change: 'lease' | 'window'): Promise<void> {
  await db.tenant(alpha).transaction(async (tx) =>
    change === 'lease'
      ? sql`
          update ujira.idempotency_keys set lease_expires_at = now() - interval '1 second'
           where idempotency_key = ${key}
        `.execute(tx)
      : sql`
          update ujira.idempotency_keys set expires_at = now() - interval '1 second'
           where idempotency_key = ${key}
        `.execute(tx),
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
  admin = new pg.Client({ connectionString: database.url });
  await admin.connect();
  db = databaseAsServiceRoles(roleUrls, database, 4);
  other = databaseAsServiceRoles(roleUrls, database, 4);
  alpha = await insertTenant(admin, 'alpha');
  bravo = await insertTenant(admin, 'bravo');
});

afterAll(async () => {
  await other.close();
  await db.close();
  await admin.end();
  await database.drop();
});

describe('a key', () => {
  it('same key within 7 days returns the stored response', async () => {
    const key = randomUUID();
    const leaseId = leaseOf(await reserve(key));
    expect(await finish(key, leaseId, 201, '{"id":"first"}')).toBe(true);
    expect(await reserve(key)).toEqual({
      kind: 'replay',
      status: 201,
      requestId: 'req_original',
      body: '{"id":"first"}',
    });
    // The window is the column that answers for it, a week from when it was won.
    const window = await db.tenant(alpha).transaction(async (tx) =>
      sql<{ days: string }>`
        select round(extract(epoch from expires_at - created_at) / 86400)::text as days
          from ujira.idempotency_keys where idempotency_key = ${key}
      `.execute(tx),
    );
    expect(window.rows).toEqual([{ days: '7' }]);
  });

  it('with a different request is a mismatch, while running and after', async () => {
    const key = randomUUID();
    const leaseId = leaseOf(await reserve(key));
    expect(await reserve(key, { request: hash('another body') })).toEqual({ kind: 'mismatch' });
    await finish(key, leaseId);
    expect(await reserve(key, { request: hash('another body') })).toEqual({ kind: 'mismatch' });
  });

  it('is in progress for a second attempt while the first holds its lease', async () => {
    const key = randomUUID();
    leaseOf(await reserve(key));
    expect(await reserve(key)).toEqual({ kind: 'in_progress' });
  });

  it('goes to exactly one of many attempts racing across two pools', async () => {
    const key = randomUUID();
    const results = await Promise.all(
      Array.from({ length: 12 }, async (_unused, index) =>
        reserve(key, { on: index % 2 === 0 ? db : other }),
      ),
    );
    expect(results.filter((result) => result.kind === 'started')).toHaveLength(1);
    expect(results.filter((result) => result.kind === 'in_progress')).toHaveLength(11);
  });

  it('is enforced by the unique constraint, not only by the method', async () => {
    const key = randomUUID();
    leaseOf(await reserve(key));
    expect(
      await codeOf(
        db.tenant(alpha).transaction(async (tx) =>
          sql`
            insert into ujira.idempotency_keys (
              principal_id, project_id, idempotency_key, request_sha256,
              lease_id, lease_expires_at, expires_at
            ) values (
              ujira.current_principal_id(), ujira.current_project_id(), ${key}, ${REQUEST},
              ${randomUUID()}, now() + interval '1 minute', now() + interval '7 days'
            )
          `.execute(tx),
        ),
      ),
    ).toBe('23505');
  });

  it('is unique on the principal, the project and the key, as the constraint says', async () => {
    const found = await admin.query<{ definition: string }>(
      `select pg_get_constraintdef(oid) as definition from pg_constraint
        where conrelid = 'ujira.idempotency_keys'::regclass
          and conname = 'idempotency_keys_tenant_key'`,
    );
    expect(found.rows).toEqual([
      { definition: 'UNIQUE (principal_id, project_id, idempotency_key)' },
    ]);
  });

  it('belongs to one project, so another project and another principal can use it too', async () => {
    const key = randomUUID();
    const secondProject = await insertProject(admin, alpha.principalId, 'second');
    leaseOf(await reserve(key));
    leaseOf(await reserve(key, { tenant: bravo }));
    leaseOf(
      await reserve(key, {
        tenant: { principalId: alpha.principalId, projectId: secondProject },
      }),
    );
  });
});

describe('a lease', () => {
  it('that runs out lets a retry of the same request take over', async () => {
    const key = randomUUID();
    const first = leaseOf(await reserve(key));
    await age(key, 'lease');
    const second = leaseOf(await reserve(key));
    expect(second).not.toBe(first);
  });

  it('that runs out does not let a different request take the key', async () => {
    const key = randomUUID();
    leaseOf(await reserve(key));
    await age(key, 'lease');
    expect(await reserve(key, { request: hash('another body') })).toEqual({ kind: 'mismatch' });
  });

  it('fences the attempt that lost it, whose answer does not overwrite the new one', async () => {
    const key = randomUUID();
    const first = leaseOf(await reserve(key));
    await age(key, 'lease');
    const second = leaseOf(await reserve(key));
    expect(await finish(key, first, 201, '{"id":"late"}')).toBe(false);
    expect(await finish(key, second, 201, '{"id":"current"}')).toBe(true);
    expect(await reserve(key)).toMatchObject({ kind: 'replay', body: '{"id":"current"}' });
  });

  it('that is released lets a retry run at once', async () => {
    const key = randomUUID();
    const leaseId = leaseOf(await reserve(key));
    const release = async (): Promise<boolean> =>
      db.tenant(alpha).transaction(async (tx) => idempotencyKeys.release(tx, { key, leaseId }));
    expect(await release()).toBe(true);
    const next = leaseOf(await reserve(key));
    // The old attempt has nothing left to release.
    expect(await release()).toBe(false);
    expect(next).not.toBe(leaseId);
  });
});

describe('the replay window', () => {
  it('once passed, the key is free for any request, whether or not the row is gone', async () => {
    const key = randomUUID();
    await finish(key, leaseOf(await reserve(key)));
    await age(key, 'window');
    leaseOf(await reserve(key, { request: hash('a new request') }));
  });

  it('a finished key is not freed by anything short of the window', async () => {
    const key = randomUUID();
    await finish(key, leaseOf(await reserve(key)));
    expect(await reserve(key)).toMatchObject({ kind: 'replay' });
    expect(await reserve(key)).toMatchObject({ kind: 'replay' });
  });
});

describe('what the table refuses', () => {
  it.each([
    ['an empty key', ''],
    ['a key with spaces', 'has space'],
    ['a key with an email in it', 'someone@example.com'],
    ['a key that is too long', 'a'.repeat(256)],
  ])('refuses %s', async (_name, key) => {
    expect(await codeOf(reserve(key))).toBe('23514');
  });

  it.each([
    ['a stored 500', 500],
    ['a stored 503', 503],
    ['a stored 429', 429],
  ])('refuses %s, which says to try again', async (_name, status) => {
    const key = randomUUID();
    const leaseId = leaseOf(await reserve(key));
    expect(await codeOf(finish(key, leaseId, status))).toBe('23514');
  });

  it('refuses a row that is both running and finished', async () => {
    const key = randomUUID();
    leaseOf(await reserve(key));
    expect(
      await codeOf(
        db.tenant(alpha).transaction(async (tx) =>
          sql`
            update ujira.idempotency_keys
               set request_id = 'req_half', response_status = 201, response_body = '{}'
             where idempotency_key = ${key}
          `.execute(tx),
        ),
      ),
    ).toBe('23514');
  });

  it('refuses a hash that is not 32 bytes', async () => {
    expect(await codeOf(reserve(randomUUID(), { request: Buffer.alloc(16, 1) }))).toBe('23514');
  });
});
