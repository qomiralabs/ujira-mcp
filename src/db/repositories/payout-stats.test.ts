// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The overview's figures against a seeded set of payouts, as the app reads
// them. One principal holds two projects and another principal a third, each
// with payouts in every outcome, some created long ago, so every number has
// rows on both sides of it: in and out of the period, in and out of the
// project, in and out of the principal.

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import type { Database, ProjectContext } from '../database.js';
import { insertProject, insertTenant } from '../testing/admin-tenants.js';
import { databaseAsServiceRoles } from '../testing/databases.js';
import { createTestDatabase, type TestDatabase } from '../testing/harness.js';
import {
  newPayout,
  payoutWorld,
  TESTNET,
  usdc,
  type PayoutWorld,
} from '../testing/payout-fixture.js';
import { payoutStats, type PayoutPeriodStats, type StatsPeriod } from './payout-stats.js';
import { unwiredJobQueue } from './payout-jobs.js';
import { payouts, type Payout } from './payouts.js';

const adminUrl = inject('dbAdminUrl');
const roleUrls = inject('dbRoleUrls');

const DAY = 86_400_000;
// Payouts moved back to this instant sit exactly on a period edge.
const EDGE = new Date('2026-01-01T00:00:00.000Z');

let database: TestDatabase;
let admin: pg.Client;
let db: Database;

let acme: PayoutWorld;
let acmeSecond: PayoutWorld;
let other: PayoutWorld;
let empty: ProjectContext;
let now: number;

type Outcome = 'paid' | 'pending_approval' | 'queued' | 'failed';

const PATHS: Readonly<Record<Outcome, readonly Payout['status'][]>> = {
  paid: ['submitting', 'approved', 'settling', 'paid'],
  pending_approval: ['submitting', 'pending_approval'],
  queued: [],
  failed: ['failed'],
};

async function seed(
  world: PayoutWorld,
  amount: bigint,
  outcome: Outcome | { blockedBy: string },
): Promise<string> {
  const input = newPayout(world, {
    amount: usdc(amount),
    legs: [{ payoutMethodId: world.methodId, amount: usdc(amount) }],
    ...(typeof outcome === 'object' ? { blockedBy: outcome.blockedBy } : {}),
  });
  const { payout } = await db
    .tenant(world.context)
    .transaction(async (tx) => payouts.create(tx, input, unwiredJobQueue));
  if (typeof outcome === 'object') return payout.id;
  let from = payout.status;
  for (const to of PATHS[outcome]) {
    const moved = await db.withTenant('worker', { ...world.context, scope: 'project' }, (tx) =>
      payouts.transition(tx, payout.id, { from, to }),
    );
    if (moved === undefined) throw new Error(`the seeded payout did not move to ${to}`);
    from = moved.status;
  }
  return payout.id;
}

// Moves payouts to another creation time, past the guard that keeps a
// finished payout as it was, which only a test should ever do.
async function createdAt(ids: readonly string[], at: Date): Promise<void> {
  await admin.query('begin');
  try {
    await admin.query('set local session_replication_role = replica');
    await admin.query('update ujira.payouts set created_at = $1 where id = any($2::uuid[])', [
      at,
      ids,
    ]);
    await admin.query('commit');
  } catch (error) {
    await admin.query('rollback');
    throw error;
  }
}

async function statsOf(context: ProjectContext, period: StatsPeriod): Promise<PayoutPeriodStats> {
  return db.tenant(context).transaction(async (tx) => payoutStats.period(tx, period));
}

const around = (instant: number): StatsPeriod => ({
  from: new Date(instant - DAY),
  to: new Date(instant + DAY),
});

beforeAll(async () => {
  database = await createTestDatabase(adminUrl, import.meta.url);
  admin = new pg.Client({ connectionString: database.url });
  await admin.connect();
  db = databaseAsServiceRoles(roleUrls, database, 3);

  const acmeTenant = await insertTenant(admin, 'Acme');
  acme = await payoutWorld(db, acmeTenant);
  acmeSecond = await payoutWorld(db, {
    principalId: acmeTenant.principalId,
    projectId: await insertProject(admin, acmeTenant.principalId, 'Grants'),
  });
  other = await payoutWorld(db, await insertTenant(admin, 'Globex'));
  empty = await insertTenant(admin, 'Initech');

  // Acme's main project: in the period, two paid, one waiting, two blocked by
  // different rules, one still queued and one failed; on the edge long ago,
  // one paid and one still waiting.
  await seed(acme, 25_000_000n, 'paid');
  await seed(acme, 100_000_000n, 'paid');
  await seed(acme, 3_000_000n, 'pending_approval');
  await seed(acme, 4_000_000n, { blockedBy: 'DAILY_CAP_EXCEEDED' });
  await seed(acme, 5_000_000n, { blockedBy: 'MANDATE_PAUSED' });
  await seed(acme, 6_000_000n, 'queued');
  await seed(acme, 8_000_000n, 'failed');
  await createdAt([await seed(acme, 7n, 'paid'), await seed(acme, 9n, 'pending_approval')], EDGE);

  // The same principal's other project, and another principal, with payouts
  // that would change every figure above if they leaked into it.
  await seed(acmeSecond, 999_000_000n, 'paid');
  await seed(acmeSecond, 1_000_000n, 'pending_approval');
  await seed(acmeSecond, 1_000_000n, { blockedBy: 'DAILY_CAP_EXCEEDED' });
  await seed(other, 555_000_000n, 'paid');
  await seed(other, 1_000_000n, 'pending_approval');
  await seed(other, 1_000_000n, { blockedBy: 'RECIPIENT_NOT_ALLOWED' });

  now = Date.now();
});

afterAll(async () => {
  await db.close();
  await admin.end();
  await database.drop();
});

describe('the figures of a period', () => {
  it('count the payouts created in it, by status, by rule and in total paid', async () => {
    expect(await statsOf(acme.context, around(now))).toEqual({
      byStatus: { paid: 2, pending_approval: 1, blocked: 2, queued: 1, failed: 1 },
      blockedByRule: { DAILY_CAP_EXCEEDED: 1, MANDATE_PAUSED: 1 },
      paid: [{ network: TESTNET, amount: usdc(125_000_000n) }],
      approvalsWaiting: 2,
    });
  });

  it('take a payout created on the start of the period and leave one on its end', async () => {
    const onEdge = await statsOf(acme.context, { from: EDGE, to: new Date(EDGE.getTime() + DAY) });
    expect(onEdge).toEqual({
      byStatus: { paid: 1, pending_approval: 1 },
      blockedByRule: {},
      paid: [{ network: TESTNET, amount: usdc(7n) }],
      approvalsWaiting: 2,
    });
    const before = await statsOf(acme.context, { from: new Date(EDGE.getTime() - DAY), to: EDGE });
    expect(before.byStatus).toEqual({});
    expect(before.paid).toEqual([{ network: TESTNET, amount: usdc(0n) }]);
  });

  it('add up every payout in a period that covers them all, to the unit', async () => {
    const all = await statsOf(acme.context, {
      from: new Date(EDGE.getTime() - DAY),
      to: new Date(now + DAY),
    });
    expect(all.byStatus).toEqual({
      paid: 3,
      pending_approval: 2,
      blocked: 2,
      queued: 1,
      failed: 1,
    });
    expect(all.paid).toEqual([{ network: TESTNET, amount: usdc(125_000_007n) }]);
  });

  it("show a mandate's token at zero when nothing was paid in it", async () => {
    const quiet = await statsOf(acme.context, {
      from: new Date(EDGE.getTime() - 30 * DAY),
      to: new Date(EDGE.getTime() - 20 * DAY),
    });
    expect(quiet).toEqual({
      byStatus: {},
      blockedByRule: {},
      paid: [{ network: TESTNET, amount: usdc(0n) }],
      approvalsWaiting: 2,
    });
  });

  it('are empty for a project with no mandates and no payouts', async () => {
    expect(await statsOf(empty, around(now))).toEqual({
      byStatus: {},
      blockedByRule: {},
      paid: [],
      approvalsWaiting: 0,
    });
  });

  it('refuse a period that does not start before it ends, before any query', async () => {
    const at = new Date(now);
    await expect(statsOf(acme.context, { from: at, to: at })).rejects.toBeInstanceOf(RangeError);
  });
});

describe('the figures of a project', () => {
  it('never count another project of the same principal', async () => {
    expect(await statsOf(acmeSecond.context, around(now))).toEqual({
      byStatus: { paid: 1, pending_approval: 1, blocked: 1 },
      blockedByRule: { DAILY_CAP_EXCEEDED: 1 },
      paid: [{ network: TESTNET, amount: usdc(999_000_000n) }],
      approvalsWaiting: 1,
    });
  });

  it('never count another principal', async () => {
    expect(await statsOf(other.context, around(now))).toEqual({
      byStatus: { paid: 1, pending_approval: 1, blocked: 1 },
      blockedByRule: { RECIPIENT_NOT_ALLOWED: 1 },
      paid: [{ network: TESTNET, amount: usdc(555_000_000n) }],
      approvalsWaiting: 1,
    });
  });
});
