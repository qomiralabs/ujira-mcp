// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The hand written schema in schema.ts against the tables the migrations
// actually create, so a migration that adds a column, or a table, without
// telling kysely fails here rather than in a query at run time.

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { SCHEMA_COLUMNS } from './schema.js';
import { createTestDatabase, type TestDatabase } from './testing/harness.js';

const adminUrl = inject('dbAdminUrl');

let database: TestDatabase;
let client: pg.Client;

beforeAll(async () => {
  database = await createTestDatabase(adminUrl, import.meta.url);
  client = new pg.Client({ connectionString: database.url });
  await client.connect();
});

afterAll(async () => {
  await client.end();
  await database.drop();
});

describe('schema.ts', () => {
  it('names exactly the tables and columns of schema ujira', async () => {
    const { rows } = await client.query<{ name: string }>(
      `select format('%s.%s.%s', c.table_schema, c.table_name, c.column_name) as name
         from information_schema.columns c
         join information_schema.tables t
           on t.table_schema = c.table_schema and t.table_name = c.table_name
        where c.table_schema = 'ujira' and t.table_type = 'BASE TABLE'
        order by 1`,
    );
    const declared = Object.entries(SCHEMA_COLUMNS)
      .flatMap(([table, columns]) => Object.keys(columns).map((column) => `${table}.${column}`))
      .sort();
    expect(rows.map((row) => row.name)).toEqual(declared);
  });
});
