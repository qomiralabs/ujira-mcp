// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The command line, run in process against an empty database, the way
// `npm run db:migrate -- up` and `down` run against a fresh Postgres.

import { readdirSync } from 'node:fs';

import pg from 'pg';
import { afterEach, describe, expect, inject, it } from 'vitest';

import { main, type CliOutput } from './migrate-cli.js';
import { MIGRATIONS_DIR, MIGRATIONS_TABLE } from './migrate.js';
import { createTestDatabase, roleUrl, withDatabase, type TestDatabase } from './testing/harness.js';

const adminUrl = inject('dbAdminUrl');
const roleUrls = inject('dbRoleUrls');

const databases: TestDatabase[] = [];

// Every committed migration, so a run from empty is checked against the
// folder rather than against a count that each new migration would break.
const ALL = String(readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith('.sql')).length);

afterEach(async () => {
  await Promise.all(databases.splice(0).map((database) => database.drop()));
});

interface Captured extends CliOutput {
  readonly lines: string[];
  readonly errors: string[];
}

function capture(): Captured {
  const lines: string[] = [];
  const errors: string[] = [];
  return {
    lines,
    errors,
    out: (line) => {
      lines.push(line);
    },
    err: (line) => {
      errors.push(line);
    },
  };
}

async function empty(label: string): Promise<TestDatabase> {
  const database = await createTestDatabase(adminUrl, `${import.meta.url}#${label}`, {
    empty: true,
  });
  databases.push(database);
  return database;
}

async function schemaExists(url: string): Promise<boolean> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const { rows } = await client.query<{ found: boolean }>(
      `select exists (select from pg_namespace where nspname = 'ujira') as found`,
    );
    return rows[0]?.found === true;
  } finally {
    await client.end();
  }
}

describe('npm run db:migrate', () => {
  it.each([
    [[], 'usage'],
    [['sideways'], 'usage'],
    [['up', '1', 'extra'], 'usage'],
    [['down', '0'], 'whole number'],
    [['down', '1.5'], 'whole number'],
  ])('refuses %j before touching a database', async (argv, expected) => {
    const output = capture();
    expect(await main(argv, {}, output)).toBe(1);
    expect(output.errors.join('\n')).toContain(expected);
  });

  it('refuses to run without a database URL', async () => {
    const output = capture();
    expect(await main(['up'], { UJIRA_DB_MIGRATOR_URL: '' }, output)).toBe(1);
    expect(output.errors.join('\n')).toContain('UJIRA_DB_MIGRATOR_URL');
  });

  it('runs up and down from an empty Postgres with no error', async () => {
    const database = await empty('superuser');
    const env = { UJIRA_DB_TLS: 'off', UJIRA_DB_MIGRATOR_URL: database.url };
    const up = capture();
    expect(await main(['up'], env, up)).toBe(0);
    expect(up.errors).toEqual([]);
    expect(up.lines.at(-1)).toMatch(
      new RegExp(String.raw`^db:migrate: up applied ${ALL} migration\(s\) recorded in `),
    );
    expect(await schemaExists(database.url)).toBe(true);

    const again = capture();
    expect(await main(['up'], env, again)).toBe(0);
    expect(again.lines.at(-1)).toBe(`db:migrate: nothing to do, ${MIGRATIONS_TABLE} is up to date`);

    const down = capture();
    expect(await main(['down', ALL], env, down)).toBe(0);
    expect(down.errors).toEqual([]);
    expect(await schemaExists(database.url)).toBe(false);
  });

  it('runs each file under its own login when a bootstrap URL is given', async () => {
    const database = await empty('two-logins');
    const env = {
      UJIRA_DB_TLS: 'off',
      UJIRA_DB_BOOTSTRAP_URL: database.url,
      UJIRA_DB_MIGRATOR_URL: roleUrl(roleUrls, 'ujira_migrator', database.name),
    };
    const up = capture();
    expect(await main(['up'], env, up)).toBe(0);
    expect(up.errors).toEqual([]);
    expect(await schemaExists(database.url)).toBe(true);
    const down = capture();
    expect(await main(['down', ALL], env, down)).toBe(0);
    expect(down.errors).toEqual([]);
    expect(await schemaExists(database.url)).toBe(false);
  });

  it('pins TLS unless told otherwise, so a server without TLS is refused', async () => {
    // The test container speaks no TLS. With UJIRA_DB_TLS unset the run asks
    // for it, verified against the pinned roots, and stops before anything.
    const database = await empty('pinned');
    const output = capture();
    expect(await main(['up'], { UJIRA_DB_MIGRATOR_URL: database.url }, output)).toBe(1);
    expect(output.errors.join('\n')).toContain('db:migrate: ');
    expect(await schemaExists(database.url)).toBe(false);
  });

  it('reports a failed run by its message, with no URL in it', async () => {
    const output = capture();
    const missing = withDatabase(adminUrl, 'no_such_database');
    expect(
      await main(['up'], { UJIRA_DB_TLS: 'off', UJIRA_DB_MIGRATOR_URL: missing }, output),
    ).toBe(1);
    const printed = output.errors.join('\n');
    const url = new URL(missing);
    expect(printed).toContain('db:migrate: ');
    expect(printed).not.toContain(decodeURIComponent(url.password));
    expect(printed).not.toContain(url.host);
  });
});
