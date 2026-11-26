// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

import { sql } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { loadDatabaseConfig, type DatabaseEnvironment } from './config.js';
import { createDatabase, type Database } from './database.js';
import { SessionStateError } from './errors.js';
import { createTestDatabase, withDatabase, type TestDatabase } from './testing/harness.js';

const adminUrl = inject('dbAdminUrl');

const PRINCIPAL = '0199a1f6-1e3f-7c21-9b8a-2d4e6f8a0b12';
const CONTEXT_FOR_PIN = {
  principalId: '0199a1f6-1e3f-7c21-9b8a-2d4e6f8a0b12',
  projectId: '0199a1f6-4c7d-7a55-8e21-5b9c7d3e1f04',
  scope: 'project',
} as const;
const OTHER_PRINCIPAL = '0199a1f6-9999-7c21-9b8a-2d4e6f8a0b12';
const PROJECT = '0199a1f6-4c7d-7a55-8e21-5b9c7d3e1f04';

let database: TestDatabase;
let db: Database;

// The container is one server, so every role points at it. The roles differ
// in production; what this file checks is the transaction, the context and
// the guard, not the grants, which the tenancy migration brings.
function environmentFor(url: string): DatabaseEnvironment {
  return {
    UJIRA_DB_APP_URL: url,
    UJIRA_DB_READER_URL: url,
    // The container is not the transaction pooler, so the worker and the
    // migrator may use it: the config refuses port 6543, not every port.
    UJIRA_DB_WORKER_URL: url,
    UJIRA_DB_MIGRATOR_URL: url,
    // The container is a plain Postgres on a loopback host with no TLS, so
    // the pin is turned off here. config.test.ts checks that this is
    // refused for any host that is not loopback.
    UJIRA_DB_TLS: 'off',
    UJIRA_DB_POOL_SIZE: '2',
    UJIRA_DB_STATEMENT_TIMEOUT_MS: '4000',
    UJIRA_DB_LOCK_TIMEOUT_MS: '2000',
  };
}

beforeAll(async () => {
  database = await createTestDatabase(adminUrl, import.meta.url);
  const client = new pg.Client({ connectionString: database.url });
  await client.connect();
  // A table with no policies: this file is about the client side.
  await client.query('create table note (id serial primary key, body text not null)');
  await client.end();
  db = createDatabase(loadDatabaseConfig(environmentFor(database.url)));
});

afterAll(async () => {
  await db.close();
  await database.drop();
});

async function settings(): Promise<Record<string, string | null>> {
  return db.withTenant(
    'app',
    { principalId: PRINCIPAL, projectId: PROJECT, scope: 'project' },
    async (kysely) => {
      // current_setting, not pg_settings: a custom setting only appears in
      // pg_settings once the session has one, and these are transaction
      // local by design.
      const result = await sql<Record<string, string | null>>`
        select
          current_setting('ujira.principal_id', true) as principal_id,
          current_setting('ujira.project_id', true) as project_id,
          current_setting('ujira.scope', true) as scope,
          current_setting('ujira.txid', true) as txid,
          current_setting('statement_timeout', true) as statement_timeout,
          current_setting('lock_timeout', true) as lock_timeout
      `.execute(kysely);
      return result.rows[0] ?? {};
    },
  );
}

describe('withTenant', () => {
  it('runs the work with the tenant context in place', async () => {
    const found = await settings();
    expect(found['principal_id']).toBe(PRINCIPAL);
    expect(found['project_id']).toBe(PROJECT);
    expect(found['scope']).toBe('project');
    expect(found['txid']).toMatch(/^[0-9]+$/);
  });

  it('sends the timeouts as transaction settings, not session ones', async () => {
    const found = await settings();
    // current_setting reports these with units, pg_settings in milliseconds.
    expect(found['statement_timeout']).toBe('4s');
    expect(found['lock_timeout']).toBe('2s');
  });

  it('leaves no context behind for the next user of the connection', async () => {
    // The pool has two connections and the work above returned them, so a
    // fresh transaction must start with nothing set. This is the leak the
    // spike measured with a session level SET.
    await db.withTenant(
      'app',
      { principalId: PRINCIPAL, projectId: PROJECT, scope: 'project' },
      () => Promise.resolve(),
    );
    const leaked = await db.withTenant(
      'reader',
      { principalId: OTHER_PRINCIPAL, projectId: PROJECT, scope: 'all' },
      async (kysely) => {
        const result = await sql<{
          principal: string;
        }>`select current_setting('ujira.principal_id', true) as principal`.execute(kysely);
        return result.rows[0]?.principal;
      },
    );
    expect(leaked).toBe(OTHER_PRINCIPAL);
  });

  it('commits the work when it returns', async () => {
    await db.withTenant(
      'app',
      { principalId: PRINCIPAL, projectId: PROJECT, scope: 'project' },
      async (kysely) => {
        await kysely
          .insertInto('note' as never)
          .values({ body: 'kept' })
          .execute();
      },
    );
    const kept = await db.withTenant(
      'reader',
      { principalId: PRINCIPAL, projectId: PROJECT, scope: 'project' },
      async (kysely) => {
        const result = await sql<{ body: string }>`select body from note`.execute(kysely);
        return result.rows.map((row) => row.body);
      },
    );
    expect(kept).toContain('kept');
  });

  it('rolls the work back when it throws, and reports the original error', async () => {
    await expect(
      db.withTenant(
        'app',
        { principalId: PRINCIPAL, projectId: PROJECT, scope: 'project' },
        async (kysely) => {
          await kysely
            .insertInto('note' as never)
            .values({ body: 'rolled back' })
            .execute();
          throw new Error('work failed');
        },
      ),
    ).rejects.toThrow('work failed');

    const bodies = await db.withTenant(
      'reader',
      { principalId: PRINCIPAL, projectId: PROJECT, scope: 'project' },
      async (kysely) => {
        const result = await sql<{ body: string }>`select body from note`.execute(kysely);
        return result.rows.map((row) => row.body);
      },
    );
    expect(bodies).not.toContain('rolled back');
  });

  it('refuses a session level statement from inside the work', async () => {
    await expect(
      db.withTenant(
        'app',
        { principalId: PRINCIPAL, projectId: PROJECT, scope: 'project' },
        async (kysely) => {
          await sql`set ujira.principal_id = 'someone else'`.execute(kysely);
        },
      ),
    ).rejects.toThrow(SessionStateError);
  });

  it('refuses a session scoped set_config from inside the work', async () => {
    await expect(
      db.withTenant(
        'app',
        { principalId: PRINCIPAL, projectId: PROJECT, scope: 'project' },
        async (kysely) => {
          await sql`select set_config('ujira.principal_id', 'someone else', false)`.execute(kysely);
        },
      ),
    ).rejects.toThrow(SessionStateError);
  });

  it('refuses reset from inside the work', async () => {
    await expect(
      db.withTenant(
        'app',
        { principalId: PRINCIPAL, projectId: PROJECT, scope: 'project' },
        async (kysely) => {
          await sql`reset all`.execute(kysely);
        },
      ),
    ).rejects.toThrow(SessionStateError);
  });

  it('refuses a transaction opened by the query builder instead of this layer', async () => {
    await expect(
      db.withTenant(
        'app',
        { principalId: PRINCIPAL, projectId: PROJECT, scope: 'project' },
        async (kysely) => {
          await kysely.transaction().execute(() => Promise.resolve());
        },
      ),
    ).rejects.toThrow(/withTenant/);
  });

  it('hands each role its own pool, reaching the same server here', async () => {
    const seen = await Promise.all(
      (['app', 'reader', 'worker', 'migration'] as const).map(async (role) =>
        db.withTenant(
          role,
          { principalId: PRINCIPAL, projectId: PROJECT, scope: 'project' },
          async (kysely) => {
            const result = await sql<{ name: string }>`select current_database() as name`.execute(
              kysely,
            );
            return result.rows[0]?.name;
          },
        ),
      ),
    );
    expect(new Set(seen).size).toBe(1);
    expect(seen[0]).toBe(database.name);
  });

  it('really hands the pinned TLS to the driver, not just to the config', async () => {
    // The container speaks no TLS, so a pinned connection to it must fail
    // at the handshake. If this ever passes, the ssl object has stopped
    // reaching pg and the claim in config.ts is false again, which is the
    // state security blocked this module for.
    const pinned = createDatabase(
      loadDatabaseConfig({ ...environmentFor(database.url), UJIRA_DB_TLS: 'pinned' }),
    );
    try {
      // The matcher is the point. A bare rejection would be satisfied by
      // anything that throws before a socket is opened, including a
      // tightened UUID rule in the context constructor, so the one guard
      // between a refactor and a silent return to plaintext could pass
      // while testing nothing. This is the driver's own words when the
      // server answers no to the TLS request, so it says a handshake was
      // attempted and refused.
      await expect(
        pinned.withTenant('app', CONTEXT_FOR_PIN, () => Promise.resolve()),
      ).rejects.toThrow('The server does not support SSL connections');
    } finally {
      await pinned.close();
    }
  });

  it('keeps the database name out of the admin url it was given', () => {
    expect(withDatabase(database.url, 'postgres')).toContain('/postgres');
  });
});
