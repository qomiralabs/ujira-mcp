// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// What happens to a pooled connection the server ends. pg emits that on the
// pool, and an emitter with no listener for `error` throws, so an idle
// connection lost to a restart or a recycling pooler would take the whole
// process down although nothing was using it. These tests end real backends.

import { sql } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';

import { loadDatabaseConfig } from './config.js';
import { createDatabase, type Database, type DatabaseHooks } from './database.js';
import { createTestDatabase, type TestDatabase } from './testing/harness.js';

const adminUrl = inject('dbAdminUrl');

const CONTEXT = {
  principalId: '0199a1f6-1e3f-7c21-9b8a-2d4e6f8a0b12',
  projectId: '0199a1f6-4c7d-7a55-8e21-5b9c7d3e1f04',
  scope: 'project',
} as const;

let database: TestDatabase;
let admin: pg.Client;

beforeAll(async () => {
  database = await createTestDatabase(adminUrl, import.meta.url);
  admin = new pg.Client({ connectionString: database.url });
  await admin.connect();
});

afterAll(async () => {
  await admin.end();
  await database.drop();
});

function open(hooks?: DatabaseHooks, poolSize = 2): Database {
  const config = loadDatabaseConfig({
    UJIRA_DB_APP_URL: database.url,
    UJIRA_DB_READER_URL: database.url,
    UJIRA_DB_WORKER_URL: database.url,
    UJIRA_DB_MIGRATOR_URL: database.url,
    UJIRA_DB_TLS: 'off',
    UJIRA_DB_POOL_SIZE: String(poolSize),
  });
  return hooks === undefined ? createDatabase(config) : createDatabase(config, hooks);
}

async function backendPid(db: Database): Promise<number> {
  return db.withTenant('app', CONTEXT, async (kysely) => {
    const result = await sql<{ pid: number }>`select pg_backend_pid() as pid`.execute(kysely);
    return result.rows[0]?.pid ?? -1;
  });
}

async function terminate(pids: readonly number[]): Promise<void> {
  await admin.query('select pg_terminate_backend(pid) from unnest($1::int[]) as t (pid)', [
    [...pids],
  ]);
}

describe('a connection the server ends while it is idle', () => {
  it('is reported by its code, and the next transaction gets a new one', async () => {
    const lost: string[] = [];
    const db = open({ onConnectionLost: (code) => lost.push(code) });
    try {
      const pid = await backendPid(db);
      await terminate([pid]);
      await vi.waitFor(() => {
        expect(lost).toEqual(['57P01']);
      });
      const next = await backendPid(db);
      expect(next).not.toBe(pid);
      expect(next).toBeGreaterThan(0);
    } finally {
      await db.close();
    }
  });

  it('does not crash a process that passed no hook', async () => {
    const db = open();
    try {
      const pid = await backendPid(db);
      await terminate([pid]);
      // Without a listener the process would die here, as an unhandled error.
      await vi.waitFor(async () => {
        const next = await backendPid(db);
        expect(next).not.toBe(pid);
      });
    } finally {
      await db.close();
    }
  });
});

describe('a connection the server ends during a transaction', () => {
  it('fails that transaction, is reported, and leaves the pool working', async () => {
    const lost: string[] = [];
    const db = open({ onConnectionLost: (code) => lost.push(code) });
    try {
      let pid = -1;
      await expect(
        db.withTenant('app', CONTEXT, async (kysely) => {
          const result = await sql<{ pid: number }>`select pg_backend_pid() as pid`.execute(kysely);
          pid = result.rows[0]?.pid ?? -1;
          // Lost between two queries, when nothing is waiting on the socket.
          await terminate([pid]);
          await vi.waitFor(() => {
            expect(lost).toContain('57P01');
          });
          await sql`select 1`.execute(kysely);
        }),
      ).rejects.toThrow();
      const next = await backendPid(db);
      expect(next).not.toBe(pid);
      expect(next).toBeGreaterThan(0);
    } finally {
      await db.close();
    }
  });
});

describe('closing', () => {
  it('returns only once every connection has closed', async () => {
    // pool.end() resolves while each connection is still closing. Ended that
    // early, this is the race that failed CI: a forced drop in teardown killed
    // a backend mid close, and the error had nowhere to go.
    for (let round = 0; round < 25; round += 1) {
      const lost: string[] = [];
      const db = open({ onConnectionLost: (code) => lost.push(code) }, 4);
      const pids = await Promise.all(Array.from({ length: 4 }, async () => backendPid(db)));
      await db.close();
      await terminate(pids);
      await new Promise((resolve) => setImmediate(resolve));
      expect(lost, `round ${String(round)}`).toEqual([]);
    }
  });

  it('survives a forced drop of its database straight afterwards', async () => {
    // Few rounds, because cloning a database is slow; the test above repeats
    // the race itself.
    for (let round = 0; round < 3; round += 1) {
      const lost: string[] = [];
      const own = await createTestDatabase(adminUrl, `${import.meta.url}#drop${String(round)}`);
      const config = loadDatabaseConfig({
        UJIRA_DB_APP_URL: own.url,
        UJIRA_DB_READER_URL: own.url,
        UJIRA_DB_WORKER_URL: own.url,
        UJIRA_DB_MIGRATOR_URL: own.url,
        UJIRA_DB_TLS: 'off',
      });
      const db = createDatabase(config, { onConnectionLost: (code) => lost.push(code) });
      await Promise.all(Array.from({ length: 2 }, async () => backendPid(db)));
      await db.close();
      await own.drop();
      expect(lost, `round ${String(round)}`).toEqual([]);
    }
  });
});
