// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// Every method of the payout, leg and receipt repositories, run as tenant A
// against tenant B's rows and against A's own second project. Two principals
// with two projects each; each project has a mandate, a recipient, a payout
// still moving and a finished payout with its receipt. The matrix fails when
// a method is added without a case.

import type { Kysely } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import type { Database, ProjectContext } from '../database.js';
import type { Schema } from '../schema.js';
import { testHex32 } from '../testing/accounts.js';
import { insertProject, insertTenant } from '../testing/admin-tenants.js';
import { caseProblems } from '../testing/cross-tenant.js';
import { databaseAsServiceRoles } from '../testing/databases.js';
import { createTestDatabase, type TestDatabase } from '../testing/harness.js';
import {
  TESTNET,
  newPayout,
  payoutWorld,
  usdc,
  type PayoutWorld,
} from '../testing/payout-fixture.js';
import { unwiredJobQueue } from './payout-jobs.js';
import { payoutLegs, payoutRepositories, payouts } from './payouts.js';
import { receiptRepositories, receipts } from './receipts.js';

const adminUrl = inject('dbAdminUrl');
const roleUrls = inject('dbRoleUrls');

interface Rows {
  readonly context: ProjectContext;
  readonly world: PayoutWorld;
  readonly payoutId: string;
  readonly taskId: string;
  readonly legId: string;
  readonly finishedPayoutId: string;
  readonly receiptId: string;
}

interface Tenant {
  readonly first: Rows;
  readonly second: Rows;
}

const REPOSITORIES = { ...payoutRepositories, ...receiptRepositories };

let database: TestDatabase;
let admin: pg.Client;
let db: Database;
let a: Tenant;
let b: Tenant;

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

async function columnOf(table: string, column: string, id: string): Promise<unknown> {
  const result = await admin.query<{ value: unknown }>(
    `select ${column} as value from ${table} where id = $1`,
    [id],
  );
  return result.rows[0]?.value;
}

async function ownerOf(table: string, id: string): Promise<ProjectContext | undefined> {
  const result = await admin.query<{ principal_id: string; project_id: string }>(
    `select principal_id, project_id from ${table} where id = $1`,
    [id],
  );
  const row = result.rows[0];
  return row === undefined
    ? undefined
    : { principalId: row.principal_id, projectId: row.project_id };
}

async function rows(context: ProjectContext): Promise<Rows> {
  const world = await payoutWorld(db, context);
  const moving = newPayout(world);
  const created = await db
    .tenant(context)
    .transaction(async (tx) => payouts.create(tx, moving, unwiredJobQueue));
  const leg = created.legs[0];
  if (leg === undefined) throw new Error('no leg written');
  const finished = await db
    .tenant(context)
    .transaction(async (tx) => payouts.create(tx, newPayout(world), unwiredJobQueue));
  const receipt = await db.withTenant('worker', { ...context, scope: 'project' }, async (tx) => {
    await payouts.transition(tx, finished.payout.id, { from: 'queued', to: 'failed' });
    return receipts.issue(tx, finished.payout.id, null);
  });
  return {
    context,
    world,
    payoutId: created.payout.id,
    taskId: moving.taskId,
    legId: leg.id,
    finishedPayoutId: finished.payout.id,
    receiptId: receipt.receipt.id,
  };
}

async function tenant(name: string): Promise<Tenant> {
  const first = await insertTenant(admin, name);
  const second = {
    principalId: first.principalId,
    projectId: await insertProject(admin, first.principalId, `${name} two`),
  };
  return { first: await rows(first), second: await rows(second) };
}

const asA = async <T>(work: (tx: Kysely<Schema>) => Promise<T>): Promise<T> =>
  db.tenant(a.first.context).transaction(work);
// Every project of A, read only.
const acrossA = async <T>(work: (tx: Kysely<Schema>) => Promise<T>): Promise<T> =>
  db.principal(a.first.context, 'app').transaction(work);
const asAWorker = async <T>(work: (tx: Kysely<Schema>) => Promise<T>): Promise<T> =>
  db.withTenant('worker', { ...a.first.context, scope: 'project' }, work);

// The rows A must not reach: all of B's, and A's other project.
const foreign = (): readonly Rows[] => [b.first, b.second, a.second];

const cases: Record<string, () => Promise<void>> = {
  'payouts.create': async () => {
    // Another tenant's mandate reads as nothing, so the row has no network.
    for (const other of foreign()) {
      const planted = asA(async (tx) =>
        payouts.create(tx, newPayout(other.world), unwiredJobQueue),
      );
      expect(await codeOf(planted)).toBe('23502');
      // A's own mandate with another tenant's recipient fails its key.
      const borrowed = asA(async (tx) =>
        payouts.create(
          tx,
          newPayout(a.first.world, {
            recipientId: other.world.recipientId,
            legs: [{ payoutMethodId: other.world.methodId, amount: usdc(25_000_000n) }],
          }),
          unwiredJobQueue,
        ),
      );
      expect(await codeOf(borrowed)).toBe('23503');
    }
    const own = await asA(async (tx) =>
      payouts.create(tx, newPayout(a.first.world), unwiredJobQueue),
    );
    expect(await ownerOf('ujira.payouts', own.payout.id)).toEqual(a.first.context);
    expect(await ownerOf('ujira.payout_legs', own.legs[0]?.id ?? '')).toEqual(a.first.context);
  },
  'payouts.get': async () => {
    for (const other of foreign()) {
      expect(await asA(async (tx) => payouts.get(tx, other.payoutId))).toBeUndefined();
    }
    expect(await asA(async (tx) => payouts.get(tx, a.first.payoutId))).toBeDefined();
  },
  'payouts.findByTask': async () => {
    for (const other of foreign()) {
      expect(
        await asA(async (tx) => payouts.findByTask(tx, other.world.mandateId, other.taskId)),
      ).toBeUndefined();
    }
  },
  'payouts.list': async () => {
    const across = await acrossA(async (tx) => payouts.list(tx, {}, { limit: 100 }));
    const ids = across.items.map((payout) => payout.id);
    expect(ids).toContain(a.first.payoutId);
    expect(ids).toContain(a.second.payoutId);
    for (const other of [b.first, b.second]) {
      expect(ids).not.toContain(other.payoutId);
      expect(ids).not.toContain(other.finishedPayoutId);
    }
    for (const other of foreign()) {
      const filtered = await asA(async (tx) =>
        payouts.list(tx, { mandateId: other.world.mandateId }, { limit: 100 }),
      );
      expect(filtered.items).toEqual([]);
    }
  },
  'payouts.transition': async () => {
    for (const other of foreign()) {
      expect(
        await asAWorker(async (tx) =>
          payouts.transition(tx, other.payoutId, { from: 'queued', to: 'submitting' }),
        ),
      ).toBeUndefined();
      expect(await columnOf('ujira.payouts', 'status', other.payoutId)).toBe('queued');
    }
  },
  'payoutLegs.list': async () => {
    for (const other of foreign()) {
      expect(await asA(async (tx) => payoutLegs.list(tx, other.payoutId))).toEqual([]);
    }
    expect(await asA(async (tx) => payoutLegs.list(tx, a.first.payoutId))).toHaveLength(1);
  },
  'payoutLegs.transition': async () => {
    for (const other of foreign()) {
      expect(
        await asAWorker(async (tx) =>
          payoutLegs.transition(tx, other.legId, {
            from: 'planned',
            to: 'submitted',
            txHash: testHex32(),
          }),
        ),
      ).toBeUndefined();
      expect(await columnOf('ujira.payout_legs', 'status', other.legId)).toBe('planned');
    }
  },
  'receipts.issue': async () => {
    // Another tenant's payout cannot be seen, so there is no finished payout
    // to copy from.
    for (const other of foreign()) {
      expect(
        await codeOf(asAWorker(async (tx) => receipts.issue(tx, other.finishedPayoutId, null))),
      ).toBe('UJ008');
    }
  },
  'receipts.get': async () => {
    for (const other of foreign()) {
      expect(await asA(async (tx) => receipts.get(tx, other.receiptId))).toBeUndefined();
    }
    expect(await asA(async (tx) => receipts.get(tx, a.first.receiptId))).toBeDefined();
  },
  'receipts.forPayout': async () => {
    for (const other of foreign()) {
      expect(
        await asA(async (tx) => receipts.forPayout(tx, other.finishedPayoutId)),
      ).toBeUndefined();
    }
  },
  'receipts.list': async () => {
    const across = await acrossA(async (tx) => receipts.list(tx, { limit: 100 }));
    const ids = across.items.map((receipt) => receipt.id);
    expect(ids).toContain(a.first.receiptId);
    expect(ids).toContain(a.second.receiptId);
    expect(ids).not.toContain(b.first.receiptId);
    expect(ids).not.toContain(b.second.receiptId);
    const own = await asA(async (tx) => receipts.list(tx, { limit: 100 }));
    expect(own.items.map((receipt) => receipt.id)).toEqual([a.first.receiptId]);
  },
};

beforeAll(async () => {
  database = await createTestDatabase(adminUrl, import.meta.url);
  admin = new pg.Client({ connectionString: database.url });
  await admin.connect();
  db = databaseAsServiceRoles(roleUrls, database);
  a = await tenant('alpha');
  b = await tenant('bravo');
});

afterAll(async () => {
  await db.close();
  await admin.end();
  await database.drop();
});

describe('payouts across tenants', () => {
  it('has a case for every repository method, and no case without one', () => {
    expect(caseProblems(REPOSITORIES, Object.keys(cases))).toEqual([]);
  });

  it.each(Object.keys(cases))('%s cannot reach another tenant', async (name) => {
    const run = cases[name];
    if (run === undefined) throw new Error(`no case named ${name}`);
    await run();
  });

  it('refuses a payout row written for another tenant, whatever the caller names', async () => {
    const other = b.first.world;
    const planted = asA(async (tx) =>
      tx
        .insertInto('ujira.payouts')
        .values({
          principal_id: other.context.principalId,
          project_id: other.context.projectId,
          idempotency_key: 'planted',
          request_hash: Buffer.alloc(32, 1),
          mandate_id: other.mandateId,
          recipient_id: other.recipientId,
          task_id: 'planted',
          onchain_payout_id: Buffer.alloc(32, 2),
          network: TESTNET,
          chain: 'stellar',
          amount: '100',
          asset: 'USDC',
          scale: 7,
        })
        .execute(),
    );
    expect(await codeOf(planted)).toBe('42501');
  });
});
