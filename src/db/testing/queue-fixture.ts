// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// What the queue tests outside src/db need from a real database, with every
// statement kept in here. Tenants are written as the superuser. A stand in for
// the payouts table, with a tenant key and forced policies like every tenant
// table, lets a test write a row and its job in one transaction and read the
// row back under a tenant, until the payouts table itself exists. The queue's
// own rows are read as the superuser, since no service role but the worker
// may see them.

import { sql, type Kysely } from 'kysely';
import pg from 'pg';

import type { ProjectContext } from '../database.js';
import type { Schema } from '../schema.js';
import { insertProject, insertTenant } from './admin-tenants.js';
import type { TestDatabase } from './harness.js';

type Tx = Kysely<Schema>;

export interface QueueRow {
  readonly id: string;
  readonly task: string;
  readonly queue: string | null;
  readonly key: string | null;
  readonly payload: unknown;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly locked: boolean;
  readonly lastError: string | null;
}

export interface QueueFixture {
  readonly tenant: (name: string) => Promise<ProjectContext>;
  /** A second project of a principal that already has one. */
  readonly project: (principalId: string, name: string) => Promise<ProjectContext>;
  readonly payouts: {
    /** Inserts a payout for the transaction's own tenant and returns its id. */
    readonly insert: (tx: Tx) => Promise<string>;
    /** The status the transaction's tenant sees, or undefined when it sees no such row. */
    readonly status: (tx: Tx, id: string) => Promise<string | undefined>;
    /** True when a row of the transaction's tenant moved. */
    readonly markNeedsAttention: (tx: Tx, id: string) => Promise<boolean>;
    /** Every tenant's rows, as the superuser. */
    readonly count: () => Promise<number>;
    /** Every tenant's view of one row, as the superuser. */
    readonly statusAsAdmin: (id: string) => Promise<string | undefined>;
  };
  readonly jobs: () => Promise<readonly QueueRow[]>;
  /** Moves a waiting job on, as a run of the library would, so a test needs no hours of backoff. */
  readonly setAttempts: (jobId: string, attempts: number) => Promise<void>;
  /** A job written past enqueue_payout, as a hand edit or a bug would write it. */
  readonly addRawJob: (task: string, payload: unknown, queue: string | null) => Promise<string>;
  /** Empties the queue, so one test's jobs never reach the next test's runner. */
  readonly clearJobs: () => Promise<void>;
  readonly close: () => Promise<void>;
}

export async function queueFixture(database: TestDatabase): Promise<QueueFixture> {
  const admin = new pg.Client({ connectionString: database.url });
  await admin.connect();
  await admin.query(`
    set role ujira_owner;
    create table if not exists ujira.fixture_payouts (
      principal_id uuid not null,
      project_id uuid not null,
      id uuid primary key default gen_random_uuid(),
      status text not null default 'queued',
      foreign key (principal_id, project_id) references ujira.projects (principal_id, id)
    );
    select ujira.apply_tenant_policies('ujira.fixture_payouts');
    grant select, insert, update on ujira.fixture_payouts to ujira_app, ujira_worker;
    reset role;
  `);

  return {
    tenant: async (name) => insertTenant(admin, name),
    project: async (principalId, name) => ({
      principalId,
      projectId: await insertProject(admin, principalId, name),
    }),
    payouts: {
      insert: async (tx) => {
        const { rows } = await sql<{ id: string }>`
          insert into ujira.fixture_payouts (principal_id, project_id)
          values (ujira.current_principal_id(), ujira.current_project_id())
          returning id
        `.execute(tx);
        const id = rows[0]?.id;
        if (id === undefined) throw new Error('the fixture payout insert returned no row');
        return id;
      },
      status: async (tx, id) => {
        const { rows } = await sql<{ status: string }>`
          select status from ujira.fixture_payouts where id = ${id}::uuid
        `.execute(tx);
        return rows[0]?.status;
      },
      markNeedsAttention: async (tx, id) => {
        const result = await sql`
          update ujira.fixture_payouts set status = 'needs_attention' where id = ${id}::uuid
        `.execute(tx);
        return (result.numAffectedRows ?? 0n) > 0n;
      },
      count: async () => {
        const { rows } = await admin.query<{ n: string }>(
          'select count(*)::text as n from ujira.fixture_payouts',
        );
        return Number.parseInt(rows[0]?.n ?? '0', 10);
      },
      statusAsAdmin: async (id) => {
        const { rows } = await admin.query<{ status: string }>(
          'select status from ujira.fixture_payouts where id = $1',
          [id],
        );
        return rows[0]?.status;
      },
    },
    jobs: async () => {
      const { rows } = await admin.query<{
        id: string;
        task_identifier: string;
        queue_name: string | null;
        key: string | null;
        payload: unknown;
        attempts: number;
        max_attempts: number;
        locked_at: Date | null;
        last_error: string | null;
      }>(
        `select j.id::text, j.task_identifier, j.queue_name, j.key, p.payload, j.attempts,
                j.max_attempts, j.locked_at, j.last_error
           from graphile_worker.jobs as j
           join graphile_worker._private_jobs as p on p.id = j.id
          order by j.id`,
      );
      return rows.map((row) => ({
        id: row.id,
        task: row.task_identifier,
        queue: row.queue_name,
        key: row.key,
        payload: row.payload,
        attempts: row.attempts,
        maxAttempts: row.max_attempts,
        locked: row.locked_at !== null,
        lastError: row.last_error,
      }));
    },
    setAttempts: async (jobId, attempts) => {
      await admin.query(
        'update graphile_worker._private_jobs set attempts = $2, run_at = now() where id = $1',
        [jobId, attempts],
      );
    },
    addRawJob: async (task, payload, queue) => {
      const { rows } = await admin.query<{ id: string }>(
        `select id::text from graphile_worker.add_job($1, $2::json, queue_name => $3, max_attempts => 10)`,
        [task, JSON.stringify(payload), queue],
      );
      const id = rows[0]?.id;
      if (id === undefined) throw new Error('add_job returned no job');
      return id;
    },
    clearJobs: async () => {
      await admin.query(`
        delete from graphile_worker._private_jobs;
        delete from graphile_worker._private_job_queues;
      `);
    },
    close: async () => {
      await admin.end();
    },
  };
}
