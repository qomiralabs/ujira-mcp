// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// What the migration step decides before it reaches a database: whether to run
// at all, which runner and which logins, and what it reports. The runners are
// stand ins here; migrate-start-concurrent.test.ts runs the real ones.

import { describe, expect, it } from 'vitest';

import type { MigrateOptions, MigrationRun, TwoLoginMigrateOptions } from './migrate.js';
import {
  migrateBeforeStart,
  MigrationStartError,
  START_LOCK_WAIT_MS,
  type MigrationRunners,
} from './migrate-start.js';
import { PINNED_TLS } from './tls.js';

const PASSWORD = 'not-a-real-password-7f3a';
const MIGRATOR = `postgresql://ujira_migrator:${PASSWORD}@db.example.test:5432/ujira`;
const BOOTSTRAP = `postgresql://owner:${PASSWORD}@db.example.test:5432/ujira`;

interface Calls {
  readonly single: MigrateOptions[];
  readonly byFile: TwoLoginMigrateOptions[];
}

function fakeRunners(result: MigrationRun | Error = { names: [] }): {
  runners: MigrationRunners;
  calls: Calls;
} {
  const calls: Calls = { single: [], byFile: [] };
  const answer = (): Promise<MigrationRun> =>
    result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
  return {
    calls,
    runners: {
      runMigrations: (options) => {
        calls.single.push(options);
        options.log?.('### MIGRATION 1800000000021_example (UP) ###');
        return answer();
      },
      runMigrationsByFile: (options) => {
        calls.byFile.push(options);
        return answer();
      },
    },
  };
}

function lines(): { log: (line: string) => void; seen: string[] } {
  const seen: string[] = [];
  return {
    seen,
    log: (line) => {
      seen.push(line);
    },
  };
}

describe('migrateBeforeStart', () => {
  it.each([
    ['unset', {}],
    ['empty', { UJIRA_DB_MIGRATOR_URL: '', UJIRA_DB_BOOTSTRAP_URL: '' }],
  ])(
    'does nothing when the migrator URL is %s, so a server with no database starts as before',
    async (_, env) => {
      const { runners, calls } = fakeRunners();
      const out = lines();
      expect(await migrateBeforeStart(env, { log: out.log, runners })).toEqual({ ran: false });
      expect(calls.single).toEqual([]);
      expect(calls.byFile).toEqual([]);
      expect(out.seen).toEqual(['migrations skipped: UJIRA_DB_MIGRATOR_URL is not set']);
    },
  );

  it('refuses a bootstrap URL without a migrator URL, naming the variables only', async () => {
    const { runners, calls } = fakeRunners();
    const run = migrateBeforeStart(
      { UJIRA_DB_BOOTSTRAP_URL: BOOTSTRAP },
      { log: lines().log, runners },
    );
    await expect(run).rejects.toThrow(MigrationStartError);
    await expect(run).rejects.toThrow(
      'migrations refused: UJIRA_DB_BOOTSTRAP_URL is set without UJIRA_DB_MIGRATOR_URL',
    );
    expect(calls.single).toEqual([]);
  });

  it('runs every pending migration up under the migrator, waiting for the lock, over pinned TLS', async () => {
    const { runners, calls } = fakeRunners({ names: ['1800000000020_a', '1800000000021_b'] });
    const out = lines();
    const result = await migrateBeforeStart(
      { UJIRA_DB_MIGRATOR_URL: MIGRATOR },
      { log: out.log, runners },
    );
    expect(result).toEqual({ ran: true, names: ['1800000000020_a', '1800000000021_b'] });
    expect(calls.byFile).toEqual([]);
    expect(calls.single).toHaveLength(1);
    expect(calls.single[0]).toMatchObject({
      databaseUrl: MIGRATOR,
      direction: 'up',
      lockMode: 'wait',
      lockWaitMs: START_LOCK_WAIT_MS,
      tls: PINNED_TLS,
    });
    expect(calls.single[0]).not.toHaveProperty('count');
    expect(out.seen).toEqual([
      'migrations starting, under the migrator login',
      'migrate: ### MIGRATION 1800000000021_example (UP) ###',
      'migrations applied 2: 1800000000020_a, 1800000000021_b',
    ]);
  });

  it('runs each file under its own login when the bootstrap URL is set too', async () => {
    const { runners, calls } = fakeRunners();
    const out = lines();
    await migrateBeforeStart(
      { UJIRA_DB_MIGRATOR_URL: MIGRATOR, UJIRA_DB_BOOTSTRAP_URL: BOOTSTRAP },
      { log: out.log, runners, lockWaitMs: 1_000 },
    );
    expect(calls.single).toEqual([]);
    expect(calls.byFile[0]).toMatchObject({
      bootstrapUrl: BOOTSTRAP,
      migratorUrl: MIGRATOR,
      direction: 'up',
      lockMode: 'wait',
      lockWaitMs: 1_000,
      tls: PINNED_TLS,
    });
    expect(out.seen).toEqual([
      'migrations starting, each file under the login it names',
      'migrations up to date, nothing to run',
    ]);
  });

  it('connects without TLS only for a loopback host with UJIRA_DB_TLS=off', async () => {
    const { runners, calls } = fakeRunners();
    await migrateBeforeStart(
      {
        UJIRA_DB_TLS: 'off',
        UJIRA_DB_MIGRATOR_URL: `postgresql://ujira:${PASSWORD}@127.0.0.1:54329/ujira`,
      },
      { log: lines().log, runners, dir: '/tmp/fixture-migrations' },
    );
    expect(calls.single[0]).not.toHaveProperty('tls');
    expect(calls.single[0]).toMatchObject({ dir: '/tmp/fixture-migrations' });

    const off = migrateBeforeStart(
      { UJIRA_DB_TLS: 'off', UJIRA_DB_MIGRATOR_URL: MIGRATOR },
      { log: lines().log, runners },
    );
    await expect(off).rejects.toThrow(
      'migrations refused: UJIRA_DB_TLS=off is only allowed for a loopback host',
    );
  });

  it.each([
    ['the PgBouncer port', MIGRATOR.replace(':5432/', ':6432/'), 'transaction pooler port 6432'],
    ['an ssl parameter', `${MIGRATOR}?sslmode=disable`, 'must not set sslmode'],
    ['something that is not a URL', `not a url ${PASSWORD}`, 'is not a URL'],
  ])('refuses %s before connecting, without printing the URL', async (_, url, expected) => {
    const { runners, calls } = fakeRunners();
    const error: unknown = await migrateBeforeStart(
      { UJIRA_DB_MIGRATOR_URL: url },
      { log: lines().log, runners },
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(MigrationStartError);
    const message = (error as Error).message;
    expect(message).toContain(expected);
    expect(message).toContain('UJIRA_DB_MIGRATOR_URL');
    expect(message).not.toContain(PASSWORD);
    expect(calls.single).toEqual([]);
  });

  it('turns a failed run into one printable error, with no URL and no cause', async () => {
    const { runners } = fakeRunners(new Error('relation "nowhere" does not exist'));
    const out = lines();
    const error: unknown = await migrateBeforeStart(
      { UJIRA_DB_MIGRATOR_URL: MIGRATOR, UJIRA_DB_BOOTSTRAP_URL: BOOTSTRAP },
      { log: out.log, runners },
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(MigrationStartError);
    expect((error as Error).message).toBe('migrations failed: relation "nowhere" does not exist');
    expect((error as Error).cause).toBeUndefined();
    expect(out.seen.join('\n')).not.toContain(PASSWORD);
    expect(out.seen.at(-1)).toBe('migrations starting, each file under the login it names');
  });

  it('reports a thrown value that is not an Error in general terms', async () => {
    const runners: MigrationRunners = {
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- the case under test
      runMigrations: () => Promise.reject('boom'),
      runMigrationsByFile: () => Promise.resolve({ names: [] }),
    };
    await expect(
      migrateBeforeStart({ UJIRA_DB_MIGRATOR_URL: MIGRATOR }, { log: lines().log, runners }),
    ).rejects.toThrow('migrations failed: the migration run failed');
  });
});
