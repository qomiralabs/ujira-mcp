// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// Runs the plain SQL migrations in db/migrations. One function, and one
// ledger: `npm run db:migrate` calls src/db/migrate-cli.ts, which calls this,
// so the command line and the test harness both record into MIGRATIONS_TABLE.
//
// The migration tool's own command line records into its default table,
// pgmigrations, while this function records into ours. Both tables on one
// server, one per path, is how a migration gets applied twice or reported as
// pending after it ran. migrate.test.ts fails if the command line stops going
// through here, or if the other table ever appears.
//
// Migrations run over a session connection, never the transaction pooler:
// the tool takes a session level advisory lock so two runs cannot overlap,
// and a transaction pooler would hand each statement a different backend and
// lose the lock. migrate.test.ts measures both the lock being session held
// and what a second concurrent run does with it.
//
// Two logins run them, because no one login should hold both jobs. The bootstrap
// login creates schemas and administers roles, and needs server wide rights to. The
// migrator does everything else, and takes the owner's rights only for as long as a
// migration needs them. Each file says which it needs, and the runner refuses to run a
// file under the wrong login, so a mistake stops the deploy instead of half applying.
//
// This file imports nothing from the rest of src/db, so a script can load it
// directly under Node's type stripping, which cannot follow a sibling import
// written with a .js specifier.

import { readFile, readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runner, type MigrationBuilder, type RunnerOption } from 'node-pg-migrate';
import pg from 'pg';

// src/db and dist/db both sit two levels under the repository root.
export const MIGRATIONS_DIR = fileURLToPath(new URL('../../db/migrations', import.meta.url));

// One table, in the schema migrations themselves create, so a migration and
// its record of having run live together.
export const MIGRATIONS_TABLE = 'ujira_migrations';

// The table the migration tool would use if anything called its command
// line directly. Nothing may, and a test checks for it.
export const TOOL_DEFAULT_MIGRATIONS_TABLE = 'pgmigrations';

// Every migration says on its first line whether it only adds to the schema
// (`expand`, safe while the previous release still runs) or takes something
// away (`contract`, safe only once no running code needs it). CI treats the
// two differently: an expand migration must roll back and forward to the
// same schema, which a contract migration usually cannot.
export type MigrationKind = 'expand' | 'contract';

export const DECLARATION_LINES: Readonly<Record<MigrationKind, string>> = {
  expand: '-- expand',
  contract: '-- contract',
};

// A concurrent index build cannot run inside a transaction, and the tool's
// own SQL loader runs every file inside one. A migration that needs to run
// outside says so on its second line, and then holds a single statement.
export const NO_TRANSACTION_LINE = '-- no-transaction';
// Owns every object in the schema. The roles migration creates it.
export const MIGRATION_OWNER_ROLE = 'ujira_owner';
// A migration that creates a schema or administers roles says so on its second line, and
// runs under the bootstrap login. Every other migration runs under the migrator.
// migrations.test.ts refuses a file that needs the marker and does not carry it.
export const BOOTSTRAP_LINE = '-- bootstrap';
export const UP_MARKER = '-- Up Migration';
export const DOWN_MARKER = '-- Down Migration';

export type MigrationLogin = 'bootstrap' | 'migrator';

// How a run protects its connection. The command line passes the pinned trust from tls.ts
// for any real host; left out, the connection has no TLS, which only a local container or a
// test database accepts. Declared here rather than imported, so this file still imports
// nothing from the rest of src/db; PINNED_TLS has this shape.
export interface MigrationTls {
  readonly ca: string;
  readonly rejectUnauthorized: true;
  readonly minVersion: 'TLSv1.2';
}

// What pg is given for one login. A copy of the trust, because pg may write to the object.
function clientConfig(url: string, tls: MigrationTls | undefined): pg.ClientConfig {
  return tls === undefined ? { connectionString: url } : { connectionString: url, ssl: { ...tls } };
}

// What only the bootstrap login can do. Comments are taken out first, and do blocks are
// read too, because most role work is inside one.
export const BOOTSTRAP_STATEMENT =
  /\b(?:create|alter|drop)\s+role\b|\bgrant\s+ujira_\w+\s+to\b|\brevoke\s+ujira_\w+\s+from\b|\bcreate\s+schema\b|\bdrop\s+schema\b/i;

export function needsBootstrap(sql: string): boolean {
  return BOOTSTRAP_STATEMENT.test(sql.replace(/--[^\n]*/g, ''));
}

/** A migration and the login running it disagree, or the login is not what it claims. */
export class MigrationLoginError extends Error {
  override readonly name = 'MigrationLoginError';
}

export interface MigrationSource {
  readonly name: string;
  readonly kind: MigrationKind;
  readonly transactional: boolean;
  // Left out on a plain file rather than false, because this runner ships ahead of the
  // code it deploys, and that code's tests compare parsed files whole.
  readonly bootstrap?: true;
  // Each section starts at its marker line, so a line number in it is the
  // line number in the file minus the section's offset.
  readonly up: string;
  readonly upLine: number;
  readonly down: string;
  readonly downLine: number;
}

export class MigrationFileError extends Error {
  override readonly name = 'MigrationFileError';
}

// Exact lines only. The tool's own loader also accepts loose spellings of
// the section markers, such as `--up migration`; one spelling means the CI
// checks and the runner can never read the same file two ways.
export function parseMigration(name: string, source: string): MigrationSource {
  const lines = source.split('\n').map((line) => line.replace(/\r$/, ''));
  const first = lines[0];
  const kind = (['expand', 'contract'] as const).find(
    (candidate) => DECLARATION_LINES[candidate] === first,
  );
  if (kind === undefined) {
    throw new MigrationFileError(
      `${name}: the first line must be "${DECLARATION_LINES.expand}" or "${DECLARATION_LINES.contract}"`,
    );
  }
  const ups = lines.flatMap((line, index) => (line === UP_MARKER ? [index] : []));
  const downs = lines.flatMap((line, index) => (line === DOWN_MARKER ? [index] : []));
  const [up] = ups;
  const [down] = downs;
  if (up === undefined || down === undefined || ups.length > 1 || downs.length > 1) {
    throw new MigrationFileError(
      `${name}: needs exactly one "${UP_MARKER}" line and one "${DOWN_MARKER}" line`,
    );
  }
  if (down < up) {
    throw new MigrationFileError(`${name}: "${UP_MARKER}" must come before "${DOWN_MARKER}"`);
  }
  return {
    name,
    kind,
    transactional: lines[1] !== NO_TRANSACTION_LINE,
    ...(lines[1] === BOOTSTRAP_LINE ? { bootstrap: true as const } : {}),
    up: lines.slice(up, down).join('\n').trimEnd(),
    upLine: up + 1,
    down: lines.slice(down).join('\n').trimEnd(),
    downLine: down + 1,
  };
}

export function migrationLogin(migration: MigrationSource): MigrationLogin {
  return migration.bootstrap === true ? 'bootstrap' : 'migrator';
}

// Only a login that does not already hold the owner's rights takes the role. An admin
// who does keeps its own identity, so an object it owns is still its own to index, and a
// fixture folder that runs before the role exists still works. Set outside a transaction,
// the role outlasts this block. A login that is not a member is refused here, loudly.
const TAKE_OWNER_ROLE = `do $take_role$
begin
  if exists (select from pg_catalog.pg_roles where rolname = '${MIGRATION_OWNER_ROLE}')
     and not pg_catalog.pg_has_role(current_user, '${MIGRATION_OWNER_ROLE}', 'USAGE') then
    set role ${MIGRATION_OWNER_ROLE};
  end if;
end
$take_role$`;

function actionFor(
  migration: MigrationSource,
  sql: string,
  transactional: boolean,
  login: MigrationLogin | undefined,
): (pgm: MigrationBuilder) => void {
  return (pgm) => {
    if (login !== undefined && migrationLogin(migration) !== login) {
      throw new MigrationLoginError(
        `${migration.name} needs the ${migrationLogin(migration)} login, and this run is the ${login}`,
      );
    }
    if (transactional) {
      pgm.sql(sql);
      return;
    }
    // The tool then commits the run's transaction, sends each of these on its
    // own and opens a new transaction for the migrations after it. The migrator
    // logs in without the owner's rights and a transactional migration takes them
    // with `set local role`, but a concurrent index build cannot be in a block
    // that could set a role for it. So the role is taken for the session instead,
    // and reset before the tool records the migration, which it does as the login.
    // If the statement fails the run stops and the connection goes with it.
    pgm.noTransaction();
    pgm.sql(TAKE_OWNER_ROLE);
    pgm.sql(sql);
    pgm.sql('reset role');
  };
}

function sqlMigrationsLoader(login: MigrationLogin | undefined) {
  return async (filePaths: string[]) =>
    Promise.all(
      filePaths.map(async (filePath) => {
        const migration = parseMigration(basename(filePath), await readFile(filePath, 'utf8'));
        return {
          id: filePath,
          filePaths: [filePath],
          actions: {
            up: actionFor(migration, migration.up, migration.transactional, login),
            down: actionFor(migration, migration.down, migration.transactional, login),
          },
        };
      }),
    );
}

interface LoginRights {
  readonly superuser: boolean;
  readonly createRole: boolean;
}

async function withConnection<T>(
  url: string,
  tls: MigrationTls | undefined,
  work: (client: pg.Client) => Promise<T>,
): Promise<T> {
  const client = new pg.Client(clientConfig(url, tls));
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

async function rightsOf(url: string, tls: MigrationTls | undefined): Promise<LoginRights> {
  return withConnection(url, tls, async (client) => {
    const { rows } = await client.query<{ rolsuper: boolean; rolcreaterole: boolean }>(
      'select rolsuper, rolcreaterole from pg_catalog.pg_roles where rolname = current_user',
    );
    return {
      superuser: rows[0]?.rolsuper === true,
      createRole: rows[0]?.rolcreaterole === true,
    };
  });
}

// A run says which login it is, and the server says whether that is true, so a URL pasted
// into the wrong variable stops here. Naming nothing leaves a superuser free, as a test or
// a local container on a disposable database is. Anyone else is taken for the migrator,
// the least a login can be, so naming nothing can never get a marked file run.
async function settleLogin(
  url: string,
  named: MigrationLogin | undefined,
  tls: MigrationTls | undefined,
): Promise<MigrationLogin | undefined> {
  const rights = await rightsOf(url, tls);
  if (named === undefined && rights.superuser) return undefined;
  const administers = rights.superuser || rights.createRole;
  const login = named ?? 'migrator';
  if (login === 'bootstrap' && !administers) {
    throw new MigrationLoginError('the bootstrap login cannot create roles');
  }
  if (login === 'migrator' && administers) {
    throw new MigrationLoginError('the migrator login holds more rights than its job needs');
  }
  return login;
}

export type MigrationDirection = 'up' | 'down';

// What a run does when another run already holds the lock. `fail` is the
// tool's default and this module's: a second run stops at once with
// "Another migration is already running", which is measured in
// migrate.test.ts. `wait` keeps trying until the lock frees, which is what a
// deployment that migrates from several instances at boot would need.
export type LockMode = 'fail' | 'wait';

// How long a waiting run sleeps between tries for the lock.
const LOCK_RETRY_MS = 250;

// A run that waits never blocks inside a statement for the lock. A concurrent index
// build waits for every transaction open while it runs, and a statement waiting for the
// lock is one, so the run holding the lock would wait for the run waiting for it. Two
// would deadlock, and where the lock is held on another connection than the build, nothing
// would ever notice and they would wait forever. So it tries, and sleeps with nothing open
// between tries.
async function untilFree<T>(
  attempt: () => Promise<T>,
  busy: (error: unknown) => boolean,
): Promise<T> {
  for (;;) {
    try {
      return await attempt();
    } catch (error) {
      if (!busy(error)) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
  }
}

const lockTaken = (error: unknown): boolean =>
  error instanceof Error && error.message.startsWith('Another migration is already running');

export interface MigrateOptions {
  readonly databaseUrl: string;
  readonly direction: MigrationDirection;
  // `down` without a count would undo everything, which is never what a
  // command meant to step back one migration wants.
  readonly count?: number;
  readonly lockMode?: LockMode;
  // Which login this URL is. A file that needs the other one is refused. Left out, a
  // superuser may run anything, and any other login is taken for the migrator.
  readonly login?: MigrationLogin;
  // Left out, the connection has no TLS. See MigrationTls.
  readonly tls?: MigrationTls;
  readonly log?: (message: string) => void;
  // Another folder of migrations, for tests that need a fixture. Everything
  // real runs from MIGRATIONS_DIR.
  readonly dir?: string;
}

export interface MigrationRun {
  readonly names: readonly string[];
}

export async function runMigrations(options: MigrateOptions): Promise<MigrationRun> {
  const quiet = (): void => {
    // The tool is chatty; callers pass `log` when they want its output.
  };
  const log = options.log ?? quiet;
  // `down` with no count would undo every migration, which is never what a
  // command meant to step back one wants. `up` with no count runs them all.
  const count = options.count ?? (options.direction === 'down' ? 1 : undefined);
  const login = await settleLogin(options.databaseUrl, options.login, options.tls);
  const runnerOptions: RunnerOption = {
    databaseUrl: clientConfig(options.databaseUrl, options.tls),
    dir: options.dir ?? MIGRATIONS_DIR,
    migrationsTable: MIGRATIONS_TABLE,
    direction: options.direction,
    migrationLoaderStrategies: [{ extensions: ['.sql'], loader: sqlMigrationsLoader(login) }],
    // Every transactional migration runs inside one transaction, so a
    // failure leaves the schema as it was. A `-- no-transaction` migration
    // breaks it: what ran before it is committed first.
    singleTransaction: true,
    // Each file is checked in order; a file inserted behind one that has
    // already run is a mistake worth stopping on.
    checkOrder: true,
    verbose: false,
    // Measured: with this at its default, a second concurrent run throws
    // rather than queueing. Loud is right for a migration run by hand or by
    // one deploy step; a deployment that migrates from every instance at
    // boot would pass 'wait', which is done below by trying again, never by
    // the tool's own wait, which blocks in a statement.
    advisoryLockMode: 'fail',
    logger: {
      debug: quiet,
      info: (message: string) => {
        log(message);
      },
      warn: (message: string) => {
        log(message);
      },
      error: (message: string) => {
        log(message);
      },
    },
    ...(count === undefined ? {} : { count }),
  };
  // The tool takes its lock before it touches anything, so a try that finds it taken has
  // done nothing to undo.
  const applied =
    options.lockMode === 'wait'
      ? await untilFree(() => runner(runnerOptions), lockTaken)
      : await runner(runnerOptions);
  return { names: applied.map((migration) => migration.name) };
}

export interface TwoLoginMigrateOptions {
  // Creates schemas and administers roles. Needs CREATEROLE or to be a superuser.
  readonly bootstrapUrl: string;
  // Everything else. Holds neither right.
  readonly migratorUrl: string;
  readonly direction: MigrationDirection;
  readonly count?: number;
  readonly lockMode?: LockMode;
  // One trust for both logins: they reach the same server.
  readonly tls?: MigrationTls;
  readonly log?: (message: string) => void;
  readonly dir?: string;
}

// Any number that is this file's own. The tool's lock covers one file at a time here, and
// this one keeps a second run from slipping in between them.
const RUN_LOCK_KEY = 7_330_214;

async function appliedNames(client: pg.Client): Promise<string[]> {
  const { rows: found } = await client.query<{ table: string | null }>(
    `select to_regclass('public.${MIGRATIONS_TABLE}')::text as table`,
  );
  if (found[0]?.table == null) return [];
  const { rows } = await client.query<{ name: string }>(
    `select name from public.${MIGRATIONS_TABLE} order by run_on desc, id desc`,
  );
  return rows.map((row) => row.name);
}

// The migrator records its own migrations in a table the bootstrap login created. Run
// after each bootstrap file, because the role does not exist until one of them makes it.
async function letMigratorRecord(client: pg.Client): Promise<void> {
  await client.query(`
    do $grant_ledger$
    begin
      if exists (select from pg_catalog.pg_roles where rolname = 'ujira_migrator') then
        grant select, insert, delete on public.${MIGRATIONS_TABLE} to ujira_migrator;
        grant usage, select on sequence public.${MIGRATIONS_TABLE}_id_seq to ujira_migrator;
      end if;
    end
    $grant_ledger$
  `);
}

/**
 * Runs each file under the login it says it needs, in order, and stops at the first
 * failure. This is how a real database is migrated: a rerun picks up where it stopped.
 */
export async function runMigrationsByFile(options: TwoLoginMigrateOptions): Promise<MigrationRun> {
  const dir = options.dir ?? MIGRATIONS_DIR;
  await settleLogin(options.bootstrapUrl, 'bootstrap', options.tls);
  const shared = {
    direction: options.direction,
    dir,
    ...(options.log === undefined ? {} : { log: options.log }),
    ...(options.lockMode === undefined ? {} : { lockMode: options.lockMode }),
    ...(options.tls === undefined ? {} : { tls: options.tls }),
  };
  return withConnection(options.bootstrapUrl, options.tls, async (client) => {
    const take = async (): Promise<void> => {
      const lock = await client.query<{ got: boolean }>('select pg_try_advisory_lock($1) as got', [
        RUN_LOCK_KEY,
      ]);
      if (lock.rows[0]?.got !== true) throw new Error('Another migration is already running');
    };
    await (options.lockMode === 'wait' ? untilFree(take, lockTaken) : take());

    const files = (await readdir(dir)).filter((name) => name.endsWith('.sql')).sort();
    const applied = await appliedNames(client);
    const stem = (file: string) => file.replace(/\.sql$/, '');
    // `down` with no count steps back one, as it does in runMigrations.
    const chosen =
      options.direction === 'up'
        ? files
            .filter((file) => !applied.includes(stem(file)))
            .slice(0, options.count ?? files.length)
        : applied.slice(0, options.count ?? 1).map((name) => `${name}.sql`);

    const names: string[] = [];
    for (const file of chosen) {
      const login = migrationLogin(parseMigration(file, await readFile(join(dir, file), 'utf8')));
      const url = login === 'bootstrap' ? options.bootstrapUrl : options.migratorUrl;
      const run = await runMigrations({ ...shared, databaseUrl: url, count: 1, login });
      // The tool picks the next file itself, so a disagreement here means the two
      // readings of the folder differ, which is worth stopping on.
      if (run.names.join() !== stem(file)) {
        throw new MigrationFileError(
          `expected to run ${file}, and ran ${run.names.join() || 'nothing'}`,
        );
      }
      names.push(stem(file));
      if (login === 'bootstrap' && options.direction === 'up') await letMigratorRecord(client);
    }
    return { names };
  });
}
