// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The migration step a server runs before its roles start, against a real
// Postgres: instances that start at once run each migration once, a failed
// migration leaves the database as it was and fails the start, and an
// instance stuck behind a lock that never frees gives up instead of hanging.

import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import pg from 'pg';
import { afterEach, beforeEach, describe, expect, inject, it } from 'vitest';

import { MIGRATIONS_DIR, MIGRATIONS_TABLE } from './migrate.js';
import { migrateBeforeStart, MigrationStartError } from './migrate-start.js';
import { createTestDatabase, roleUrl, type TestDatabase } from './testing/harness.js';

const adminUrl = inject('dbAdminUrl');
const roleUrls = inject('dbRoleUrls');

// The migration tool's own advisory lock, held the way a running instance holds it.
const TOOL_LOCK_KEY = '7241865325823964';

const ALL = readdirSync(MIGRATIONS_DIR)
  .filter((name) => name.endsWith('.sql'))
  .map((name) => name.replace(/\.sql$/, ''))
  .sort();

let dir: string;
let database: TestDatabase;
let admin: pg.Client;

const quiet = (): void => {
  // The runs' own lines are not under test here.
};

const migration = (up: string, down: string): string =>
  ['-- expand', '', '-- Up Migration', up, '', '-- Down Migration', down, ''].join('\n');

beforeEach(async (context) => {
  dir = mkdtempSync(join(tmpdir(), 'migrate-start-'));
  database = await createTestDatabase(adminUrl, `${import.meta.url}#${context.task.name}`, {
    empty: true,
  });
  admin = new pg.Client({ connectionString: database.url });
  await admin.connect();
});

afterEach(async () => {
  await admin.end();
  await database.drop();
  rmSync(dir, { recursive: true, force: true });
});

async function ledger(): Promise<string[]> {
  const { rows: found } = await admin.query<{ table: string | null }>(
    `select to_regclass('public.${MIGRATIONS_TABLE}')::text as table`,
  );
  if (found[0]?.table == null) return [];
  const { rows } = await admin.query<{ name: string }>(
    `select name from public.${MIGRATIONS_TABLE} order by name`,
  );
  return rows.map((row) => row.name);
}

async function tableExists(name: string): Promise<boolean> {
  const { rows } = await admin.query<{ found: string | null }>(
    'select to_regclass($1)::text as found',
    [name],
  );
  return rows[0]?.found != null;
}

describe('the migration step before the server starts', () => {
  it('two instances starting at once, each with both logins, run every migration once', async () => {
    const env = {
      UJIRA_DB_TLS: 'off',
      UJIRA_DB_BOOTSTRAP_URL: database.url,
      UJIRA_DB_MIGRATOR_URL: roleUrl(roleUrls, 'ujira_migrator', database.name),
    };
    const start = () => migrateBeforeStart(env, { log: quiet });
    const [first, second] = await Promise.all([start(), start()]);
    const names = [first, second].flatMap((run) => (run.ran ? run.names : []));
    // One applies them all, the other waits and finds nothing left.
    expect([...names].sort()).toEqual(ALL);
    expect(await ledger()).toEqual(ALL);

    const again = await migrateBeforeStart(env, { log: quiet });
    expect(again).toEqual({ ran: true, names: [] });
  }, 180_000);

  it('so do four instances on one login', async () => {
    writeFileSync(
      join(dir, '1000000000000_first.sql'),
      migration('create table public.start_first (id integer);', 'drop table public.start_first;'),
    );
    writeFileSync(
      join(dir, '1000000000001_second.sql'),
      migration(
        'create table public.start_second (id integer);',
        'drop table public.start_second;',
      ),
    );
    const env = { UJIRA_DB_TLS: 'off', UJIRA_DB_MIGRATOR_URL: database.url };
    const runs = await Promise.all(
      Array.from({ length: 4 }, () => migrateBeforeStart(env, { log: quiet, dir })),
    );
    const names = runs.flatMap((run) => (run.ran ? run.names : []));
    expect([...names].sort()).toEqual(['1000000000000_first', '1000000000001_second']);
    expect(await ledger()).toEqual(['1000000000000_first', '1000000000001_second']);
  }, 120_000);

  it('a failed migration fails the start and leaves the database as it was', async () => {
    writeFileSync(
      join(dir, '1000000000000_good.sql'),
      migration('create table public.start_good (id integer);', 'drop table public.start_good;'),
    );
    writeFileSync(
      join(dir, '1000000000001_broken.sql'),
      migration('select * from public.nowhere;', 'select 1;'),
    );
    const env = { UJIRA_DB_TLS: 'off', UJIRA_DB_MIGRATOR_URL: database.url };
    const error: unknown = await migrateBeforeStart(env, { log: quiet, dir }).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(MigrationStartError);
    expect((error as Error).message).toMatch(/^migrations failed: .*nowhere/);
    expect((error as Error).message).not.toContain(new URL(database.url).password);
    // One transaction for the run, so the good file went back with the broken one.
    expect(await tableExists('public.start_good')).toBe(false);
    expect(await ledger()).toEqual([]);
  }, 60_000);

  it('an instance behind a lock that never frees gives up after its wait, having run nothing', async () => {
    writeFileSync(
      join(dir, '1000000000000_first.sql'),
      migration('create table public.start_first (id integer);', 'drop table public.start_first;'),
    );
    const holder = new pg.Client({ connectionString: database.url });
    await holder.connect();
    try {
      await holder.query(`select pg_advisory_lock(${TOOL_LOCK_KEY})`);
      const started = Date.now();
      const error: unknown = await migrateBeforeStart(
        { UJIRA_DB_TLS: 'off', UJIRA_DB_MIGRATOR_URL: database.url },
        { log: quiet, dir, lockWaitMs: 1_000 },
      ).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(MigrationStartError);
      expect((error as Error).message).toBe(
        'migrations failed: another migration still held the lock after 1000 ms',
      );
      expect(Date.now() - started).toBeLessThan(30_000);
      expect(await tableExists('public.start_first')).toBe(false);
    } finally {
      await holder.end();
    }
  }, 60_000);
});
