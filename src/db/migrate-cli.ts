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
// The connection is protected the way the services' is: TLS verified against
// the roots pinned in tls.ts, unless UJIRA_DB_TLS=off, which is accepted only
// when every URL names a loopback host. A URL may not carry an ssl parameter,
// because pg lets one replace the trust it is given. Neither URL may name a
// transaction pooler port: the migration lock is held in the session.
//
// ujira_migrator has to be able to log in before the first file it runs. The
// migrations never set a password, so provisioning does, and a run that stops
// there resumes.

import { pathToFileURL } from 'node:url';

import {
  MIGRATIONS_TABLE,
  runMigrations,
  runMigrationsByFile,
  type MigrationTls,
} from './migrate.js';
import { PINNED_TLS } from './tls.js';

export interface CliOutput {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

export type CliEnvironment = Readonly<Record<string, string | undefined>>;

const USAGE = 'usage: npm run db:migrate -- up|down [count]';

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

// PgBouncer, where Render runs it, and Supavisor.
const TRANSACTION_POOLER_PORTS: ReadonlySet<string> = new Set(['6432', '6543']);

export type MigrationTransport =
  | { readonly ok: true; readonly tls: MigrationTls | undefined }
  | { readonly ok: false; readonly message: string };

// Decides how the run connects, from the URLs it was given. Messages name the
// variable, never its value, which carries a password.
export function migrationTransport(
  env: CliEnvironment,
  keys: readonly string[],
): MigrationTransport {
  const mode = env['UJIRA_DB_TLS'] ?? '';
  if (mode !== '' && mode !== 'pinned' && mode !== 'off') {
    return { ok: false, message: "UJIRA_DB_TLS must be 'pinned' or 'off'" };
  }
  for (const key of keys) {
    const raw = env[key];
    if (raw === undefined || raw === '') continue;
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      return { ok: false, message: `${key} is not a URL` };
    }
    for (const name of parsed.searchParams.keys()) {
      if (name.toLowerCase().startsWith('ssl')) {
        return {
          ok: false,
          message: `${key} must not set ${name}: TLS trust is pinned in src/db/tls.ts, and an ssl parameter would replace or disable it`,
        };
      }
    }
    if (TRANSACTION_POOLER_PORTS.has(parsed.port)) {
      return {
        ok: false,
        message: `${key} must not use the transaction pooler port ${parsed.port}: the migration lock is held in the session, so connect directly on 5432`,
      };
    }
    if (mode === 'off' && !LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase())) {
      return {
        ok: false,
        message: `UJIRA_DB_TLS=off is only allowed for a loopback host, and ${key} names another host`,
      };
    }
  }
  return { ok: true, tls: mode === 'off' ? undefined : PINNED_TLS };
}

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
  const transport = migrationTransport(env, ['UJIRA_DB_MIGRATOR_URL', 'UJIRA_DB_BOOTSTRAP_URL']);
  if (!transport.ok) return fail(transport.message);
  const count = countArgument === undefined ? undefined : Number.parseInt(countArgument, 10);
  const shared = {
    direction,
    log: output.out,
    ...(count === undefined ? {} : { count }),
    ...(transport.tls === undefined ? {} : { tls: transport.tls }),
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
