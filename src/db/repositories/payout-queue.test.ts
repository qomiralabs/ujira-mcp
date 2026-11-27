// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// payouts.create with the real job queue: the payout, its leg and its first
// Graphile job commit together or not at all, and a retried request adds no
// second job.

import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import type { Database } from '../database.js';
import { insertTenant } from '../testing/admin-tenants.js';
import { databaseAsServiceRoles } from '../testing/databases.js';
import { createTestDatabase, type TestDatabase } from '../testing/harness.js';
import { newPayout, payoutWorld, type PayoutWorld } from '../testing/payout-fixture.js';
import { payoutJobQueue } from './jobs.js';
import { payouts } from './payouts.js';

const adminUrl = inject('dbAdminUrl');
const roleUrls = inject('dbRoleUrls');

let database: TestDatabase;
let admin: pg.Client;
let db: Database;
let world: PayoutWorld;

interface JobRow {
  readonly task_identifier: string;
  readonly queue_name: string | null;
  readonly key: string | null;
  readonly payload: unknown;
  readonly max_attempts: number;
}

async function jobsOfWorld(): Promise<readonly JobRow[]> {
  const { rows } = await admin.query<JobRow>(
    `select j.task_identifier, j.queue_name, j.key, p.payload, j.max_attempts
       from graphile_worker.jobs as j
       join graphile_worker._private_jobs as p on p.id = j.id
      where p.payload ->> 'projectId' = $1
      order by j.id`,
    [world.context.projectId],
  );
  return rows;
}

async function payoutCount(): Promise<number> {
  const { rows } = await admin.query<{ n: string }>(
    'select count(*)::text as n from ujira.payouts where project_id = $1',
    [world.context.projectId],
  );
  return Number.parseInt(rows[0]?.n ?? '0', 10);
}

beforeAll(async () => {
  database = await createTestDatabase(adminUrl, import.meta.url);
  admin = new pg.Client({ connectionString: database.url });
  await admin.connect();
  db = databaseAsServiceRoles(roleUrls, database, 2);
});

beforeEach(async () => {
  world = await payoutWorld(db, await insertTenant(admin, 'Queued'));
});

afterAll(async () => {
  await db.close();
  await admin.end();
  await database.drop();
});

describe('payouts.create on the job queue', () => {
  it('commits the payout with its payout.advance job on the project agent queue', async () => {
    const created = await db
      .tenant(world.context)
      .transaction(async (tx) => payouts.create(tx, newPayout(world), payoutJobQueue));
    const id = created.payout.id;
    expect(await jobsOfWorld()).toEqual([
      {
        task_identifier: 'payout.advance',
        queue_name: `agent:${world.context.projectId}`,
        key: `${world.context.projectId}:payout:${id}:payout.advance`,
        payload: { ...world.context, payoutId: id },
        max_attempts: 10,
      },
    ]);
  });

  it('leaves neither the payout nor its job when the transaction rolls back', async () => {
    await expect(
      db.tenant(world.context).transaction(async (tx) => {
        await payouts.create(tx, newPayout(world), payoutJobQueue);
        throw new Error('the request failed after the payout was written');
      }),
    ).rejects.toThrow('the request failed after the payout was written');
    expect(await payoutCount()).toBe(0);
    expect(await jobsOfWorld()).toEqual([]);
  });

  it('adds no second job for a retried request', async () => {
    const input = newPayout(world);
    const create = async () =>
      db.tenant(world.context).transaction(async (tx) => payouts.create(tx, input, payoutJobQueue));
    await create();
    const again = await create();
    expect(again.created).toBe(false);
    expect(await jobsOfWorld()).toHaveLength(1);
  });
});
