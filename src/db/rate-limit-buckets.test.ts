// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The function behind the API rate limits, against a real database: how a bucket
// fills and empties, that a request takes from every bucket or from none, and
// that concurrent callers never get more than a bucket holds. Refill is real
// time, so each case uses the slowest refill there is and bounds what the time
// it took could have given back.

import { createHash, randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import type { Database } from './database.js';
import {
  rateLimits,
  type RateLimitBucket,
  type RateLimitTaken,
} from './repositories/rate-limits.js';
import { databaseAsServiceRoles } from './testing/databases.js';
import { createTestDatabase, roleUrl, type TestDatabase } from './testing/harness.js';

const adminUrl = inject('dbAdminUrl');
const roleUrls = inject('dbRoleUrls');

let database: TestDatabase;
let db: Database;
let other: Database;

beforeAll(async () => {
  database = await createTestDatabase(adminUrl, import.meta.url);
  db = databaseAsServiceRoles(roleUrls, database, 4);
  other = databaseAsServiceRoles(roleUrls, database, 4);
});

afterAll(async () => {
  await other.close();
  await db.close();
  await database.drop();
});

function bucket(capacity = 3, refillPerSecond = 1): RateLimitBucket {
  const digest = createHash('sha256').update(randomUUID()).digest('hex');
  return { key: `token:${digest}`, capacity, refillPerSecond };
}

async function take(buckets: readonly RateLimitBucket[], on: Database = db) {
  return on.unscoped(async (tx) => rateLimits.take(tx, buckets));
}

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

async function asRole<T>(
  role: 'ujira_app' | 'ujira_worker' | 'ujira_reader',
  work: (client: pg.Client) => Promise<T>,
): Promise<T> {
  const client = new pg.Client({ connectionString: roleUrl(roleUrls, role, database.name) });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

describe('one bucket', () => {
  it('starts full and takes one token', async () => {
    const one = bucket(5);
    const [result] = await take([one]);
    expect(result).toEqual({ key: one.key, allowed: true, tokens: 4 });
  });

  it('refuses once it is empty, and says so without going below zero', async () => {
    const one = bucket(2);
    let refused = false;
    for (let attempt = 0; attempt < 30 && !refused; attempt += 1) {
      const [result] = await take([one]);
      expect(result?.tokens).toBeGreaterThanOrEqual(0);
      refused = result?.allowed === false;
    }
    expect(refused).toBe(true);
  });

  it('refills with time, up to its capacity and no further', async () => {
    const one = bucket(2, 50);
    await take([one]);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const [result] = await take([one]);
    // Full again after 200 ms at 50 per second, less the one just taken.
    expect(result?.tokens).toBe(1);
  });

  it('gives concurrent callers no more than it holds, across two pools', async () => {
    const one = bucket(6);
    const started = Date.now();
    const results = await Promise.all(
      Array.from({ length: 24 }, (_unused, index) => take([one], index % 2 === 0 ? db : other)),
    );
    const seconds = Math.ceil((Date.now() - started) / 1000);
    const allowed = results.filter(([result]) => result?.allowed === true).length;
    expect(allowed).toBeGreaterThanOrEqual(6);
    expect(allowed).toBeLessThanOrEqual(6 + seconds);
  });
});

describe('several buckets', () => {
  it('takes from all of them or from none', async () => {
    const small = bucket(1);
    const large = bucket(100);
    const tokensOfLarge = (rows: readonly RateLimitTaken[]): number =>
      rows.find((row) => row.key === large.key)?.tokens ?? -1;
    const first = await take([small, large]);
    expect(first.map((result) => result.allowed)).toEqual([true, true]);
    let before = tokensOfLarge(first);
    // The small bucket refills too, so this asks until it refuses.
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const rows = await take([small, large]);
      if (rows.every((row) => !row.allowed)) {
        // The large bucket gave nothing up for a request the small one refused.
        // It can only have grown, from the refill.
        expect(tokensOfLarge(rows)).toBeGreaterThanOrEqual(before);
        return;
      }
      before = tokensOfLarge(rows);
    }
    throw new Error('the small bucket never refused');
  });

  it('never deadlocks two requests that name the same buckets in opposite orders', async () => {
    const a = bucket(500);
    const b = bucket(500);
    const results = await Promise.all(
      Array.from({ length: 16 }, (_unused, index) =>
        take(index % 2 === 0 ? [a, b] : [b, a], index % 4 < 2 ? db : other),
      ),
    );
    expect(results.every((rows) => rows.every((row) => row.allowed))).toBe(true);
  });
});

const NINE = Array.from({ length: 9 }, () => 1);
const BAD_CALLS: readonly (readonly [string, string[], number[], number[]])[] = [
  ['no buckets', [], [], []],
  ['too many buckets', NINE.map(() => bucket().key), NINE, NINE],
  ['a capacity missing', [bucket().key], [], [1]],
  ['a refill missing', [bucket().key], [1], []],
  ['a capacity of zero', [bucket().key], [0], [1]],
  ['a refill of zero', [bucket().key], [1], [0]],
];

describe('what it refuses', () => {
  it.each(BAD_CALLS)('refuses %s', async (_name, keys, capacities, refills) => {
    expect(
      await asRole('ujira_app', async (client) =>
        codeOf(
          client.query(
            'select * from ujira.take_rate_limit_tokens($1::text[], $2::int[], $3::int[])',
            [keys, capacities, refills],
          ),
        ),
      ),
    ).toBe('22023');
  });

  it('refuses a key that is not a digest, so no tenant id can land in the table', async () => {
    expect(
      await codeOf(take([{ key: `token:${randomUUID()}`, capacity: 1, refillPerSecond: 1 }])),
    ).toBe('23514');
  });
});

describe('who can call it', () => {
  it('is the app role, and it still cannot read the table', async () => {
    expect(
      await asRole('ujira_app', async (client) =>
        codeOf(client.query('select * from ujira.rate_limit_buckets')),
      ),
    ).toBe('42501');
  });

  it.each(['ujira_worker', 'ujira_reader'] as const)('is not %s', async (role) => {
    expect(
      await asRole(role, async (client) =>
        codeOf(client.query(`select * from ujira.take_rate_limit_tokens('{}', '{}', '{}')`)),
      ),
    ).toBe('42501');
  });
});
