// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// A real database is migrated by two logins: a bootstrap login for what creates a schema
// or administers roles, and the migrator, which logs in with `noinherit`, for the rest.
// Every other test migrates as the admin user, who can do anything, which is how
// concurrent index builds that the migrator could not run got as far as a merge. This
// one migrates from an empty database the way a deployment does.

import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import {
  MIGRATIONS_DIR,
  MIGRATIONS_TABLE,
  migrationLogin,
  MigrationLoginError,
  needsBootstrap,
  parseMigration,
  runMigrations,
  runMigrationsByFile,
} from './migrate.js';
import { createTestDatabase, roleUrl, type TestDatabase } from './testing/harness.js';

const adminUrl = inject('dbAdminUrl');
const roleUrls = inject('dbRoleUrls');

let database: TestDatabase;

beforeAll(async () => {
  database = await createTestDatabase(adminUrl, import.meta.url, { empty: true });
});

afterAll(async () => {
  await database.drop();
});

const realFiles = () =>
  readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith('.sql'))
    .sort();

describe('migrating with two logins', () => {
  it('runs every migration from zero, each under the login it says it needs', async () => {
    const files = realFiles();
    const run = await runMigrationsByFile({
      bootstrapUrl: database.url,
      migratorUrl: roleUrl(roleUrls, 'ujira_migrator', database.name),
      direction: 'up',
    });
    expect(run.names).toEqual(files.map((name) => name.replace(/\.sql$/, '')));
    // Every migration outside a transaction is the migrator's: a concurrent index build
    // cannot sit in the bootstrap block that sets a role for it. The fixture below runs
    // one under the migrator, since no committed migration builds one yet.
    const concurrent = files
      .map((name) => parseMigration(name, readFileSync(join(MIGRATIONS_DIR, name), 'utf8')))
      .filter((source) => !source.transactional);
    for (const source of concurrent) expect(migrationLogin(source), source.name).toBe('migrator');
  }, 300_000);

  it('finds nothing to do the second time', async () => {
    const run = await runMigrationsByFile({
      bootstrapUrl: database.url,
      migratorUrl: roleUrl(roleUrls, 'ujira_migrator', database.name),
      direction: 'up',
    });
    expect(run.names).toEqual([]);
  }, 60_000);

  it('rolls a concurrent build back and forward, recording each as the login', async () => {
    // A folder of its own, because the real migrations above the newest concurrent
    // build change, and some of them need the bootstrap login to come down.
    const dir = mkdtempSync(join(tmpdir(), 'migrator-rollback-'));
    const fresh = await createTestDatabase(adminUrl, `${import.meta.url}#rollback`, {
      empty: true,
    });
    const admin = new pg.Client({ connectionString: fresh.url });
    await admin.connect();
    try {
      writeFileSync(
        join(dir, '1000000000000_first.sql'),
        '-- expand\n\n-- Up Migration\nselect 1;\n\n-- Down Migration\nselect 1;\n',
      );
      writeFileSync(
        join(dir, '1000000000001_concurrent.sql'),
        [
          '-- expand',
          '-- no-transaction',
          '',
          '-- Up Migration',
          'create index concurrently if not exists rollback_index on public.rollback_table (id);',
          '',
          '-- Down Migration',
          'drop index concurrently if exists public.rollback_index;',
          '',
        ].join('\n'),
      );
      await runMigrations({ databaseUrl: fresh.url, direction: 'up', count: 1, dir });
      await admin.query('create table public.rollback_table (id integer)');
      await admin.query('grant create on schema public to ujira_owner');
      await admin.query('alter table public.rollback_table owner to ujira_owner');
      await admin.query(`grant all on public.${MIGRATIONS_TABLE} to ujira_migrator`);
      await admin.query('grant all on all sequences in schema public to ujira_migrator');
      // The owner role has no right to the migrations table, so recording a run
      // fails unless the role was reset first.
      await admin.query(`revoke all on public.${MIGRATIONS_TABLE} from ujira_owner`);
      const indexes = async () =>
        (
          await admin.query<{ indexname: string }>(
            `select indexname from pg_indexes where indexname = 'rollback_index'`,
          )
        ).rows.length;
      const migrator = roleUrl(roleUrls, 'ujira_migrator', fresh.name);
      const up = await runMigrations({
        databaseUrl: migrator,
        direction: 'up',
        login: 'migrator',
        dir,
      });
      expect(up.names).toEqual(['1000000000001_concurrent']);
      expect(await indexes()).toBe(1);
      // What the build made belongs to the owner of its table, not to the login.
      const { rows } = await admin.query<{ owner: string }>(
        `select pg_get_userbyid(c.relowner) as owner
           from pg_class c
          where c.oid = 'public.rollback_index'::regclass`,
      );
      expect(rows).toEqual([{ owner: 'ujira_owner' }]);
      const down = await runMigrations({
        databaseUrl: migrator,
        direction: 'down',
        login: 'migrator',
        dir,
      });
      expect(down.names).toEqual(['1000000000001_concurrent']);
      expect(await indexes()).toBe(0);
    } finally {
      await admin.end();
      await fresh.drop();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});

describe('a file and the login running it', () => {
  const emptied = async (label: string) =>
    createTestDatabase(adminUrl, `${import.meta.url}#${label}`, { empty: true });
  const recorded = async (database: TestDatabase) => {
    const admin = new pg.Client({ connectionString: database.url });
    await admin.connect();
    try {
      const { rows } = await admin.query<{ count: string }>(
        `select count(*)::text as count from public.${MIGRATIONS_TABLE}`,
      );
      const count = rows[0]?.count;
      if (count === undefined) throw new Error('count(*) returned no row');
      return Number.parseInt(count, 10);
    } finally {
      await admin.end();
    }
  };

  function fixtures(): string {
    const dir = mkdtempSync(join(tmpdir(), 'migration-logins-'));
    writeFileSync(
      join(dir, '1000000000000_needs_bootstrap.sql'),
      '-- expand\n-- bootstrap\n\n-- Up Migration\nselect 1;\n\n-- Down Migration\nselect 1;\n',
    );
    writeFileSync(
      join(dir, '1000000000001_plain.sql'),
      '-- expand\n\n-- Up Migration\nselect 1;\n\n-- Down Migration\nselect 1;\n',
    );
    return dir;
  }

  it('refuses a marked file under the migrator, with nothing run', async () => {
    const fresh = await emptied('marked');
    const dir = mkdtempSync(join(tmpdir(), 'migration-marked-'));
    writeFileSync(
      join(dir, '1000000000000_first.sql'),
      '-- expand\n\n-- Up Migration\nselect 1;\n\n-- Down Migration\nselect 1;\n',
    );
    writeFileSync(
      join(dir, '1000000000001_needs_bootstrap.sql'),
      '-- expand\n-- bootstrap\n\n-- Up Migration\nselect 1;\n\n-- Down Migration\nselect 1;\n',
    );
    try {
      await runMigrations({ databaseUrl: fresh.url, direction: 'up', count: 1, dir });
      const admin = new pg.Client({ connectionString: fresh.url });
      await admin.connect();
      await admin.query(`grant all on public.${MIGRATIONS_TABLE} to ujira_migrator`);
      await admin.query('grant all on all sequences in schema public to ujira_migrator');
      await admin.end();
      await expect(
        runMigrations({
          databaseUrl: roleUrl(roleUrls, 'ujira_migrator', fresh.name),
          direction: 'up',
          count: 1,
          login: 'migrator',
          dir,
        }),
      ).rejects.toBeInstanceOf(MigrationLoginError);
      expect(await recorded(fresh)).toBe(1);
    } finally {
      await fresh.drop();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('refuses a plain file under the bootstrap login, with nothing run', async () => {
    const fresh = await emptied('plain');
    const dir = fixtures();
    try {
      await runMigrations({ databaseUrl: fresh.url, direction: 'up', count: 1, dir });
      await expect(
        runMigrations({
          databaseUrl: fresh.url,
          direction: 'up',
          count: 1,
          login: 'bootstrap',
          dir,
        }),
      ).rejects.toBeInstanceOf(MigrationLoginError);
      expect(await recorded(fresh)).toBe(1);
    } finally {
      await fresh.drop();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('refuses a superuser naming itself the migrator', async () => {
    const fresh = await emptied('superuser');
    try {
      await expect(
        runMigrations({ databaseUrl: fresh.url, direction: 'up', login: 'migrator' }),
      ).rejects.toBeInstanceOf(MigrationLoginError);
    } finally {
      await fresh.drop();
    }
  }, 60_000);

  it('refuses the migrator naming itself the bootstrap login', async () => {
    const fresh = await emptied('migrator');
    const url = roleUrl(roleUrls, 'ujira_migrator', fresh.name);
    try {
      await expect(
        runMigrations({ databaseUrl: url, direction: 'up', login: 'bootstrap' }),
      ).rejects.toBeInstanceOf(MigrationLoginError);
      await expect(
        runMigrationsByFile({ bootstrapUrl: url, migratorUrl: url, direction: 'up' }),
      ).rejects.toBeInstanceOf(MigrationLoginError);
    } finally {
      await fresh.drop();
    }
  }, 60_000);

  it('takes a login that names nothing for the migrator, unless it is a superuser', async () => {
    const fresh = await emptied('unnamed');
    const dir = mkdtempSync(join(tmpdir(), 'migration-unnamed-'));
    const plain = '-- expand\n\n-- Up Migration\nselect 1;\n\n-- Down Migration\nselect 1;\n';
    writeFileSync(join(dir, '1000000000000_first.sql'), plain);
    writeFileSync(join(dir, '1000000000001_plain.sql'), plain);
    writeFileSync(
      join(dir, '1000000000002_needs_bootstrap.sql'),
      plain.replace('-- expand\n', '-- expand\n-- bootstrap\n'),
    );
    const admin = new pg.Client({ connectionString: fresh.url });
    await admin.connect();
    try {
      await runMigrations({ databaseUrl: fresh.url, direction: 'up', count: 1, dir });
      await admin.query(`grant all on public.${MIGRATIONS_TABLE} to ujira_migrator`);
      await admin.query('grant all on all sequences in schema public to ujira_migrator');
      const url = roleUrl(roleUrls, 'ujira_migrator', fresh.name);
      const first = await runMigrations({ databaseUrl: url, direction: 'up', count: 1, dir });
      expect(first.names).toEqual(['1000000000001_plain']);
      await expect(
        runMigrations({ databaseUrl: url, direction: 'up', dir }),
      ).rejects.toBeInstanceOf(MigrationLoginError);
      const rest = await runMigrations({ databaseUrl: fresh.url, direction: 'up', dir });
      expect(rest.names).toEqual(['1000000000002_needs_bootstrap']);
    } finally {
      await admin.end();
      await fresh.drop();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('refuses the same superuser URL for both logins', async () => {
    const fresh = await emptied('same');
    const dir = fixtures();
    try {
      await expect(
        runMigrationsByFile({
          bootstrapUrl: fresh.url,
          migratorUrl: fresh.url,
          direction: 'up',
          dir,
        }),
      ).rejects.toBeInstanceOf(MigrationLoginError);
    } finally {
      await fresh.drop();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('runs a fixture folder through both logins, and back down', async () => {
    const fresh = await emptied('both');
    const dir = fixtures();
    const options = {
      bootstrapUrl: fresh.url,
      migratorUrl: roleUrl(roleUrls, 'ujira_migrator', fresh.name),
      dir,
    };
    try {
      const up = await runMigrationsByFile({ ...options, direction: 'up' });
      expect(up.names).toEqual(['1000000000000_needs_bootstrap', '1000000000001_plain']);
      expect(await recorded(fresh)).toBe(2);
      const down = await runMigrationsByFile({ ...options, direction: 'down', count: 2 });
      expect(down.names).toEqual(['1000000000001_plain', '1000000000000_needs_bootstrap']);
      expect(await recorded(fresh)).toBe(0);
    } finally {
      await fresh.drop();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('refuses a second run while one holds the lock', async () => {
    const fresh = await emptied('lock');
    const dir = fixtures();
    const holder = new pg.Client({ connectionString: fresh.url });
    await holder.connect();
    try {
      await holder.query('select pg_advisory_lock(7330214)');
      await expect(
        runMigrationsByFile({
          bootstrapUrl: fresh.url,
          migratorUrl: roleUrl(roleUrls, 'ujira_migrator', fresh.name),
          direction: 'up',
          dir,
        }),
      ).rejects.toThrow('Another migration is already running');
    } finally {
      await holder.end();
      await fresh.drop();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

describe('which files need the bootstrap login', () => {
  it('the marked ones do, and the rest of the folder does not', () => {
    for (const name of realFiles()) {
      const source = parseMigration(name, readFileSync(join(MIGRATIONS_DIR, name), 'utf8'));
      expect(needsBootstrap(`${source.up}\n${source.down}`), name).toBe(
        migrationLogin(source) === 'bootstrap',
      );
    }
  });

  it('reads role work inside a block, and does not read it in a comment', () => {
    expect(needsBootstrap('do $x$ begin create role a nologin; end $x$;')).toBe(true);
    expect(needsBootstrap('grant ujira_fn_a to ujira_owner;')).toBe(true);
    expect(needsBootstrap('create schema ops;')).toBe(true);
    expect(needsBootstrap('-- create role a\nselect 1;')).toBe(false);
    expect(needsBootstrap('grant select on ujira.a to ujira_app;')).toBe(false);
  });

  it('takes the marker on the second line only', () => {
    const body = '-- Up Migration\nselect 1;\n\n-- Down Migration\nselect 1;\n';
    const loginOf = (name: string, source: string) => migrationLogin(parseMigration(name, source));
    expect(loginOf('1_a.sql', `-- expand\n-- bootstrap\n\n${body}`)).toBe('bootstrap');
    expect(loginOf('1_a.sql', `-- expand\n\n${body}`)).toBe('migrator');
    expect(loginOf('1_a.sql', `-- expand\n-- no-transaction\n\n${body}`)).toBe('migrator');
    expect(loginOf('1_a.sql', `-- expand\n\n-- bootstrap\n${body}`)).toBe('migrator');
  });
});
