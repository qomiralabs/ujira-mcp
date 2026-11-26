// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The query layer. Nothing outside src/db imports pg or kysely, so every
// query runs through here, under a tenant context, inside one transaction.
//
// The transaction is opened here rather than by kysely, because
// `begin` and the tenant context travel in one statement, which is one
// round trip. The spike measured the context statement on its own costing a
// whole round trip from outside the region. Kysely is then handed that one
// client with a driver whose transaction methods are never used.

import {
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type DatabaseConnection,
  type Dialect,
  type Driver,
  type QueryResult,
  type CompiledQuery,
} from 'kysely';
import pg from 'pg';

import type { DatabaseConfig, RoleConnection } from './config.js';
import { assertNoSessionState } from './session-state.js';
import { beginWithTenant, type TenantContext } from './tenant.js';
import type { Schema } from './schema.js';
import { toUnavailable } from './unavailable.js';

export type DatabaseRole = 'app' | 'worker' | 'reader' | 'migration';

// One pg connection, wrapped for kysely. Exported for its own tests only. Every statement passes the session
// state guard first: a leaked `SET` would outlive the transaction on a
// pooled backend, which the spike measured reaching another client.
export class ClientConnection implements DatabaseConnection {
  constructor(private readonly client: pg.PoolClient) {}

  async executeQuery<R>(compiledQuery: CompiledQuery): Promise<QueryResult<R>> {
    assertNoSessionState(compiledQuery.sql);
    const result = await this.client.query<never>({
      text: compiledQuery.sql,
      values: [...compiledQuery.parameters],
    });
    return {
      rows: result.rows,
      numAffectedRows: BigInt(result.rowCount ?? 0),
    };
  }

  // Streaming would hold a cursor open across statements, which a
  // transaction pooler does not promise. Nothing needs it yet.
  streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
    throw new Error('streaming is not supported on a pooled connection');
  }
}

// Hands kysely the one client this transaction already owns. Exported for
// its own tests, not from the module entry: index.ts exports no driver.
// The transaction methods throw: this module sends `begin` with the context
// itself, and a second `begin` from kysely would be a silently nested
// transaction.
export class OwnedClientDriver implements Driver {
  constructor(private readonly connection: DatabaseConnection) {}

  // The driver interface is async; this one owns a connection that is
  // already open, so these resolve or throw without awaiting anything.
  init(): Promise<void> {
    return Promise.resolve();
  }

  acquireConnection(): Promise<DatabaseConnection> {
    return Promise.resolve(this.connection);
  }

  beginTransaction(): Promise<void> {
    return Promise.reject(
      new Error('the transaction is opened with the tenant context; use withTenant'),
    );
  }

  commitTransaction(): Promise<void> {
    return Promise.reject(new Error('the transaction is committed by withTenant'));
  }

  rollbackTransaction(): Promise<void> {
    return Promise.reject(new Error('the transaction is rolled back by withTenant'));
  }

  releaseConnection(): Promise<void> {
    return Promise.resolve();
  }

  destroy(): Promise<void> {
    return Promise.resolve();
  }
}

function dialectFor(connection: DatabaseConnection): Dialect {
  return {
    createAdapter: () => new PostgresAdapter(),
    createDriver: () => new OwnedClientDriver(connection),
    createIntrospector: (db: Kysely<Schema>) => new PostgresIntrospector(db),
    createQueryCompiler: () => new PostgresQueryCompiler(),
  };
}

// A principal and one of its projects, as an authenticated request carries
// them.
export interface ProjectContext {
  readonly principalId: string;
  readonly projectId: string;
}

// Transactions for one tenant. Every one opens with the context in its first
// statement, so no query in it can run without one.
export interface TenantSession {
  readonly transaction: <T>(work: (db: Kysely<Schema>) => Promise<T>) => Promise<T>;
}

export interface Database {
  // Runs the work in one transaction, under the tenant context.
  readonly withTenant: <T>(
    role: DatabaseRole,
    context: TenantContext,
    work: (db: Kysely<Schema>) => Promise<T>,
  ) => Promise<T>;
  // One project of one principal, read and write.
  readonly tenant: (context: ProjectContext) => TenantSession;
  // Every project of the principal, read only: the transaction opens read
  // only, and the policies refuse writes under this scope as well.
  readonly principal: (context: ProjectContext, role?: 'app' | 'reader') => TenantSession;
  // One transaction with no tenant context, for the entry points that run
  // before one exists: creating a principal, authenticating a token, and
  // finding which tenant a contract belongs to. Nothing else can read or
  // write in it.
  readonly unscoped: <T>(
    work: (db: Kysely<Schema>) => Promise<T>,
    role?: 'app' | 'worker',
  ) => Promise<T>;
  readonly close: () => Promise<void>;
}

export interface DatabaseHooks {
  // A connection the server ended: a restart, a failover, the pooler recycling
  // it. Told the SQLSTATE only, because the message can name a host. The pool
  // replaces the connection on demand, so this is for counting, not recovery;
  // a transaction that was using it fails on its own. Must not throw.
  readonly onConnectionLost?: (code: string) => void;
}

// How long close waits for connections to finish closing, so a server that
// stops answering cannot hang a shutdown.
const CLOSE_TIMEOUT_MS = 5000;

function lostCode(error: unknown): string {
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : 'unknown';
}

// pool.end() resolves when the pool's list of clients is empty, which is before
// their sockets have closed. This counts them out, so close can mean closed.
function connectionsClosed(pool: pg.Pool): () => Promise<void> {
  let open = 0;
  let wake: (() => void) | undefined;
  pool.on('connect', () => {
    open += 1;
  });
  pool.on('remove', () => {
    open -= 1;
    if (open === 0) wake?.();
  });
  return async () => {
    if (open === 0) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, CLOSE_TIMEOUT_MS);
      wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  };
}

function poolFor(
  role: RoleConnection,
  config: DatabaseConfig,
  onLost: (error: Error) => void,
): pg.Pool {
  const pool = new pg.Pool({
    // pg keeps its own copy, which it hides from logs but not from an
    // own property walk, so a pool must never be attached to an error.
    connectionString: role.url.reveal(),
    max: role.poolSize,
    connectionTimeoutMillis: config.acquireTimeoutMs,
    // The pinned trust from tls.ts, or nothing at all for a loopback host
    // with UJIRA_DB_TLS=off. Passing the object here is what makes the
    // claim in config.ts true: without it pg falls back to PGSSLMODE or to
    // its own default, which is no TLS.
    ...(config.tlsOptions === undefined ? {} : { ssl: config.tlsOptions }),
    // Type parsers are left exactly as pg ships them. Changing one would
    // change every value of that type everywhere, so the lint rules ban
    // setTypeParser across the repository.
  });
  // pg emits an idle connection's failure on the pool, and an emitter with no
  // listener for `error` throws, so without this one lost idle connection would
  // take the whole process down. Nothing was using it and the pool has already
  // dropped it, so there is nothing to fail.
  pool.on('error', onLost);
  return pool;
}

// Timeouts are sent as transaction local settings in the same statement as
// the context, not as session settings: a session setting on a pooled
// backend reaches the next client, which the spike measured.
function timeoutSettings(config: DatabaseConfig): string {
  return [
    `set_config('statement_timeout', '${String(config.statementTimeoutMs)}', true)`,
    `set_config('lock_timeout', '${String(config.lockTimeoutMs)}', true)`,
  ].join(', ');
}

export function createDatabase(config: DatabaseConfig, hooks: DatabaseHooks = {}): Database {
  const onLost = (error: Error): void => {
    hooks.onConnectionLost?.(lostCode(error));
  };
  const pools: Record<DatabaseRole, pg.Pool> = {
    app: poolFor(config.app, config, onLost),
    worker: poolFor(config.worker, config, onLost),
    reader: poolFor(config.reader, config, onLost),
    migration: poolFor(config.migration, config, onLost),
  };
  const allClosed = Object.values(pools).map((pool) => ({
    pool,
    closed: connectionsClosed(pool),
  }));

  let closed = false;

  const withTenant: Database['withTenant'] = async (role, context, work) => {
    // The context is checked before a connection is taken, so a malformed
    // tenant fails with what was wrong rather than with whatever the
    // connection attempt happened to say, and never costs a connection.
    const begin = `${beginWithTenant(context)}, ${timeoutSettings(config)}`;
    return inTransaction(role, begin, work);
  };

  // A transaction with no tenant context. Every policy refuses it with
  // UJ001, so the only things that work in it are the security definer
  // entry points, which is the point: they are how a request gets a context.
  const unscoped: Database['unscoped'] = async (work, role = 'app') =>
    inTransaction(role, `begin; select ${timeoutSettings(config)}`, work);

  async function inTransaction<T>(
    role: DatabaseRole,
    begin: string,
    work: (db: Kysely<Schema>) => Promise<T>,
  ): Promise<T> {
    let client: pg.PoolClient;
    try {
      client = await pools[role].connect();
    } catch (error) {
      throw toUnavailable(error) ?? error;
    }
    // A checked out client has no listener of its own, so a connection lost
    // between two queries of this transaction would throw from the emitter
    // rather than fail the transaction. The next query here fails instead.
    let lost: Error | undefined;
    const onClientError = (error: Error): void => {
      lost = error;
      onLost(error);
    };
    client.on('error', onClientError);
    let open = false;
    try {
      // One round trip: begin, the tenant context, and the timeouts.
      await client.query(begin);
      open = true;
      const db = new Kysely<Schema>({ dialect: dialectFor(new ClientConnection(client)) });
      const result = await work(db);
      await client.query('commit');
      open = false;
      return result;
    } catch (error) {
      if (open) {
        // A rollback that fails must not hide the error that caused it.
        await client.query('rollback').catch(() => undefined);
      }
      // An outage leaves as one typed error, so the API can answer 503
      // without knowing the driver; anything else stays the caller's.
      throw toUnavailable(error) ?? error;
    } finally {
      client.removeListener('error', onClientError);
      // Passing the error destroys the client rather than returning it.
      client.release(lost);
    }
  }

  // The two values are copied once, here, so a context object whose
  // properties change later cannot change a transaction already handed out.
  const sessionFor = (
    role: DatabaseRole,
    context: ProjectContext,
    scope: TenantContext['scope'],
  ): TenantSession => {
    const fixed: TenantContext = {
      principalId: context.principalId,
      projectId: context.projectId,
      scope,
    };
    return { transaction: async (work) => withTenant(role, fixed, work) };
  };

  return {
    withTenant,
    unscoped,
    tenant: (context) => sessionFor('app', context, 'project'),
    principal: (context, role = 'reader') => sessionFor(role, context, 'all'),
    // Idempotent: a teardown path that closes twice, or a test that closes
    // after an error, must not fail on the second call. pg throws on a
    // second end of the same pool.
    close: async () => {
      if (closed) return;
      closed = true;
      await Promise.all(
        allClosed.map(async (entry) => {
          await entry.pool.end();
          await entry.closed();
        }),
      );
    },
  };
}
