// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// Runs the database migrations from the command line, through runMigrations,
// so the command line and the code paths share one ledger.
//
//   npm run db:migrate -- up [count]
//   npm run db:migrate -- down [count]
//
// A real database takes two URLs: UJIRA_DB_BOOTSTRAP_URL for the migrations
// that create a schema or administer roles, and UJIRA_DB_MIGRATOR_URL for the
// rest. Each file says which it needs, and the runner refuses the wrong login.
// A local container takes one, a superuser's, in UJIRA_DB_MIGRATOR_URL.
// Nothing here reads the full database config: a migration runs before the
// services exist.
//
// ujira_migrator has to be able to log in before the first file it runs. The
// migrations never set a password, so provisioning does, and a run that stops
// there resumes.

import { pathToFileURL } from 'node:url';

import { MIGRATIONS_TABLE, runMigrations, runMigrationsByFile } from './migrate.js';

export interface CliOutput {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

export type CliEnvironment = Readonly<Record<string, string | undefined>>;

const USAGE = 'usage: npm run db:migrate -- up|down [count]';

// Returns the exit code. The URLs are never printed: they carry passwords.
export async function main(
  argv: readonly string[],
  env: CliEnvironment,
  output: CliOutput,
): Promise<number> {
  const fail = (message: string): number => {
    output.err(`db:migrate: ${message}`);
    return 1;
  };
  const [direction, countArgument, ...rest] = argv;
  if ((direction !== 'up' && direction !== 'down') || rest.length > 0) return fail(USAGE);
  if (countArgument !== undefined && !/^[1-9][0-9]*$/.test(countArgument)) {
    return fail('the count must be a whole number of at least 1');
  }
  const migratorUrl = env['UJIRA_DB_MIGRATOR_URL'];
  if (migratorUrl === undefined || migratorUrl === '') {
    return fail('set UJIRA_DB_MIGRATOR_URL to the database to migrate');
  }
  const bootstrapUrl = env['UJIRA_DB_BOOTSTRAP_URL'];
  const count = countArgument === undefined ? undefined : Number.parseInt(countArgument, 10);
  const shared = {
    direction,
    log: output.out,
    ...(count === undefined ? {} : { count }),
  } as const;
  let names: readonly string[];
  try {
    const run =
      bootstrapUrl === undefined || bootstrapUrl === ''
        ? await runMigrations({ ...shared, databaseUrl: migratorUrl })
        : await runMigrationsByFile({ ...shared, bootstrapUrl, migratorUrl });
    names = run.names;
  } catch (error) {
    // The message only: a driver error object can carry its connection
    // settings, and printing it whole would print them.
    return fail(error instanceof Error ? error.message : 'the migration run failed');
  }
  output.out(
    names.length === 0
      ? `db:migrate: nothing to do, ${MIGRATIONS_TABLE} is up to date`
      : `db:migrate: ${direction} applied ${String(names.length)} migration(s) recorded in ${MIGRATIONS_TABLE}: ${names.join(', ')}`,
  );
  return 0;
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  process.exitCode = await main(process.argv.slice(2), process.env, {
    out: (line) => {
      process.stdout.write(`${line}\n`);
    },
    err: (line) => {
      process.stderr.write(`${line}\n`);
    },
  });
}
