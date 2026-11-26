// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The second half of the isolation proof. This file writes its own marker
// into its own database and looks for the one harness.test.ts writes.
// Neither file can see the other's row, in either order, and whichever runs
// second would find the first one's row if they shared a database.

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { createTestDatabase, databaseNameFor, type TestDatabase } from './harness.js';
import { OTHER_FILE_ROW, THIS_FILE_ROW } from './isolation-rows.js';

const adminUrl = inject('dbAdminUrl');

let database: TestDatabase;
let client: pg.Client;

beforeAll(async () => {
  database = await createTestDatabase(adminUrl, import.meta.url);
  client = new pg.Client({ connectionString: database.url });
  await client.connect();
  await client.query('create table marker (name text primary key)');
  await client.query('insert into marker (name) values ($1)', [OTHER_FILE_ROW]);
});

afterAll(async () => {
  await client.end();
  await database.drop();
});

describe('harness isolation, second file', () => {
  it('sees only its own row', async () => {
    const rows = await client.query<{ name: string }>('select name from marker');
    expect(rows.rows.map((row) => row.name)).toEqual([OTHER_FILE_ROW]);
  });

  it('cannot see the row the other file wrote', async () => {
    const found = await client.query<{ count: string }>(
      'select count(*)::text as count from marker where name = $1',
      [THIS_FILE_ROW],
    );
    expect(found.rows[0]?.count).toBe('0');
  });

  it('got a different database from the other file', () => {
    const mine = databaseNameFor(import.meta.url);
    const theirs = databaseNameFor(import.meta.url.replace('isolation.test.ts', 'harness.test.ts'));
    expect(mine).not.toBe(theirs);
  });
});
