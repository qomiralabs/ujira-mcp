// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

import { readFileSync } from 'node:fs';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { MIGRATIONS_TABLE, runMigrations } from '../migrate.js';
import { HARNESS_ADMIN_PASSWORD, harnessPassword } from './credentials.js';
import { POSTGRES_IMAGE } from './image.js';
import {
  createTestDatabase,
  databaseNameFor,
  LOGIN_ROLES,
  quoteIdentifier,
  TEMPLATE_DATABASE,
  withDatabase,
  type TestDatabase,
} from './harness.js';
// The row this file writes, and the row the other file writes, are named
// here so each file can look for the other's and find nothing.
import { OTHER_FILE_ROW, THIS_FILE_ROW } from './isolation-rows.js';

const adminUrl = inject('dbAdminUrl');

let database: TestDatabase;
let client: pg.Client;

beforeAll(async () => {
  database = await createTestDatabase(adminUrl, import.meta.url);
  client = new pg.Client({ connectionString: database.url });
  await client.connect();
  await client.query('create table marker (name text primary key)');
  await client.query('insert into marker (name) values ($1)', [THIS_FILE_ROW]);
});

afterAll(async () => {
  await client.end();
  await database.drop();
});

describe('harness', () => {
  it("two files never see each other's rows", async () => {
    // The other file writes its own marker into its own database. This file
    // sees only the one it wrote: a different database, cloned separately
    // from the same template.
    const mine = await client.query<{ name: string }>('select name from marker');
    expect(mine.rows.map((row) => row.name)).toEqual([THIS_FILE_ROW]);

    const other = await client.query<{ count: string }>(
      'select count(*)::text as count from marker where name = $1',
      [OTHER_FILE_ROW],
    );
    expect(other.rows[0]?.count).toBe('0');
  });

  it('gives each file its own database name, derived from its path', async () => {
    const result = await client.query<{ name: string }>('select current_database() as name');
    expect(result.rows[0]?.name).toBe(databaseNameFor(import.meta.url));
    expect(result.rows[0]?.name).not.toBe(TEMPLATE_DATABASE);
  });

  it('starts from the migrated template, so the migrations table is already there', async () => {
    const result = await client.query<{ count: string }>(
      'select count(*)::text as count from information_schema.tables where table_name = $1',
      [MIGRATIONS_TABLE],
    );
    expect(result.rows[0]?.count).toBe('1');
  });

  it('runs the migrations once for the whole run, not once per file', async () => {
    // Running them again in this database applies nothing, which is what
    // proves the clone arrived already migrated.
    const applied = await runMigrations({ databaseUrl: database.url, direction: 'up' });
    expect(applied.names).toEqual([]);
  });

  it('runs the server the image pins, not whatever is newest', async () => {
    // The tag is the whole reason this harness behaves the same on a
    // developer machine as in CI. Reading the server version proves the pin
    // is what started, rather than only that a constant says so.
    const [, version] = /^postgres:(\d+\.\d+)$/.exec(POSTGRES_IMAGE) ?? [];
    expect(version).toBeDefined();
    const reported = await client.query<{ version: string }>('select version() as version');
    expect(reported.rows[0]?.version).toContain(`PostgreSQL ${String(version)}`);
  });

  it('refuses an identifier that is not a plain lower case name', () => {
    for (const bad of ['Marker', 'drop table x', 'a-b', '1abc', 'a"b', '']) {
      expect(() => quoteIdentifier(bad), bad).toThrow();
    }
    expect(quoteIdentifier('t_db_abc123')).toBe('"t_db_abc123"');
  });

  it('builds a database name that fits Postgres and stays unique per path', () => {
    const a = databaseNameFor('/repo/src/db/testing/a.test.ts');
    const b = databaseNameFor('/repo/src/db/testing/b.test.ts');
    const deep = databaseNameFor(`/repo/src/db/${'nested/'.repeat(20)}x.test.ts`);
    for (const name of [a, b, deep]) {
      expect(name.length).toBeLessThanOrEqual(63);
      expect(name).toMatch(/^[a-z_][a-z0-9_]*$/);
    }
    expect(a).not.toBe(b);
    // Two files with the same leading path but different names must not
    // collide once the slug is truncated.
    const long1 = databaseNameFor(`/repo/src/db/${'x'.repeat(60)}/one.test.ts`);
    const long2 = databaseNameFor(`/repo/src/db/${'x'.repeat(60)}/two.test.ts`);
    expect(long1).not.toBe(long2);
  });

  it('keeps the database in the url and leaves the rest of it alone', () => {
    const url = withDatabase('postgresql://u:p@host:6543/postgres', 'other');
    expect(url).toBe('postgresql://u:p@host:6543/other');
  });

  it('refuses to hand out a database with no admin url', async () => {
    await expect(createTestDatabase('', import.meta.url)).rejects.toThrow(/global setup/);
  });

  // Read from what the global setup actually published, so this is the
  // running harness and not only a constant that says so.
  it('logs every role in with its fixed password, and the superuser with its own', () => {
    const roleUrls = inject('dbRoleUrls');
    expect(Object.keys(roleUrls).sort()).toEqual([...LOGIN_ROLES].sort());
    for (const role of LOGIN_ROLES) {
      const url = new URL(String(roleUrls[role]));
      expect(decodeURIComponent(url.password), role).toBe(harnessPassword(role));
    }
    expect(decodeURIComponent(new URL(adminUrl).password)).toBe(HARNESS_ADMIN_PASSWORD);
  });

  it('generates no credential: nothing random is used to start the container', () => {
    const source = readFileSync(new URL('./container.ts', import.meta.url), 'utf8');
    // A boolean, so a failure here does not print the file.
    expect(/node:crypto|\brandom|getPassword/i.test(source)).toBe(false);
  });

  it('does not let a test write to the template', async () => {
    // The template is marked as not allowing connections, so a stray write
    // cannot reach the schema every other file is cloned from.
    const templateUrl = withDatabase(adminUrl, TEMPLATE_DATABASE);
    const stray = new pg.Client({ connectionString: templateUrl });
    await expect(stray.connect()).rejects.toThrow();
  });
});
