// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// Receipts end to end on a real database and its tenant policies: the
// receipt.issue task as the worker runs it, then the receipt service the
// routes read through. The chain is not called to issue; verify is covered
// against a recorded testnet transaction in src/receipts/verify.test.ts.

import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { receiptRef } from '../src/chain/stellar/wallet-proof.js';
import {
  payoutLegs,
  payouts,
  receipts,
  unwiredJobQueue,
  type Database,
  type Payout,
  type QueuedJob,
} from '../src/db/index.js';
import {
  createTestDatabase,
  databaseAsServiceRoles,
  newPayout,
  payoutWorld,
  queueFixture,
  type PayoutWorld,
  type QueueFixture,
  type TestDatabase,
} from '../src/db/testing/index.js';
import { createReceiptService } from '../src/receipts/service.js';
import { payoutJobHandler, type WorkerTransaction } from '../src/worker/payout-jobs.js';
import { receiptTask } from '../src/worker/receipt-task.js';

const adminUrl = inject('dbAdminUrl');
const roleUrls = inject('dbRoleUrls');

let database: TestDatabase;
let fixture: QueueFixture;
let db: Database;
let world: PayoutWorld;
let other: PayoutWorld;
const lines: string[] = [];

const chain = {
  network: 'stellar:testnet' as const,
  receiptRef: (hash: string, index: number) => receiptRef('stellar:testnet', hash, index),
  transfers: () => Promise.reject(new Error('issuing never reads the chain')),
};

beforeAll(async () => {
  database = await createTestDatabase(adminUrl, import.meta.url);
  fixture = await queueFixture(database);
  db = databaseAsServiceRoles(roleUrls, database, 4);
  world = await payoutWorld(db, await fixture.tenant('Receipts'));
  other = await payoutWorld(db, await fixture.tenant('Someone else'));
});

afterAll(async () => {
  await db.close();
  await fixture.close();
  await database.drop();
});

const handler = () =>
  payoutJobHandler(db, receiptTask({ chain, log: (line) => lines.push(line) }), (line) =>
    lines.push(line),
  );

function job(payoutId: string, on: PayoutWorld = world, attempt = 1): QueuedJob {
  return {
    id: randomUUID(),
    task: 'receipt.issue',
    payload: { ...on.context, payoutId },
    attempt,
    maxAttempts: 10,
    signal: new AbortController().signal,
  };
}

const asWorker = <T>(on: PayoutWorld, work: (tx: WorkerTransaction) => Promise<T>): Promise<T> =>
  db.withTenant('worker', { ...on.context, scope: 'project' }, work);

async function blocked(on: PayoutWorld = world): Promise<Payout> {
  const created = await db
    .tenant(on.context)
    .transaction((tx) =>
      payouts.create(tx, newPayout(on, { blockedBy: 'PER_PAYMENT_CAP_EXCEEDED' }), unwiredJobQueue),
    );
  return created.payout;
}

async function paid(txHash: string): Promise<Payout> {
  const created = await db
    .tenant(world.context)
    .transaction((tx) => payouts.create(tx, newPayout(world), unwiredJobQueue));
  const id = created.payout.id;
  const legId = created.legs[0]?.id ?? '';
  await asWorker(world, async (tx) => {
    await payouts.transition(tx, id, { from: 'queued', to: 'submitting' });
    await payouts.transition(tx, id, {
      from: 'submitting',
      to: 'approved',
      requestTxHash: 'e'.repeat(64),
    });
    await payouts.transition(tx, id, { from: 'approved', to: 'settling' });
    await payoutLegs.transition(tx, legId, { from: 'planned', to: 'submitted', txHash });
    await payoutLegs.transition(tx, legId, { from: 'submitted', to: 'settled' });
    await payouts.transition(tx, id, { from: 'settling', to: 'paid' });
  });
  return created.payout;
}

async function receiptsOf(on: PayoutWorld, payoutId: string): Promise<number> {
  const found = await asWorker(on, (tx) => receipts.forPayout(tx, payoutId));
  return found === undefined ? 0 : 1;
}

describe('receipt.issue', () => {
  it('writes exactly one receipt, even when the task runs twice or races itself', async () => {
    const payout = await blocked();
    await handler()(job(payout.id));
    await handler()(job(payout.id));
    await Promise.all([handler()(job(payout.id)), handler()(job(payout.id))]);
    const issued = lines.filter(
      (line) => line.includes('event=receipt_issued') && line.includes(payout.id),
    );
    expect(issued).toHaveLength(4);
    expect(issued.filter((line) => line.includes('created=true'))).toHaveLength(1);
    expect(await receiptsOf(world, payout.id)).toBe(1);
  });

  it("names the blocked payout's refusing rule and no transaction", async () => {
    const payout = await blocked();
    await handler()(job(payout.id));
    const service = createReceiptService({ db, chain });
    const [view] = (
      await service.list(world.context, { limit: 100, statuses: ['blocked'] })
    ).items.filter((item) => item.payoutId === payout.id);
    expect(view).toMatchObject({
      outcome: 'blocked',
      blockedBy: 'PER_PAYMENT_CAP_EXCEEDED',
      txHash: null,
      ref: null,
    });
  });

  it('references the transaction that paid a paid payout', async () => {
    const hash = 'ab'.repeat(32);
    const payout = await paid(hash);
    await handler()(job(payout.id));
    const service = createReceiptService({ db, chain });
    const page = await service.list(world.context, { limit: 100, statuses: ['paid'] });
    const view = page.items.find((item) => item.payoutId === payout.id);
    expect(view).toMatchObject({
      outcome: 'paid',
      txHash: hash,
      ref: `ujira:tx:v1:stellar:testnet:${hash}:0`,
      requestTxHash: 'e'.repeat(64),
    });
    if (view === undefined) throw new Error('no receipt listed');
    expect(await service.get(world.context, view.id)).toEqual(view);
  });

  it('does not issue for a payout still moving, and dead letters it on the last try', async () => {
    const created = await db
      .tenant(world.context)
      .transaction((tx) => payouts.create(tx, newPayout(world), unwiredJobQueue));
    const id = created.payout.id;
    await expect(handler()(job(id))).rejects.toMatchObject({ code: 'RECEIPT_NOT_FINISHED' });
    await expect(handler()(job(id, world, 10))).rejects.toMatchObject({
      code: 'RECEIPT_NOT_FINISHED',
    });
    expect(await receiptsOf(world, id)).toBe(0);
    expect(
      lines.some(
        (line) => line.includes(`payout=${id}`) && line.includes('payout_status=needs_attention'),
      ),
    ).toBe(true);
  });

  it("ends at once for a payout the job's tenant does not have, another tenant's included", async () => {
    const theirs = await blocked(other);
    await handler()(job(theirs.id, world));
    await handler()(job(randomUUID(), world));
    expect(await receiptsOf(other, theirs.id)).toBe(0);
    expect(
      lines.filter(
        (line) =>
          line.includes('event=payout_dead_letter') && line.includes('reason=TARGET_MISSING'),
      ),
    ).toHaveLength(2);
  });
});

describe('the receipt service', () => {
  it('filters by mandate, recipient, status and issue time, and pages newest first', async () => {
    const service = createReceiptService({ db, chain });
    const first = await blocked();
    const second = await blocked();
    await handler()(job(first.id));
    await handler()(job(second.id));
    const byMandate = await service.list(world.context, { limit: 100, mandateId: world.mandateId });
    const ids = byMandate.items.map((item) => item.payoutId);
    expect(ids.indexOf(second.id)).toBeLessThan(ids.indexOf(first.id));
    expect(
      (await service.list(world.context, { limit: 100, mandateId: other.mandateId })).items,
    ).toEqual([]);
    expect(
      (await service.list(world.context, { limit: 100, recipientId: world.otherRecipientId }))
        .items,
    ).toEqual([]);
    const future = new Date(Date.now() + 60_000);
    expect((await service.list(world.context, { limit: 100, issuedFrom: future })).items).toEqual(
      [],
    );
    const onePage = await service.list(world.context, { limit: 1 });
    expect(onePage.items).toHaveLength(1);
    expect(onePage.next).not.toBeNull();
    const next = await service.list(world.context, { limit: 1, after: onePage.next ?? '' });
    expect(next.items[0]?.id).not.toBe(onePage.items[0]?.id);
  });

  it('exports every receipt the filter selects, across pages, with minor units', async () => {
    const service = createReceiptService({ db, chain });
    for (let i = 0; i < 3; i += 1) {
      const payout = await blocked();
      await handler()(job(payout.id));
    }
    const chunks: string[] = [];
    for await (const chunk of service.exportCsv(world.context, { statuses: ['blocked'] })) {
      chunks.push(chunk);
    }
    const text = chunks.join('');
    const listed = await service.list(world.context, { limit: 100, statuses: ['blocked'] });
    const rows = text.trimEnd().split('\r\n');
    expect(rows[0]?.startsWith('receipt_id,payout_id,task_id,recipient,amount,')).toBe(true);
    expect(rows).toHaveLength(listed.items.length + 1);
    expect(text).toContain(',2.5,USDC,blocked,PER_PAYMENT_CAP_EXCEEDED,,');
    expect(text).toContain(',25000000,0,7,stellar:testnet,');
  });

  it("does not read another tenant's receipt", async () => {
    const service = createReceiptService({ db, chain });
    const theirs = await blocked(other);
    await payoutJobHandler(
      db,
      receiptTask({ chain, log: () => undefined }),
      () => undefined,
    )(job(theirs.id, other));
    const [mine] = (await service.list(other.context, { limit: 1 })).items;
    if (mine === undefined) throw new Error('the other tenant has no receipt');
    await expect(service.get(world.context, mine.id)).rejects.toMatchObject({
      code: 'RECEIPT_NOT_FOUND',
    });
    await expect(service.verify(world.context, mine.id, 'req')).rejects.toMatchObject({
      code: 'RECEIPT_NOT_FOUND',
    });
  });
});
