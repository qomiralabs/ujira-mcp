// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The fee sponsor's daily cap per principal, against a real database as the
// role the API runs as. The races are real ones, on two pools.

import { createHash, randomUUID } from 'node:crypto';

import { sql } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import type { Database, ProjectContext } from '../database.js';
import { insertProject, insertTenant } from '../testing/admin-tenants.js';
import { databaseAsServiceRoles } from '../testing/databases.js';
import { createTestDatabase, type TestDatabase } from '../testing/harness.js';
import { feeSponsorships, type SponsoredFeeReservation } from './fee-sponsorships.js';
import { RepositoryInputError } from './values.js';

const adminUrl = inject('dbAdminUrl');
const roleUrls = inject('dbRoleUrls');

const DAY = '2026-11-27';
const CAP = 1_000n;

let database: TestDatabase;
let admin: pg.Client;
let db: Database;
let other: Database;

const txHash = (): string => createHash('sha256').update(randomUUID()).digest('hex');

async function tenant(): Promise<ProjectContext> {
  return insertTenant(admin, `fees-${randomUUID()}`);
}

async function reserve(
  who: ProjectContext,
  maxFee: bigint,
  options: { hash?: string; day?: string; cap?: bigint; on?: Database } = {},
): Promise<SponsoredFeeReservation> {
  return (options.on ?? db).tenant(who).transaction(async (tx) =>
    feeSponsorships.reserve(tx, {
      innerTxHash: options.hash ?? txHash(),
      day: options.day ?? DAY,
      maxFee,
      dailyCap: options.cap ?? CAP,
    }),
  );
}

async function used(who: ProjectContext, day = DAY): Promise<string | undefined> {
  const found = await admin.query<{ used: string }>(
    'select used_stroops::text as used from ujira.fee_sponsor_days where principal_id = $1 and day = $2',
    [who.principalId, day],
  );
  return found.rows[0]?.used;
}

async function rowOf(hash: string): Promise<{ status: string; charged: string | null }[]> {
  const found = await admin.query<{ status: string; charged: string | null }>(
    `select status, charged_stroops::text as charged
       from ujira.fee_sponsorships where inner_tx_hash = decode($1, 'hex')`,
    [hash],
  );
  return found.rows;
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
});

afterAll(async () => {
  await other.close();
  await db.close();
  await admin.end();
  await database.drop();
});

describe('the daily cap', () => {
  it('reserves up to the cap and refuses past it without writing anything', async () => {
    const who = await tenant();
    expect(await reserve(who, 600n)).toEqual({ kind: 'reserved', used: 600n });
    expect(await reserve(who, 400n)).toEqual({ kind: 'reserved', used: 1_000n });
    const hash = txHash();
    expect(await reserve(who, 1n, { hash })).toEqual({ kind: 'capped', used: 1_000n });
    expect(await rowOf(hash)).toEqual([]);
    expect(await used(who)).toBe('1000');
  });

  it('is shared by every project of a principal', async () => {
    const first = await tenant();
    const second = {
      principalId: first.principalId,
      projectId: await insertProject(admin, first.principalId, 'second'),
    };
    expect((await reserve(first, 700n)).kind).toBe('reserved');
    expect(await reserve(second, 400n)).toEqual({ kind: 'capped', used: 700n });
    expect(await reserve(second, 300n)).toEqual({ kind: 'reserved', used: 1_000n });
  });

  it('is separate for each principal and each day', async () => {
    const one = await tenant();
    const two = await tenant();
    expect((await reserve(one, 1_000n)).kind).toBe('reserved');
    expect(await reserve(two, 1_000n)).toEqual({ kind: 'reserved', used: 1_000n });
    expect(await reserve(one, 1_000n, { day: '2026-11-28' })).toEqual({
      kind: 'reserved',
      used: 1_000n,
    });
    expect(await reserve(one, 1n)).toEqual({ kind: 'capped', used: 1_000n });
  });

  it('counts one envelope once, however often it is retried', async () => {
    const who = await tenant();
    const hash = txHash();
    expect(await reserve(who, 800n, { hash })).toEqual({ kind: 'reserved', used: 800n });
    expect(await reserve(who, 800n, { hash })).toEqual({ kind: 'replay', used: 800n });
    expect(await used(who)).toBe('800');
  });

  it('never lets racing reservations of one principal pass the cap together', async () => {
    const first = await tenant();
    const second = {
      principalId: first.principalId,
      projectId: await insertProject(admin, first.principalId, 'second'),
    };
    const results = await Promise.all(
      Array.from({ length: 12 }, async (_unused, index) =>
        reserve(index % 2 === 0 ? first : second, 300n, { on: index % 3 === 0 ? other : db }),
      ),
    );
    expect(results.filter((r) => r.kind === 'reserved')).toHaveLength(3);
    expect(results.filter((r) => r.kind === 'capped')).toHaveLength(9);
    expect(await used(first)).toBe('900');
  });
});

describe('settling and releasing', () => {
  it('settles at what the network charged and gives the rest back to the day', async () => {
    const who = await tenant();
    const hash = txHash();
    await reserve(who, 900n, { hash });
    const settled = await db
      .tenant(who)
      .transaction(async (tx) => feeSponsorships.settle(tx, { innerTxHash: hash, charged: 150n }));
    expect(settled).toBe(true);
    expect(await rowOf(hash)).toEqual([{ status: 'settled', charged: '150' }]);
    expect(await used(who)).toBe('150');
    expect((await reserve(who, 850n)).kind).toBe('reserved');
    // A settled envelope sent again counts nothing more.
    expect(await reserve(who, 900n, { hash })).toEqual({ kind: 'replay', used: 1_000n });
  });

  it('never settles above the reservation, nor twice', async () => {
    const who = await tenant();
    const hash = txHash();
    await reserve(who, 200n, { hash });
    const settle = async () =>
      db
        .tenant(who)
        .transaction(async (tx) =>
          feeSponsorships.settle(tx, { innerTxHash: hash, charged: 999n }),
        );
    expect(await settle()).toBe(true);
    expect(await settle()).toBe(false);
    expect(await rowOf(hash)).toEqual([{ status: 'settled', charged: '200' }]);
    expect(await used(who)).toBe('200');
  });

  it('releases what the network never took, and the same envelope can be reserved again', async () => {
    const who = await tenant();
    const hash = txHash();
    await reserve(who, 1_000n, { hash });
    const release = async () =>
      db.tenant(who).transaction(async (tx) => feeSponsorships.release(tx, { innerTxHash: hash }));
    expect(await release()).toBe(true);
    expect(await release()).toBe(false);
    expect(await rowOf(hash)).toEqual([{ status: 'released', charged: '0' }]);
    expect(await used(who)).toBe('0');
    expect(await reserve(who, 1_000n, { hash })).toEqual({ kind: 'reserved', used: 1_000n });
    expect(await rowOf(hash)).toEqual([{ status: 'reserved', charged: null }]);
  });

  it('finds nothing to settle or release for a hash it never reserved', async () => {
    const who = await tenant();
    const results = await db
      .tenant(who)
      .transaction(async (tx) => [
        await feeSponsorships.settle(tx, { innerTxHash: txHash(), charged: 1n }),
        await feeSponsorships.release(tx, { innerTxHash: txHash() }),
      ]);
    expect(results).toEqual([false, false]);
  });
});

describe('the tables', () => {
  it('refuse values no row can hold, by field', async () => {
    const who = await tenant();
    const refused = async (input: Partial<Parameters<typeof feeSponsorships.reserve>[1]>) => {
      try {
        await db.tenant(who).transaction(async (tx) =>
          feeSponsorships.reserve(tx, {
            innerTxHash: txHash(),
            day: DAY,
            maxFee: 1n,
            dailyCap: CAP,
            ...input,
          }),
        );
      } catch (error) {
        if (error instanceof RepositoryInputError) return error.field;
      }
      return undefined;
    };
    expect(await refused({ innerTxHash: 'AB'.repeat(32) })).toBe('innerTxHash');
    expect(await refused({ day: '27/11/2026' })).toBe('day');
    expect(await refused({ maxFee: 0n })).toBe('maxFee');
    expect(await refused({ maxFee: 1n << 63n })).toBe('maxFee');
    expect(await refused({ dailyCap: -1n })).toBe('dailyCap');
  });

  it('hold one row per envelope per project, by the unique constraint', async () => {
    const who = await tenant();
    const hash = txHash();
    await reserve(who, 10n, { hash });
    expect(
      await codeOf(
        db.tenant(who).transaction(async (tx) =>
          sql`
            insert into ujira.fee_sponsorships (
              principal_id, project_id, inner_tx_hash, day, max_fee_stroops
            ) values (
              ujira.current_principal_id(), ujira.current_project_id(),
              decode(${hash}, 'hex'), ${DAY}::date, 10
            )
          `.execute(tx),
        ),
      ),
    ).toBe('23505');
  });

  it('refuse a status change the machine does not have, and a charge without a settle', async () => {
    const who = await tenant();
    const hash = txHash();
    await reserve(who, 10n, { hash });
    await db
      .tenant(who)
      .transaction(async (tx) => feeSponsorships.settle(tx, { innerTxHash: hash, charged: 5n }));
    expect(
      await codeOf(
        db.tenant(who).transaction(async (tx) =>
          sql`
            update ujira.fee_sponsorships set status = 'reserved', charged_stroops = null
             where inner_tx_hash = decode(${hash}, 'hex')
          `.execute(tx),
        ),
      ),
    ).toBe('UJ004');
    const open = txHash();
    await reserve(who, 10n, { hash: open });
    expect(
      await codeOf(
        db.tenant(who).transaction(async (tx) =>
          sql`
            update ujira.fee_sponsorships set charged_stroops = 1
             where inner_tx_hash = decode(${open}, 'hex')
          `.execute(tx),
        ),
      ),
    ).toBe('23514');
  });

  it('let the app read but never write a day under the read only scope of every project', async () => {
    const who = await tenant();
    await reserve(who, 10n);
    const seen = await db.principal(who, 'app').transaction(async (tx) =>
      sql<{
        used: string;
      }>`select used_stroops::text as used from ujira.fee_sponsor_days`.execute(tx),
    );
    expect(seen.rows).toEqual([{ used: '10' }]);
    expect(
      await codeOf(
        db.principal(who, 'app').transaction(async (tx) =>
          feeSponsorships.reserve(tx, {
            innerTxHash: txHash(),
            day: '2026-12-01',
            maxFee: 1n,
            dailyCap: CAP,
          }),
        ),
      ),
    ).toBeDefined();
  });
});
