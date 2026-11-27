// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// Every committed migration, up from an empty database, all the way down again,
// and up once more. A down section that leaves something behind, or drops
// something the next up cannot recreate, fails here rather than in a rollback.

import { readdirSync } from 'node:fs';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { MIGRATIONS_DIR, runMigrations } from './migrate.js';
import { catalogProblems } from './testing/catalog.js';
import { createTestDatabase, type TestDatabase } from './testing/harness.js';

const adminUrl = inject('dbAdminUrl');

let database: TestDatabase;
let client: pg.Client;

const committed = (): string[] =>
  readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith('.sql'))
    .sort()
    .map((name) => name.replace(/\.sql$/, ''));

async function schemas(): Promise<string[]> {
  const found = await client.query<{ name: string }>(
    `select nspname as name from pg_namespace where nspname in ('ujira', 'ops') order by 1`,
  );
  return found.rows.map((row) => row.name);
}

beforeAll(async () => {
  database = await createTestDatabase(adminUrl, import.meta.url, { empty: true });
  client = new pg.Client({ connectionString: database.url });
  await client.connect();
});

afterAll(async () => {
  await client.end();
  await database.drop();
});

describe('migrations from empty', () => {
  it('run up, all the way down to nothing, and up again', async () => {
    const files = committed();
    const up = await runMigrations({ databaseUrl: database.url, direction: 'up' });
    expect(up.names).toEqual(files);
    expect(await schemas()).toEqual(['ops', 'ujira']);

    const down = await runMigrations({
      databaseUrl: database.url,
      direction: 'down',
      count: Number.POSITIVE_INFINITY,
    });
    expect(down.names).toEqual([...files].reverse());
    expect(await schemas()).toEqual([]);

    const again = await runMigrations({ databaseUrl: database.url, direction: 'up' });
    expect(again.names).toEqual(files);
    expect(await catalogProblems(client)).toEqual([]);
  }, 300_000);
});
