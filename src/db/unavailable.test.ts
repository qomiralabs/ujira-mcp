// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

import { sql } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { loadDatabaseConfig, type DatabaseEnvironment } from './config.js';
import { createDatabase, type Database } from './database.js';
import { createTestDatabase, type TestDatabase } from './testing/harness.js';
import { DatabaseUnavailableError, toUnavailable } from './unavailable.js';

const adminUrl = inject('dbAdminUrl');

const CONTEXT = {
  principalId: '0199a1f6-1e3f-7c21-9b8a-2d4e6f8a0b12',
  projectId: '0199a1f6-4c7d-7a55-8e21-5b9c7d3e1f04',
  scope: 'project',
} as const;

function environmentFor(url: string): DatabaseEnvironment {
  return {
    UJIRA_DB_APP_URL: url,
    UJIRA_DB_READER_URL: url,
    UJIRA_DB_WORKER_URL: url,
    UJIRA_DB_MIGRATOR_URL: url,
    UJIRA_DB_TLS: 'off',
    UJIRA_DB_POOL_SIZE: '2',
    UJIRA_DB_STATEMENT_TIMEOUT_MS: '500',
    UJIRA_DB_LOCK_TIMEOUT_MS: '500',
  };
}

function databaseError(code: string): pg.DatabaseError {
  const error = new pg.DatabaseError('server said something about a host', 0, 'error');
  error.code = code;
  return error;
}

function systemError(code: string): Error {
  return Object.assign(new Error('connect refused 10.0.0.1:5432'), { code, syscall: 'connect' });
}

describe('toUnavailable', () => {
  it('maps connection, shutdown, capacity and timeout states', () => {
    for (const code of ['08006', '08001', '57P01', '57P03', '53300', '57014', '55P03']) {
      const mapped = toUnavailable(databaseError(code));
      expect(mapped, code).toBeInstanceOf(DatabaseUnavailableError);
      expect(mapped?.reason).toBe(code);
    }
  });

  it('maps network failures of the socket', () => {
    for (const code of ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN']) {
      expect(toUnavailable(systemError(code))?.reason, code).toBe(code);
    }
  });

  it('maps the driver messages for a lost or never opened connection', () => {
    for (const message of [
      'timeout exceeded when trying to connect',
      'Connection terminated unexpectedly',
      'Connection terminated due to connection timeout',
    ]) {
      expect(toUnavailable(new Error(message))?.reason, message).toBe('connection');
    }
  });

  it('leaves everything else alone, so a bug is never reported as an outage', () => {
    expect(toUnavailable(databaseError('23505'))).toBeUndefined();
    expect(toUnavailable(databaseError('42P01'))).toBeUndefined();
    expect(toUnavailable(new Error('ECONNREFUSED'))).toBeUndefined();
    // A code that looks like a socket error but did not come from a socket.
    expect(toUnavailable(Object.assign(new Error('x'), { code: 'ECONNREFUSED' }))).toBeUndefined();
    expect(toUnavailable('ECONNREFUSED')).toBeUndefined();
    expect(toUnavailable(null)).toBeUndefined();
  });

  it('keeps no text of the cause, which can name hosts and users', () => {
    const mapped = toUnavailable(databaseError('08006'));
    expect(mapped?.message).toBe('The database is unavailable');
    expect(mapped?.cause).toBeUndefined();
    expect(JSON.stringify(mapped)).not.toContain('host');
  });
});

describe('withTenant on an unavailable database', () => {
  let database: TestDatabase;
  let db: Database;

  beforeAll(async () => {
    database = await createTestDatabase(adminUrl, import.meta.url);
    db = createDatabase(loadDatabaseConfig(environmentFor(database.url)));
  });

  afterAll(async () => {
    await db.close();
    await database.drop();
  });

  it('throws DatabaseUnavailableError when no connection can be opened', async () => {
    // Port 9 on loopback is the discard port; nothing listens there in CI.
    const closed = createDatabase(
      loadDatabaseConfig(environmentFor('postgres://ujira@127.0.0.1:9/nothing')),
    );
    try {
      await expect(closed.withTenant('app', CONTEXT, () => Promise.resolve(1))).rejects.toThrow(
        DatabaseUnavailableError,
      );
    } finally {
      await closed.close();
    }
  });

  it('throws DatabaseUnavailableError when the statement timeout fires', async () => {
    const run = db.withTenant('app', CONTEXT, async (kysely) => {
      await sql`select pg_sleep(2)`.execute(kysely);
    });
    await expect(run).rejects.toMatchObject({
      name: 'DatabaseUnavailableError',
      reason: '57014',
    });
  });

  it('passes the error of the work through when it is not about availability', async () => {
    const failure = new Error('a repository refusal');
    await expect(db.withTenant('app', CONTEXT, () => Promise.reject(failure))).rejects.toBe(
      failure,
    );
    const missing = db.withTenant('app', CONTEXT, async (kysely) => {
      await sql`select * from no_such_table`.execute(kysely);
    });
    await expect(missing).rejects.toMatchObject({ code: '42P01' });
  });
});
