// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The job queue's schemas, as the migration and the worker login's install
// leave them: who can reach what, and what enqueue_payout refuses. Running
// jobs is tested from the worker, in src/worker/queue.db.test.ts.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { sql } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import type { Database, ProjectContext } from './database.js';
import { MIGRATIONS_DIR, parseMigration, runMigrations } from './migrate.js';
import { jobs } from './repositories/jobs.js';
import { RepositoryInputError } from './repositories/values.js';
import { insertTenant } from './testing/admin-tenants.js';
import { databaseAsServiceRoles } from './testing/databases.js';
import {
  createTestDatabase,
  PLATFORM_ROLES,
  roleUrl,
  type TestDatabase,
} from './testing/harness.js';

const adminUrl = inject('dbAdminUrl');
const roleUrls = inject('dbRoleUrls');

const MIGRATION = '1800000000024_job_queue.sql';
const PAYOUT = '9d2c1b0a-8f7e-4d6c-9b5a-4f3e2d1c0b9a';

let database: TestDatabase;
let admin: pg.Client;
let db: Database;
let tenant: ProjectContext;

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

async function asLogin<T>(
  role: 'ujira_app' | 'ujira_reader',
  work: (client: pg.Client) => Promise<T>,
): Promise<T> {
  const client = new pg.Client({ connectionString: roleUrl(roleUrls, role, database.name) });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

beforeAll(async () => {
  database = await createTestDatabase(adminUrl, import.meta.url);
  admin = new pg.Client({ connectionString: database.url });
  await admin.connect();
  db = databaseAsServiceRoles(roleUrls, database, 2);
  tenant = await insertTenant(admin, 'Queue');
});

afterAll(async () => {
  await db.close();
  await admin.end();
  await database.drop();
});

describe('the job queue schemas', () => {
  it('were installed by the worker login, which holds no CREATE on the database', async () => {
    const { rows } = await admin.query<{ can_create: boolean; latest: number; owner: string }>(
      `select has_database_privilege('ujira_worker', current_database(), 'CREATE') as can_create,
              (select max(id) from graphile_worker.migrations) as latest,
              (select pg_get_userbyid(relowner) from pg_class
                where oid = 'graphile_worker._private_jobs'::regclass) as owner`,
    );
    expect(rows).toEqual([{ can_create: false, latest: 20, owner: 'ujira_worker' }]);
  });

  it('give the app no way to the queue tables or to add_job', async () => {
    await asLogin('ujira_app', async (client) => {
      expect(await codeOf(client.query('select count(*) from graphile_worker._private_jobs'))).toBe(
        '42501',
      );
      expect(await codeOf(client.query(`select graphile_worker.add_job('payout.advance')`))).toBe(
        '42501',
      );
    });
  });

  it('let only the app call enqueue_payout, never the reader, the API roles or PUBLIC', async () => {
    const { rows } = await admin.query<{ role: string; can: boolean }>(
      `select r as role,
              has_function_privilege(r, 'ujira_jobs.enqueue_payout(text,uuid)', 'EXECUTE') as can
         from unnest($1::text[]) as r
        order by 1`,
      [['ujira_app', 'ujira_reader', ...PLATFORM_ROLES]],
    );
    expect(Object.fromEntries(rows.map((row) => [row.role, row.can]))).toEqual({
      ujira_app: true,
      ujira_reader: false,
      anon: false,
      authenticated: false,
      service_role: false,
    });
    await asLogin('ujira_reader', async (client) => {
      expect(
        await codeOf(
          client.query(`select ujira_jobs.enqueue_payout('receipt.issue', $1)`, [PAYOUT]),
        ),
      ).toBe('42501');
    });
  });

  it('grant PUBLIC no function the queue installed, and no schema to anyone but the app', async () => {
    const functions = await admin.query<{ object: string }>(
      `select format('function %s', p.oid::regprocedure) as object
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace,
              aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
        where n.nspname in ('graphile_worker', 'ujira_jobs') and a.grantee = 0`,
    );
    expect(functions.rows).toEqual([]);
    // The library installs functions of its own, so the test is not vacuous.
    const installed = await admin.query<{ n: string }>(
      `select count(*)::text as n from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'graphile_worker'`,
    );
    expect(Number.parseInt(installed.rows[0]?.n ?? '0', 10)).toBeGreaterThan(0);

    const schemas = await admin.query<{ schema: string; grantee: string; privilege: string }>(
      `select n.nspname as schema,
              case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end as grantee,
              a.privilege_type as privilege
         from pg_namespace n, aclexplode(coalesce(n.nspacl, acldefault('n', n.nspowner))) a
        where n.nspname in ('graphile_worker', 'ujira_jobs') and a.grantee <> n.nspowner
        order by 1, 2, 3`,
    );
    expect(schemas.rows).toEqual([
      { schema: 'ujira_jobs', grantee: 'ujira_app', privilege: 'USAGE' },
    ]);
  });

  it('cannot be rolled back while the queue is installed', async () => {
    const source = parseMigration(MIGRATION, readFileSync(join(MIGRATIONS_DIR, MIGRATION), 'utf8'));
    await admin.query('begin');
    try {
      expect(await codeOf(admin.query(source.down))).toBe('2BP01');
    } finally {
      await admin.query('rollback');
    }
  });

  it('can be rolled back before the queue is installed, with only its own ledger there', async () => {
    // The ledger's primary key is a relation in the schema too, and must not
    // read as an installed queue.
    const source = parseMigration(MIGRATION, readFileSync(join(MIGRATIONS_DIR, MIGRATION), 'utf8'));
    const bare = await createTestDatabase(adminUrl, `${import.meta.url}#bare`, { empty: true });
    const client = new pg.Client({ connectionString: bare.url });
    try {
      await client.connect();
      await runMigrations({ databaseUrl: bare.url, direction: 'up' });
      await client.query('begin');
      try {
        expect(await codeOf(client.query(source.down))).toBeUndefined();
        const { rows } = await client.query<{ found: string | null }>(
          `select to_regnamespace('graphile_worker')::text as found`,
        );
        expect(rows).toEqual([{ found: null }]);
      } finally {
        await client.query('rollback');
      }
    } finally {
      await client.end();
      await bare.drop();
    }
  });
});

describe('enqueue_payout', () => {
  it('refuses a transaction with no tenant context', async () => {
    expect(
      await codeOf(db.unscoped(async (tx) => jobs.enqueuePayout(tx, 'payout.advance', PAYOUT))),
    ).toBe('UJ001');
  });

  it('refuses the read only scope over every project of a principal', async () => {
    expect(
      await codeOf(
        db
          .principal(tenant, 'app')
          .transaction(async (tx) => jobs.enqueuePayout(tx, 'payout.advance', PAYOUT)),
      ),
    ).toBe('UJ001');
  });

  it('refuses a task it has no queue rule for, and a null payout id', async () => {
    const call = (task: string, payout: string | null) =>
      db.tenant(tenant).transaction(async (tx) => {
        await sql`select ujira_jobs.enqueue_payout(${task}, ${payout}::uuid)`.execute(tx);
      });
    expect(await codeOf(call('payout.cancel', PAYOUT))).toBe('22023');
    expect(await codeOf(call('payout.advance', null))).toBe('22004');
  });

  it('refuses, before any statement, a task or an id the repository cannot store', async () => {
    await expect(
      db
        .tenant(tenant)
        .transaction(async (tx) =>
          jobs.enqueuePayout(tx, 'payout.cancel' as 'payout.advance', PAYOUT),
        ),
    ).rejects.toThrow(RepositoryInputError);
    await expect(
      db
        .tenant(tenant)
        .transaction(async (tx) => jobs.enqueuePayout(tx, 'payout.advance', PAYOUT.toUpperCase())),
    ).rejects.toThrow(RepositoryInputError);
  });

  it('returns the id of the job it added', async () => {
    const id = await db
      .tenant(tenant)
      .transaction(async (tx) => jobs.enqueuePayout(tx, 'receipt.issue', PAYOUT));
    const { rows } = await admin.query<{ task_identifier: string }>(
      'select task_identifier from graphile_worker.jobs where id = $1',
      [id.toString()],
    );
    expect(rows).toEqual([{ task_identifier: 'receipt.issue' }]);
  });
});
