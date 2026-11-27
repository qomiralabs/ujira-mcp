// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The migration step a server process runs before any of its roles starts, so
// the web role takes traffic only on a schema that is up to date.
//
// With no database configured it does nothing, and the server starts exactly
// as it did before there was a database. With one, it runs every pending
// migration up, with the logins and the pinned TLS the command line uses, and
// any failure stops the process before it listens. The host's health check
// then never passes, the deploy fails, and the previous release keeps serving.
//
// Several instances may start at once, so each waits for the migration lock
// rather than failing on it: one runs the migrations and the others find
// nothing left to do. The wait is bounded, so an instance stuck behind a run
// that hangs fails its deploy instead of never starting.
//
// Messages name a variable, never its value: the URLs carry passwords.

import { migrationTransport, type CliEnvironment } from './migrate-cli.js';
import { runMigrations, runMigrationsByFile } from './migrate.js';

/** How long a starting instance waits for another instance's run to finish. */
export const START_LOCK_WAIT_MS = 300_000;

const URL_KEYS = ['UJIRA_DB_MIGRATOR_URL', 'UJIRA_DB_BOOTSTRAP_URL'] as const;

/** The migration step refused to run, or ran and failed. The message is safe to print. */
export class MigrationStartError extends Error {
  override readonly name = 'MigrationStartError';
}

export type StartMigration =
  { readonly ran: false } | { readonly ran: true; readonly names: readonly string[] };

/** The two runners, replaceable so the decisions here are tested without a database. */
export interface MigrationRunners {
  readonly runMigrations: typeof runMigrations;
  readonly runMigrationsByFile: typeof runMigrationsByFile;
}

export interface StartMigrationOptions {
  readonly log: (line: string) => void;
  readonly lockWaitMs?: number;
  // Another folder of migrations, for tests. The server runs MIGRATIONS_DIR.
  readonly dir?: string;
  readonly runners?: MigrationRunners;
}

const given = (value: string | undefined): value is string => value !== undefined && value !== '';

/**
 * Runs the pending migrations up before the server starts, or does nothing
 * when UJIRA_DB_MIGRATOR_URL is unset. Throws MigrationStartError when the
 * settings are wrong or the run fails; the caller exits non zero.
 */
export async function migrateBeforeStart(
  env: CliEnvironment,
  options: StartMigrationOptions,
): Promise<StartMigration> {
  const migratorUrl = env['UJIRA_DB_MIGRATOR_URL'];
  const bootstrapUrl = env['UJIRA_DB_BOOTSTRAP_URL'];
  if (!given(migratorUrl)) {
    // A bootstrap login alone is a half configured database, not none.
    if (given(bootstrapUrl)) {
      throw new MigrationStartError(
        'migrations refused: UJIRA_DB_BOOTSTRAP_URL is set without UJIRA_DB_MIGRATOR_URL',
      );
    }
    options.log('migrations skipped: UJIRA_DB_MIGRATOR_URL is not set');
    return { ran: false };
  }
  const transport = migrationTransport(env, URL_KEYS);
  if (!transport.ok) throw new MigrationStartError(`migrations refused: ${transport.message}`);

  const runners = options.runners ?? { runMigrations, runMigrationsByFile };
  const shared = {
    direction: 'up',
    lockMode: 'wait',
    lockWaitMs: options.lockWaitMs ?? START_LOCK_WAIT_MS,
    log: (line: string) => {
      options.log(`migrate: ${line}`);
    },
    ...(transport.tls === undefined ? {} : { tls: transport.tls }),
    ...(options.dir === undefined ? {} : { dir: options.dir }),
  } as const;
  options.log(
    given(bootstrapUrl)
      ? 'migrations starting, each file under the login it names'
      : 'migrations starting, under the migrator login',
  );
  let names: readonly string[];
  try {
    const run = given(bootstrapUrl)
      ? await runners.runMigrationsByFile({ ...shared, bootstrapUrl, migratorUrl })
      : await runners.runMigrations({ ...shared, databaseUrl: migratorUrl });
    names = run.names;
  } catch (error) {
    // The message only, and no cause: a driver error object can carry its
    // connection settings, and anything that printed it whole would print them.
    const reason = error instanceof Error ? error.message : 'the migration run failed';
    throw new MigrationStartError(`migrations failed: ${reason}`);
  }
  options.log(
    names.length === 0
      ? 'migrations up to date, nothing to run'
      : `migrations applied ${String(names.length)}: ${names.join(', ')}`,
  );
  return { ran: true, names };
}
