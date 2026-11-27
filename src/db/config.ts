// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// Where the database lives and how hard this process may lean on it. Four
// roles, each with its own pool: the app writes through the transaction
// pooler, the worker listens through the session pooler, the reader reads,
// and the migrator runs migrations. The reader has no URL of its own unless
// one is given: it logs in as the app, which reads under the same policies,
// so a deployment needs only the three logins it already has.
//
// TLS is pinned by default: the server is verified against the certificate
// in tls.ts, and a URL may not carry an ssl parameter, because pg would let
// one replace or disable that. `UJIRA_DB_TLS=off` exists for a local
// Postgres and is refused for any host that is not loopback.
//
// The numbers here come from the Supabase spike: max_connections is 60 on
// the project, the pooler's statement_timeout and lock_timeout are 8s, the
// transaction pooler delivers no LISTEN notification, and the migration
// tool's advisory lock is session scoped. The defaults are deliberately
// small; the deploy tunes them against real traffic.

import { ConnectionUrl } from './connection-url.js';
import { DatabaseConfigError } from './errors.js';
import { PINNED_TLS } from './tls.js';

export type TlsMode = 'pinned' | 'off';

export interface DatabaseEnvironment {
  UJIRA_DB_TLS?: string | undefined;
  UJIRA_DB_APP_URL?: string | undefined;
  UJIRA_DB_WORKER_URL?: string | undefined;
  UJIRA_DB_MIGRATOR_URL?: string | undefined;
  UJIRA_DB_READER_URL?: string | undefined;
  UJIRA_DB_POOL_SIZE?: string | undefined;
  UJIRA_DB_ACQUIRE_TIMEOUT_MS?: string | undefined;
  UJIRA_DB_STATEMENT_TIMEOUT_MS?: string | undefined;
  UJIRA_DB_LOCK_TIMEOUT_MS?: string | undefined;
}

// Every variable above, as a value rather than a type, so a test can
// compare the set with db/.env.example. The object is written as a map and
// checked against the interface, which makes it exhaustive in both
// directions: a field added to DatabaseEnvironment and not named here
// fails typecheck for a missing property, and a name here the interface
// does not declare fails for an unknown one. The template test closes the
// third direction, that a variable named in both is actually read.
const ENVIRONMENT_KEY_MAP = {
  UJIRA_DB_TLS: true,
  UJIRA_DB_APP_URL: true,
  UJIRA_DB_WORKER_URL: true,
  UJIRA_DB_MIGRATOR_URL: true,
  UJIRA_DB_READER_URL: true,
  UJIRA_DB_POOL_SIZE: true,
  UJIRA_DB_ACQUIRE_TIMEOUT_MS: true,
  UJIRA_DB_STATEMENT_TIMEOUT_MS: true,
  UJIRA_DB_LOCK_TIMEOUT_MS: true,
} satisfies Record<keyof DatabaseEnvironment, true>;

export const DATABASE_ENVIRONMENT_KEYS: readonly (keyof DatabaseEnvironment)[] = Object.freeze(
  Object.keys(ENVIRONMENT_KEY_MAP) as (keyof DatabaseEnvironment)[],
);

export interface RoleConnection {
  // Held rather than a string, so printing the configuration, or an error
  // that carries it, prints a placeholder instead of the password.
  readonly url: ConnectionUrl;
  readonly poolSize: number;
}

export interface DatabaseConfig {
  // `pinned` verifies the server against the certificate in tls.ts.
  // `off` is accepted only for a loopback host, which is how a local
  // container or a developer's own Postgres is reached; it is refused for
  // any other host, so it cannot be used to drop TLS to a real server.
  readonly tls: TlsMode;
  readonly tlsOptions: typeof PINNED_TLS | undefined;
  readonly app: RoleConnection;
  readonly worker: RoleConnection;
  readonly reader: RoleConnection;
  readonly migration: RoleConnection;
  readonly acquireTimeoutMs: number;
  readonly statementTimeoutMs: number;
  readonly lockTimeoutMs: number;
}

// Measured on the project. `reservedForUs` leaves room for the dashboard,
// the Supabase API roles, a migration running beside the services and a
// person with psql.
export const CONNECTION_BUDGET = Object.freeze({
  maxConnections: 60,
  reservedForUs: 30,
});

// One process. UJIRA_DB_POOL_SIZE sizes the two pools that carry traffic,
// the app's and the worker's; the reader and the migrator stay small. A
// deployment that runs several instances divides the budget by the
// instance count rather than raising these.
export const POOL_DEFAULTS = Object.freeze({
  app: 5,
  worker: 5,
  reader: 2,
  migration: 1,
});

// Under the pooler's 8s, so a statement here is cut by our limit and not by
// a limit we do not control.
const TIMEOUT_DEFAULTS = Object.freeze({
  acquireTimeoutMs: 5_000,
  statementTimeoutMs: 5_000,
  lockTimeoutMs: 3_000,
});
const POOLER_TIMEOUT_MS = 8_000;

// Supavisor's transaction pooler. The worker cannot use it, because it
// delivers no LISTEN notification, and nor can the migrator, whose advisory
// lock is held in the session. Both are measured in the spike. The rule is
// written as a refusal of this port rather than a demand for 5432, so a
// local Postgres on any port still works.
const TRANSACTION_POOLER_PORT = '6543';

type Role = keyof typeof POOL_DEFAULTS;

const URL_KEYS: Readonly<Record<Role, keyof DatabaseEnvironment>> = {
  app: 'UJIRA_DB_APP_URL',
  worker: 'UJIRA_DB_WORKER_URL',
  reader: 'UJIRA_DB_READER_URL',
  migration: 'UJIRA_DB_MIGRATOR_URL',
};

// A role whose URL may be left out, and the role whose URL it then uses.
const URL_FALLBACKS: Readonly<Partial<Record<Role, Role>>> = { reader: 'app' };

// The roles UJIRA_DB_POOL_SIZE sizes.
const SIZED_BY_POOL_SIZE: ReadonlySet<Role> = new Set<Role>(['app', 'worker']);

// The only query parameters a database URL may carry. `options` is
// deliberately absent: it reaches the server as a startup parameter and can
// set session level state.
const ALLOWED_URL_PARAMETERS: ReadonlySet<string> = new Set([
  'application_name',
  'connect_timeout',
]);

// Hosts for which TLS may be turned off: a local Postgres or a test
// container, never anything reachable over a network.
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

// Roles that must reach the session pooler.
const SESSION_ONLY: readonly Role[] = ['worker', 'migration'];

function fail(message: string): never {
  throw new DatabaseConfigError(message);
}

function isBlank(value: string | undefined): value is undefined {
  return value === undefined || value.trim() === '';
}

// A URL is never quoted back, because it carries the password.
function readUrl(env: DatabaseEnvironment, role: Role): string {
  const fallback = URL_FALLBACKS[role];
  const key =
    isBlank(env[URL_KEYS[role]]) && fallback !== undefined ? URL_KEYS[fallback] : URL_KEYS[role];
  const raw = env[key];
  if (isBlank(raw)) fail(`${key} is required`);
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    fail(`${key} is not a URL`);
  }
  if (parsed.protocol !== 'postgresql:' && parsed.protocol !== 'postgres:') {
    fail(`${key} must start with postgresql://`);
  }
  if (parsed.hostname === '') fail(`${key} has no host`);
  if (parsed.pathname.replace(/^\//, '') === '') fail(`${key} has no database name`);
  // An allowlist, not a denylist. A denylist of one prefix let `options`
  // through, and pg forwards it as a startup parameter, which can set a
  // session level tenant key on a pooled connection before any statement
  // exists for the guard to see. Anything not named here is refused, so the
  // next parameter nobody thought of is refused by default.
  for (const name of parsed.searchParams.keys()) {
    const lower = name.toLowerCase();
    if (lower.startsWith('ssl')) {
      fail(
        `${key} must not set ${name}: TLS trust is pinned in src/db/tls.ts, and an ssl parameter would replace or disable it`,
      );
    }
    if (!ALLOWED_URL_PARAMETERS.has(lower)) {
      fail(
        `${key} must not set ${name}: only ${[...ALLOWED_URL_PARAMETERS].sort().join(', ')} are allowed in a database URL`,
      );
    }
  }
  if (SESSION_ONLY.includes(role) && parsed.port === TRANSACTION_POOLER_PORT) {
    fail(
      `${key} must not use the transaction pooler port ${TRANSACTION_POOLER_PORT}: it delivers no LISTEN notification and breaks the migration lock, so this role needs a session connection`,
    );
  }
  return raw;
}

// Integers only, written plainly. A value with spaces or a decimal point is
// a typo worth stopping on rather than rounding.
function readInt(
  env: DatabaseEnvironment,
  key: keyof DatabaseEnvironment,
  fallback: number,
): number {
  const raw = env[key];
  if (raw === undefined) return fallback;
  if (!/^[1-9][0-9]*$/.test(raw)) {
    fail(`${key} must be a whole number of at least 1`);
  }
  return Number.parseInt(raw, 10);
}

function readTlsMode(env: DatabaseEnvironment): TlsMode {
  const raw = env.UJIRA_DB_TLS;
  if (raw === undefined || raw === '') return 'pinned';
  if (raw !== 'pinned' && raw !== 'off') {
    fail("UJIRA_DB_TLS must be 'pinned' or 'off'");
  }
  return raw;
}

export function loadDatabaseConfig(env: DatabaseEnvironment): DatabaseConfig {
  const tls = readTlsMode(env);
  const roles = {} as Record<Role, RoleConnection>;
  let total = 0;
  for (const role of Object.keys(POOL_DEFAULTS) as Role[]) {
    const poolSize = SIZED_BY_POOL_SIZE.has(role)
      ? readInt(env, 'UJIRA_DB_POOL_SIZE', POOL_DEFAULTS[role])
      : POOL_DEFAULTS[role];
    total += poolSize;
    const url = readUrl(env, role);
    if (tls === 'off' && !LOOPBACK_HOSTS.has(new URL(url).hostname.toLowerCase())) {
      fail(
        `UJIRA_DB_TLS=off is only allowed for a loopback host, and ${URL_KEYS[role]} names another host; a connection to it would send tenant identifiers in the clear`,
      );
    }
    roles[role] = Object.freeze({ url: new ConnectionUrl(url), poolSize });
  }
  if (total > CONNECTION_BUDGET.reservedForUs) {
    fail(
      `the pool sizes add up to ${String(total)} connections, over the ${String(CONNECTION_BUDGET.reservedForUs)} this deployment may use of the database's ${String(CONNECTION_BUDGET.maxConnections)}`,
    );
  }

  const acquireTimeoutMs = readInt(
    env,
    'UJIRA_DB_ACQUIRE_TIMEOUT_MS',
    TIMEOUT_DEFAULTS.acquireTimeoutMs,
  );
  const statementTimeoutMs = readInt(
    env,
    'UJIRA_DB_STATEMENT_TIMEOUT_MS',
    TIMEOUT_DEFAULTS.statementTimeoutMs,
  );
  const lockTimeoutMs = readInt(env, 'UJIRA_DB_LOCK_TIMEOUT_MS', TIMEOUT_DEFAULTS.lockTimeoutMs);
  for (const [key, value] of [
    ['UJIRA_DB_STATEMENT_TIMEOUT_MS', statementTimeoutMs],
    ['UJIRA_DB_LOCK_TIMEOUT_MS', lockTimeoutMs],
  ] as const) {
    if (value >= POOLER_TIMEOUT_MS) {
      fail(
        `${key} must stay under the pooler's ${String(POOLER_TIMEOUT_MS)} ms limit, or it would never be reached`,
      );
    }
  }

  return Object.freeze({
    tls,
    // The object the driver is given. Undefined, not false: pg reads any
    // value here, and false would mean a connection with no TLS at all.
    tlsOptions: tls === 'pinned' ? PINNED_TLS : undefined,
    app: roles.app,
    worker: roles.worker,
    reader: roles.reader,
    migration: roles.migration,
    acquireTimeoutMs,
    statementTimeoutMs,
    lockTimeoutMs,
  });
}
