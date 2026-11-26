// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// Tenant isolation as the service roles see it. Every test here connects as
// ujira_app, ujira_worker or ujira_reader, never as the superuser, which row level
// security does not apply to. The table is built the way every tenant table
// is: as the owner, with the policy template applied.

import { sql } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { loadDatabaseConfig } from './config.js';
import {
  createDatabase,
  type Database,
  type ProjectContext,
  type TenantSession,
} from './database.js';
import { createTestDatabase, roleUrl, type TestDatabase } from './testing/harness.js';

const adminUrl = inject('dbAdminUrl');
const roleUrls = inject('dbRoleUrls');

const A1: ProjectContext = {
  principalId: '0199a1f6-1e3f-7c21-9b8a-2d4e6f8a0b12',
  projectId: '0199a1f6-4c7d-7a55-8e21-5b9c7d3e1f04',
};
const A2: ProjectContext = {
  principalId: A1.principalId,
  projectId: '0199a1f6-4c7d-7a55-8e21-5b9c7d3e1f05',
};
const B1: ProjectContext = {
  principalId: '0199a1f6-9999-7c21-9b8a-2d4e6f8a0b12',
  projectId: '0199a1f6-9999-7a55-8e21-5b9c7d3e1f04',
};

let database: TestDatabase;
let db: Database;
let appUrl: string;

function databaseFor(appPoolSize: string): Database {
  return createDatabase(
    loadDatabaseConfig({
      UJIRA_DB_APP_URL: appUrl,
      UJIRA_DB_READER_URL: roleUrl(roleUrls, 'ujira_reader', database.name),
      UJIRA_DB_WORKER_URL: roleUrl(roleUrls, 'ujira_worker', database.name),
      UJIRA_DB_MIGRATOR_URL: database.url,
      UJIRA_DB_TLS: 'off',
      UJIRA_DB_POOL_SIZE: appPoolSize,
    }),
  );
}

async function asApp<T>(work: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: appUrl });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

interface Note {
  readonly principal_id: string;
  readonly project_id: string;
  readonly body: string;
}

async function notes(session: TenantSession): Promise<Note[]> {
  return session.transaction(async (kysely) => {
    const result = await sql<Note>`
      select principal_id, project_id, body from ujira.notes order by body
    `.execute(kysely);
    return result.rows;
  });
}

beforeAll(async () => {
  database = await createTestDatabase(adminUrl, import.meta.url);
  appUrl = roleUrl(roleUrls, 'ujira_app', database.name);
  const admin = new pg.Client({ connectionString: database.url });
  await admin.connect();
  try {
    await admin.query(`
      set role ujira_owner;
      create table ujira.notes (
        principal_id uuid not null,
        project_id uuid not null,
        body text not null
      );
      select ujira.apply_tenant_policies('ujira.notes');
      grant select, insert, update on ujira.notes to ujira_app, ujira_worker;
      grant select on ujira.notes to ujira_reader;
      reset role;
    `);
    // The superuser writes the starting rows, past the policies.
    await admin.query(
      `insert into ujira.notes (principal_id, project_id, body) values
         ($1, $2, 'a1 first'), ($1, $3, 'a2 first'), ($4, $5, 'b1 first')`,
      [A1.principalId, A1.projectId, A2.projectId, B1.principalId, B1.projectId],
    );
  } finally {
    await admin.end();
  }
  db = databaseFor('2');
});

afterAll(async () => {
  await db.close();
  await database.drop();
});

describe('missing context', () => {
  it('query without context raises UJ001', async () => {
    await asApp(async (client) => {
      expect(await codeOf(client.query('select * from ujira.notes'))).toBe('UJ001');
      expect(await codeOf(client.query('select ujira.current_principal_id()'))).toBe('UJ001');
    });
  });

  it('refuses a context set by another transaction, which is what a leaked setting looks like', async () => {
    await asApp(async (client) => {
      // A session level setting outlives its transaction on a pooled
      // backend. Without the transaction id it would be used; with it, the
      // next transaction finds a context that is not its own and refuses.
      await client.query(
        `select set_config('ujira.principal_id', $1, false),
                set_config('ujira.project_id', $2, false),
                set_config('ujira.scope', 'project', false),
                set_config('ujira.txid', txid_current()::text, false)`,
        [A1.principalId, A1.projectId],
      );
      expect(await codeOf(client.query('select * from ujira.notes'))).toBe('UJ001');
    });
  });

  it('leaves nothing on the connection once the transaction ends', async () => {
    await asApp(async (client) => {
      await client.query('begin');
      await client.query(
        `select set_config('ujira.principal_id', $1, true),
                set_config('ujira.project_id', $2, true),
                set_config('ujira.scope', 'project', true),
                set_config('ujira.txid', txid_current()::text, true)`,
        [A1.principalId, A1.projectId],
      );
      const inside = await client.query<Note>('select * from ujira.notes');
      expect(inside.rows.map((row) => row.body)).toEqual(['a1 first']);
      await client.query('commit');
      const after = await client.query<{ value: string }>(
        `select coalesce(current_setting('ujira.principal_id', true), '') as value`,
      );
      expect(after.rows[0]?.value).toBe('');
      expect(await codeOf(client.query('select * from ujira.notes'))).toBe('UJ001');
    });
  });
});

describe('project scope', () => {
  it('sees only its own project', async () => {
    expect((await notes(db.tenant(A1))).map((row) => row.body)).toEqual(['a1 first']);
    expect((await notes(db.tenant(B1))).map((row) => row.body)).toEqual(['b1 first']);
  });

  it("writes its own rows and is refused another tenant's", async () => {
    await db.tenant(A1).transaction(async (kysely) => {
      await sql`insert into ujira.notes values (${A1.principalId}, ${A1.projectId}, 'a1 second')`.execute(
        kysely,
      );
    });
    const foreign = db.tenant(A1).transaction(async (kysely) => {
      await sql`insert into ujira.notes values (${B1.principalId}, ${B1.projectId}, 'into b')`.execute(
        kysely,
      );
    });
    expect(await codeOf(foreign)).toBe('42501');
    const otherProject = db.tenant(A1).transaction(async (kysely) => {
      await sql`insert into ujira.notes values (${A1.principalId}, ${A2.projectId}, 'into a2')`.execute(
        kysely,
      );
    });
    expect(await codeOf(otherProject)).toBe('42501');
    expect((await notes(db.tenant(A1))).map((row) => row.body)).toEqual(['a1 first', 'a1 second']);
  });

  it("cannot move a row to another tenant, and does not see another tenant's to update", async () => {
    const moved = db.tenant(A1).transaction(async (kysely) => {
      await sql`update ujira.notes set principal_id = ${B1.principalId}, project_id = ${B1.projectId}
                 where body = 'a1 first'`.execute(kysely);
    });
    expect(await codeOf(moved)).toBe('42501');
    const touched = await db.tenant(A1).transaction(async (kysely) => {
      const result =
        await sql`update ujira.notes set body = 'hijacked' where body = 'b1 first'`.execute(kysely);
      return result.numAffectedRows;
    });
    expect(touched).toBe(0n);
  });

  it('is never granted delete', async () => {
    const deleted = db.tenant(A1).transaction(async (kysely) => {
      await sql`delete from ujira.notes`.execute(kysely);
    });
    expect(await codeOf(deleted)).toBe('42501');
  });
});

describe('the worker', () => {
  // Every job runs inside a tenant transaction, so the worker login is held
  // to the same policies as the app.
  const asWorker = (context: ProjectContext) =>
    db.withTenant('worker', { ...context, scope: 'project' }, async (kysely) => {
      const rows = await sql<Note>`select * from ujira.notes order by body`.execute(kysely);
      return rows.rows.map((row) => row.principal_id);
    });

  it("sees only its tenant's rows and is refused another tenant's", async () => {
    const seen = await asWorker(B1);
    expect(seen.length).toBeGreaterThan(0);
    expect(new Set(seen)).toEqual(new Set([B1.principalId]));
    const foreign = db.withTenant('worker', { ...B1, scope: 'project' }, async (kysely) => {
      await sql`insert into ujira.notes values (${A1.principalId}, ${A1.projectId}, 'from b')`.execute(
        kysely,
      );
    });
    expect(await codeOf(foreign)).toBe('42501');
  });

  it('refuses a query with no context', async () => {
    const client = new pg.Client({
      connectionString: roleUrl(roleUrls, 'ujira_worker', database.name),
    });
    await client.connect();
    try {
      expect(await codeOf(client.query('select * from ujira.notes'))).toBe('UJ001');
    } finally {
      await client.end();
    }
  });
});

describe('scope all', () => {
  it("reads every project of its principal and nothing of another principal's", async () => {
    const bodies = (await notes(db.principal(A1))).map((row) => row.body);
    expect(bodies).toContain('a1 first');
    expect(bodies).toContain('a2 first');
    expect(bodies).not.toContain('b1 first');
  });

  it('insert under scope all is refused', async () => {
    // Through the repository the transaction is read only, so Postgres
    // refuses before any policy is consulted.
    const viaRepository = db.principal(A1, 'app').transaction(async (kysely) => {
      await sql`insert into ujira.notes values (${A1.principalId}, ${A1.projectId}, 'all')`.execute(
        kysely,
      );
    });
    expect(await codeOf(viaRepository)).toBe('25006');
    // And a read write transaction under scope all is refused by the
    // policies themselves, which is what holds if the first ever slips.
    await asApp(async (client) => {
      await client.query('begin');
      await client.query(
        `select set_config('ujira.principal_id', $1, true),
                set_config('ujira.project_id', $2, true),
                set_config('ujira.scope', 'all', true),
                set_config('ujira.txid', txid_current()::text, true)`,
        [A1.principalId, A1.projectId],
      );
      expect(
        await codeOf(
          client.query(`insert into ujira.notes values ($1, $2, 'all')`, [
            A1.principalId,
            A1.projectId,
          ]),
        ),
      ).toBe('42501');
      await client.query('rollback');
    });
  });
});

describe('pooled connections', () => {
  it('pool of one alternating tenants, including after an error', async () => {
    const single = databaseFor('1');
    try {
      for (let round = 0; round < 20; round += 1) {
        const context = round % 2 === 0 ? A1 : B1;
        if (round % 5 === 4) {
          // A failed transaction on the one connection, mid work.
          const failed = single.tenant(context).transaction(async (kysely) => {
            await sql`select 1 / 0`.execute(kysely);
          });
          expect(await codeOf(failed)).toBe('22012');
          continue;
        }
        const seen = await single.tenant(context).transaction(async (kysely) => {
          const rows = await sql<{ principal_id: string; current: string }>`
            select principal_id, current_setting('ujira.principal_id') as current from ujira.notes
          `.execute(kysely);
          return rows.rows;
        });
        expect(seen.length).toBeGreaterThan(0);
        for (const row of seen) {
          expect(row.principal_id).toBe(context.principalId);
          expect(row.current).toBe(context.principalId);
        }
      }
    } finally {
      await single.close();
    }
  });
});
