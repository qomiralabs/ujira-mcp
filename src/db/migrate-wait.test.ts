// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// Several instances migrating at boot, each told to wait for the others. A concurrent
// index build waits for every transaction open while it runs, so a migrator that waits for
// the lock inside a statement is one it waits for, while that migrator waits for it. These
// run real migrators at once against one Postgres, with such a build in the folder.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import pg from 'pg';
import { afterEach, beforeEach, describe, expect, inject, it } from 'vitest';

import { MIGRATIONS_TABLE, runMigrations, runMigrationsByFile } from './migrate.js';
import { createTestDatabase, roleUrl, type TestDatabase } from './testing/harness.js';

const adminUrl = inject('dbAdminUrl');
const roleUrls = inject('dbRoleUrls');

let dir: string;
let database: TestDatabase;
let admin: pg.Client;

const migration = (lines: readonly string[]): string => `${lines.join('\n')}\n`;

beforeEach(async (context) => {
  dir = mkdtempSync(join(tmpdir(), 'migrate-wait-'));
  database = await createTestDatabase(adminUrl, `${import.meta.url}#${context.task.name}`, {
    empty: true,
  });
  admin = new pg.Client({ connectionString: database.url });
  await admin.connect();
  writeFileSync(
    join(dir, '1000000000000_table.sql'),
    migration([
      '-- expand',
      '',
      '-- Up Migration',
      'create table if not exists public.boot_table (id integer);',
      '',
      '-- Down Migration',
      'drop table if exists public.boot_table;',
    ]),
  );
  writeFileSync(
    join(dir, '1000000000001_concurrent.sql'),
    migration([
      '-- expand',
      '-- no-transaction',
      '',
      '-- Up Migration',
      'create index concurrently if not exists boot_index on public.boot_table (id);',
      '',
      '-- Down Migration',
      'drop index concurrently if exists public.boot_index;',
    ]),
  );
});

afterEach(async () => {
  await admin.end();
  await database.drop();
  rmSync(dir, { recursive: true, force: true });
});

const indexes = async (): Promise<number> =>
  (await admin.query(`select 1 from pg_indexes where indexname = 'boot_index'`)).rows.length;

describe('instances migrating at boot, each waiting for the lock', () => {
  it('two that start together both finish a concurrent index build, which runs once', async () => {
    const run = () =>
      runMigrations({ databaseUrl: database.url, direction: 'up', lockMode: 'wait', dir });
    const [first, second] = await Promise.all([run(), run()]);
    // One applies both files, and the other waits and finds nothing to do.
    expect([...first.names, ...second.names].sort()).toEqual([
      '1000000000000_table',
      '1000000000001_concurrent',
    ]);
    expect(await indexes()).toBe(1);
  }, 120_000);

  it('so do more than two', async () => {
    const run = () =>
      runMigrations({ databaseUrl: database.url, direction: 'up', lockMode: 'wait', dir });
    const runs = await Promise.all([run(), run(), run(), run()]);
    expect(runs.flatMap((one) => one.names)).toHaveLength(2);
    expect(await indexes()).toBe(1);
  }, 120_000);

  it('two running each file under its own login do too', async () => {
    // As a real database is migrated: the build runs as the migrator, which takes the
    // owner's rights for it, so the table has to be the owner's.
    await runMigrations({ databaseUrl: database.url, direction: 'up', count: 1, dir });
    await admin.query('grant create on schema public to ujira_owner');
    await admin.query('alter table public.boot_table owner to ujira_owner');
    await admin.query(`grant all on public.${MIGRATIONS_TABLE} to ujira_migrator`);
    await admin.query('grant all on all sequences in schema public to ujira_migrator');
    await admin.query(`revoke all on public.${MIGRATIONS_TABLE} from ujira_owner`);
    const run = () =>
      runMigrationsByFile({
        bootstrapUrl: database.url,
        migratorUrl: roleUrl(roleUrls, 'ujira_migrator', database.name),
        direction: 'up',
        lockMode: 'wait',
        dir,
      });
    const [first, second] = await Promise.all([run(), run()]);
    expect([...first.names, ...second.names]).toEqual(['1000000000001_concurrent']);
    expect(await indexes()).toBe(1);
  }, 120_000);

  it('one alone runs as it always did', async () => {
    const run = await runMigrations({
      databaseUrl: database.url,
      direction: 'up',
      lockMode: 'wait',
      dir,
    });
    expect(run.names).toEqual(['1000000000000_table', '1000000000001_concurrent']);
    expect(await indexes()).toBe(1);
  }, 60_000);

  it('a run that does not wait still stops at once when another holds the lock', async () => {
    const holder = new pg.Client({ connectionString: database.url });
    await holder.connect();
    try {
      // The migration tool's own lock, held as a run would hold it.
      await holder.query('select pg_advisory_lock(7241865325823964)');
      await expect(
        runMigrations({ databaseUrl: database.url, direction: 'up', dir }),
      ).rejects.toThrow(/Another migration is already running/);
    } finally {
      await holder.end();
    }
  }, 60_000);

  it('a waiting run gives up nothing it was told to fail on', async () => {
    writeFileSync(
      join(dir, '1000000000002_broken.sql'),
      migration([
        '-- expand',
        '',
        '-- Up Migration',
        'select * from nowhere;',
        '',
        '-- Down Migration',
        'select 1;',
      ]),
    );
    await expect(
      runMigrations({ databaseUrl: database.url, direction: 'up', lockMode: 'wait', dir }),
    ).rejects.toThrow(/nowhere/);
  }, 60_000);
});
