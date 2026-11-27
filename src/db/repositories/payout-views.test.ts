// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// Payout views against a real database, as the app reads them: what a view
// carries beside the payout, pages that hold still while payouts are added,
// filters that combine, and the approvals queue oldest first. Each test gets
// a project of its own, so counts are its own.

import type { Kysely } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import type { PayoutStatus } from '../../payouts/status.js';
import type { Database, ProjectContext } from '../database.js';
import type { Schema } from '../schema.js';
import { testHex32 } from '../testing/accounts.js';
import { insertTenant } from '../testing/admin-tenants.js';
import { databaseAsServiceRoles } from '../testing/databases.js';
import { createTestDatabase, type TestDatabase } from '../testing/harness.js';
import { newPayout, payoutWorld, usdc, type PayoutWorld } from '../testing/payout-fixture.js';
import { PageRequestError } from './page.js';
import { unwiredJobQueue } from './payout-jobs.js';
import { payoutViews } from './payout-views.js';
import { payouts, type Payout } from './payouts.js';
import { receipts } from './receipts.js';
import { RepositoryInputError } from './values.js';

type Tx = Kysely<Schema>;

const adminUrl = inject('dbAdminUrl');
const roleUrls = inject('dbRoleUrls');

let database: TestDatabase;
let admin: pg.Client;
let db: Database;
let seq = 0;

async function freshWorld(): Promise<PayoutWorld> {
  seq += 1;
  return payoutWorld(db, await insertTenant(admin, `views ${String(seq)}`));
}

const asApp = async <T>(context: ProjectContext, work: (tx: Tx) => Promise<T>): Promise<T> =>
  db.tenant(context).transaction(work);

async function create(world: PayoutWorld, over: Parameters<typeof newPayout>[1] = {}) {
  return (
    await asApp(world.context, (tx) => payouts.create(tx, newPayout(world, over), unwiredJobQueue))
  ).payout;
}

// Moves a payout along allowed statuses. Reaching pending_approval records a
// request transaction, as the worker does once the chain has the request.
async function drive(
  world: PayoutWorld,
  id: string,
  path: readonly PayoutStatus[],
): Promise<Payout> {
  let current: Payout | undefined = await asApp(world.context, (tx) => payouts.get(tx, id));
  if (current === undefined) throw new Error('no payout to drive');
  for (const to of path) {
    const from: PayoutStatus = current.status;
    const hash = to === 'pending_approval' ? { requestTxHash: testHex32() } : {};
    const moved: Payout | undefined = await asApp(
      world.context,
      (tx): Promise<Payout | undefined> => payouts.transition(tx, id, { from, to, ...hash }),
    );
    if (moved === undefined) throw new Error(`the payout did not move to ${to}`);
    current = moved;
  }
  return current;
}

const idsOf = (page: { items: readonly { payout: { id: string } }[] }) =>
  page.items.map((view) => view.payout.id);

beforeAll(async () => {
  database = await createTestDatabase(adminUrl, import.meta.url);
  admin = new pg.Client({ connectionString: database.url });
  await admin.connect();
  db = databaseAsServiceRoles(roleUrls, database);
});

afterAll(async () => {
  await db.close();
  await admin.end();
  await database.drop();
});

describe('a payout view', () => {
  it('carries the mandate contract, the recipient label, the legs and the receipt', async () => {
    const world = await freshWorld();
    const payout = await create(world);
    const before = await asApp(world.context, (tx) => payoutViews.get(tx, payout.id));
    expect(before?.principalId).toBe(world.context.principalId);
    expect(before?.payout).toEqual(payout);
    expect(before?.recipient).toEqual({ id: world.recipientId, label: 'Ada' });
    expect(before?.mandate.id).toBe(world.mandateId);
    expect(before?.mandate.contractAddress).toMatch(/^C[A-Z2-7]{55}$/);
    expect(before?.legs.map((leg) => [leg.index, leg.destination])).toEqual([
      [0, world.destination],
    ]);
    expect(before?.receiptId).toBeNull();

    await drive(world, payout.id, ['failed']);
    const receipt = await db.withTenant('worker', { ...world.context, scope: 'project' }, (tx) =>
      receipts.issue(tx, payout.id, null),
    );
    const after = await asApp(world.context, (tx) => payoutViews.get(tx, payout.id));
    expect(after?.receiptId).toBe(receipt.receipt.id);
    expect(after?.payout.status).toBe('failed');
  });

  it('is found by its task on its mandate, and by nothing else', async () => {
    const world = await freshWorld();
    const other = await payoutWorld(db, world.context);
    const input = newPayout(world);
    const payout = (await asApp(world.context, (tx) => payouts.create(tx, input, unwiredJobQueue)))
      .payout;
    const found = await asApp(world.context, (tx) =>
      payoutViews.findByTask(tx, world.mandateId, input.taskId),
    );
    expect(found?.payout.id).toBe(payout.id);
    expect(found?.recipient.label).toBe('Ada');
    expect(
      await asApp(world.context, (tx) => payoutViews.findByTask(tx, other.mandateId, input.taskId)),
    ).toBeUndefined();
    expect(
      await asApp(world.context, (tx) => payoutViews.findByTask(tx, world.mandateId, 'task-none')),
    ).toBeUndefined();
  });

  it('is undefined for an id the project does not have', async () => {
    const world = await freshWorld();
    expect(
      await asApp(world.context, (tx) => payoutViews.get(tx, world.mandateId)),
    ).toBeUndefined();
  });

  it('gives each payout on a page its own legs and recipient', async () => {
    const world = await freshWorld();
    const ada = await create(world);
    const grace = await create(world, {
      recipientId: world.otherRecipientId,
      legs: [{ payoutMethodId: world.otherMethodId, amount: usdc(25_000_000n) }],
    });
    const page = await asApp(world.context, (tx) => payoutViews.list(tx, {}, { limit: 10 }));
    const byId = new Map(page.items.map((view) => [view.payout.id, view]));
    expect(byId.get(ada.id)?.recipient.label).toBe('Ada');
    expect(byId.get(grace.id)?.recipient.label).toBe('Grace');
    expect(byId.get(ada.id)?.legs.map((leg) => leg.payoutId)).toEqual([ada.id]);
    expect(byId.get(grace.id)?.legs.map((leg) => leg.payoutMethodId)).toEqual([
      world.otherMethodId,
    ]);
  });
});

describe('listing views', () => {
  it('pages newest first and holds still while payouts are added', async () => {
    const world = await freshWorld();
    const made: string[] = [];
    for (let i = 0; i < 4; i += 1) made.push((await create(world)).id);
    const newest = [...made].reverse();
    const first = await asApp(world.context, (tx) => payoutViews.list(tx, {}, { limit: 2 }));
    expect(idsOf(first)).toEqual(newest.slice(0, 2));
    // Added between pages: newer than everything, so above the first page.
    const added = [(await create(world)).id, (await create(world)).id];
    const second = await asApp(world.context, (tx) =>
      payoutViews.list(tx, {}, { limit: 2, after: first.next ?? '' }),
    );
    expect(idsOf(second)).toEqual(newest.slice(2));
    expect(second.next).toBeNull();
    const again = await asApp(world.context, (tx) => payoutViews.list(tx, {}, { limit: 2 }));
    expect(idsOf(again)).toEqual([...added].reverse());
  });

  it('combines the status list, mandate, recipient and creation time filters', async () => {
    const world = await freshWorld();
    const other = await payoutWorld(db, world.context);
    const queued = await create(world);
    const failed = await create(world);
    await drive(world, failed.id, ['failed']);
    const waiting = await create(world);
    await drive(world, waiting.id, ['submitting', 'pending_approval']);
    const grace = await create(world, {
      recipientId: world.otherRecipientId,
      legs: [{ payoutMethodId: world.otherMethodId, amount: usdc(25_000_000n) }],
    });
    const elsewhere = await create(other);
    const ids = async (filter: Parameters<typeof payoutViews.list>[1]) =>
      idsOf(
        await asApp(world.context, (tx) => payoutViews.list(tx, filter, { limit: 100 })),
      ).sort();

    expect(await ids({ statuses: ['failed'] })).toEqual([failed.id]);
    expect(await ids({ statuses: ['queued', 'pending_approval', 'queued'] })).toEqual(
      [queued.id, waiting.id, grace.id, elsewhere.id].sort(),
    );
    expect(await ids({ statuses: ['queued'], mandateId: world.mandateId })).toEqual(
      [queued.id, grace.id].sort(),
    );
    expect(
      await ids({
        statuses: ['queued'],
        mandateId: world.mandateId,
        recipientId: world.recipientId,
      }),
    ).toEqual([queued.id]);
    expect(await ids({ mandateId: other.mandateId })).toEqual([elsewhere.id]);
    expect(await ids({ statuses: ['paid'] })).toEqual([]);
  });

  it('counts createdFrom in and createdTo out', async () => {
    const world = await freshWorld();
    const payout = await create(world);
    const at = payout.createdAt;
    const ids = async (filter: Parameters<typeof payoutViews.list>[1]) =>
      idsOf(await asApp(world.context, (tx) => payoutViews.list(tx, filter, { limit: 100 })));
    // A Date holds milliseconds and the row microseconds, so the row is at or
    // just after the millisecond it reads back as.
    expect(await ids({ createdFrom: at })).toEqual([payout.id]);
    expect(await ids({ createdTo: at })).toEqual([]);
    expect(await ids({ createdFrom: new Date(at.getTime() + 1) })).toEqual([]);
    expect(await ids({ createdFrom: at, createdTo: new Date(at.getTime() + 1) })).toEqual([
      payout.id,
    ]);
  });

  it('refuses an empty status list, an unknown status and a key it did not hand out', async () => {
    const world = await freshWorld();
    await expect(
      asApp(world.context, (tx) => payoutViews.list(tx, { statuses: [] }, { limit: 10 })),
    ).rejects.toEqual(new RepositoryInputError('statuses'));
    // As a caller that skipped the type would send it.
    const sent: string = 'sent';
    await expect(
      asApp(world.context, (tx) =>
        payoutViews.list(tx, { statuses: [sent as PayoutStatus] }, { limit: 10 }),
      ),
    ).rejects.toEqual(new RepositoryInputError('statuses'));
    await expect(
      asApp(world.context, (tx) => payoutViews.list(tx, {}, { limit: 10, after: 'garbage' })),
    ).rejects.toBeInstanceOf(PageRequestError);
    await expect(
      asApp(world.context, (tx) => payoutViews.list(tx, {}, { limit: 101 })),
    ).rejects.toBeInstanceOf(PageRequestError);
  });
});

describe('the approvals queue', () => {
  it('holds only payouts waiting for approval, oldest first, in pages', async () => {
    const world = await freshWorld();
    const waiting: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const payout = await create(world);
      await drive(world, payout.id, ['submitting', 'pending_approval']);
      waiting.push(payout.id);
    }
    await create(world);
    const approved = await create(world);
    await drive(world, approved.id, ['submitting', 'pending_approval', 'approved']);

    const first = await asApp(world.context, (tx) => payoutViews.waitingApproval(tx, { limit: 2 }));
    expect(idsOf(first)).toEqual(waiting.slice(0, 2));
    expect(first.items.every((view) => view.payout.status === 'pending_approval')).toBe(true);
    // A payout that starts waiting meanwhile joins the back of the queue.
    const late = await create(world);
    await drive(world, late.id, ['submitting', 'pending_approval']);
    const rest = await asApp(world.context, (tx) =>
      payoutViews.waitingApproval(tx, { limit: 2, after: first.next ?? '' }),
    );
    expect(idsOf(rest)).toEqual([waiting[2], late.id]);
    expect(rest.next).toBeNull();
  });

  it('is empty for a project with nothing waiting', async () => {
    const world = await freshWorld();
    await create(world);
    expect(
      await asApp(world.context, (tx) => payoutViews.waitingApproval(tx, { limit: 10 })),
    ).toEqual({ items: [], next: null });
  });
});
