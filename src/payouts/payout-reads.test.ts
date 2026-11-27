// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The read service over views held in memory and a chain that answers as each
// test says: what it asks the store for, the timeline it draws from a payout,
// and the budget the approvals queue reads from the chain.

import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  CONTRACT,
  CREATED,
  MOVED,
  paidView,
  TENANT,
  TX,
  usdc,
  viewOf,
} from '../../test/payout-view-helpers.js';
import {
  ChainError,
  type CallOptions,
  type ChainAdapter,
  type MandateConfigView,
  type MandateStateView,
} from '../chain/adapter.js';
import type {
  Page,
  PageRequest,
  PayoutView,
  PayoutViewFilter,
  ProjectContext,
} from '../db/index.js';
import {
  createPayoutReadService,
  PayoutReadError,
  timelineOf,
  type PayoutReadStore,
} from './payout-reads.js';

interface StoreCalls {
  readonly list: { context: ProjectContext; filter: PayoutViewFilter; page: PageRequest }[];
  readonly get: { context: ProjectContext; id: string }[];
  readonly byTask: { context: ProjectContext; mandateId: string; taskId: string }[];
  readonly waiting: { context: ProjectContext; page: PageRequest }[];
}

function storeOf(items: readonly PayoutView[], next: string | null = null) {
  const calls: StoreCalls = { list: [], get: [], byTask: [], waiting: [] };
  const page: Page<PayoutView> = { items, next };
  const store: PayoutReadStore = {
    list: (context, filter, request) => {
      calls.list.push({ context, filter, page: request });
      return Promise.resolve(page);
    },
    get: (context, id) => {
      calls.get.push({ context, id });
      return Promise.resolve(items.find((view) => view.payout.id === id));
    },
    findByTask: (context, mandateId, taskId) => {
      calls.byTask.push({ context, mandateId, taskId });
      return Promise.resolve(
        items.find((view) => view.mandate.id === mandateId && view.payout.taskId === taskId),
      );
    },
    waitingApproval: (context, request) => {
      calls.waiting.push({ context, page: request });
      return Promise.resolve(page);
    },
  };
  return { store, calls };
}

function config(totalBudget: bigint): MandateConfigView {
  return {
    principal: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
    asset: 'CASSET',
    recipientMode: 1,
    agents: [],
    approvers: [],
    approvalsRequired: 1,
    executors: [],
    limits: {
      totalBudget,
      perPaymentCap: totalBudget,
      perRecipientDailyCap: totalBudget,
      approvalThreshold: 0n,
      payoutTtlSeconds: 86_400n,
      expiresAt: 1_900_000_000n,
    },
    maxFeeBps: 0,
    feeAddress: '',
  };
}

function state(spent: bigint, committed: bigint): MandateStateView {
  return {
    spent,
    pending: committed,
    committed,
    balance: 0n,
    free: 0n,
    paused: false,
    revoked: false,
    expired: false,
  };
}

type ReadMandate = ChainAdapter['readMandate'];

function chainOf(read: ReadMandate, network: ChainAdapter['network'] = 'stellar:testnet') {
  const reads: string[] = [];
  const chain: Pick<ChainAdapter, 'network' | 'readMandate'> = {
    network,
    readMandate: (contract, o) => {
      reads.push(contract);
      return read(contract, o);
    },
  };
  return { chain, reads };
}

const budget =
  (total: bigint, spent: bigint, committed: bigint): ReadMandate =>
  () =>
    Promise.resolve({ config: config(total), state: state(spent, committed) });

describe('timelineOf', () => {
  it('shows only the creation of a payout still queued', () => {
    expect(timelineOf(viewOf())).toEqual([
      { event: 'created', at: CREATED, legIndex: null, txHash: null },
    ]);
  });

  it('shows the request, each leg that moved and how the payout ended', () => {
    expect(timelineOf(paidView())).toEqual([
      { event: 'created', at: CREATED, legIndex: null, txHash: null },
      { event: 'requested', at: null, legIndex: null, txHash: TX },
      { event: 'leg_settled', at: MOVED, legIndex: 0, txHash: TX },
      { event: 'paid', at: MOVED, legIndex: null, txHash: null },
    ]);
  });

  it('dates a payout that has not finished by its last move', () => {
    const view = viewOf({
      payout: { status: 'pending_approval', requestTxHash: TX, updatedAt: MOVED },
    });
    expect(timelineOf(view).at(-1)).toEqual({
      event: 'pending_approval',
      at: MOVED,
      legIndex: null,
      txHash: null,
    });
  });

  it('leaves planned legs out and keeps the others in leg order', () => {
    const view = viewOf({
      payout: { status: 'settling', requestTxHash: TX, updatedAt: MOVED },
      legs: [{}, { status: 'submitted', txHash: TX, updatedAt: MOVED }],
    });
    expect(timelineOf(view).map((entry) => [entry.event, entry.legIndex])).toEqual([
      ['created', null],
      ['requested', null],
      ['leg_submitted', 1],
      ['settling', null],
    ]);
  });
});

describe('list and get', () => {
  it('passes only the filters it was given, and the page', async () => {
    const { store, calls } = storeOf([viewOf()], 'next-key');
    const service = createPayoutReadService({ store, chain: chainOf(budget(0n, 0n, 0n)).chain });
    const from = new Date('2026-11-01T00:00:00.000Z');
    const page = await service.list(TENANT, {
      statuses: ['queued', 'paid'],
      mandateId: undefined,
      createdFrom: from,
      after: undefined,
      limit: 20,
    });
    expect(page.next).toBe('next-key');
    expect(calls.list).toEqual([
      {
        context: TENANT,
        filter: { statuses: ['queued', 'paid'], createdFrom: from },
        page: { limit: 20 },
      },
    ]);
    await service.list(TENANT, {
      mandateId: 'm',
      recipientId: 'r',
      createdTo: from,
      after: 'k',
      limit: 5,
    });
    expect(calls.list[1]).toEqual({
      context: TENANT,
      filter: { mandateId: 'm', recipientId: 'r', createdTo: from },
      page: { limit: 5, after: 'k' },
    });
  });

  it('finds one payout, and says so with a typed error when there is none', async () => {
    const view = viewOf();
    const { store } = storeOf([view]);
    const service = createPayoutReadService({ store, chain: chainOf(budget(0n, 0n, 0n)).chain });
    expect(await service.get(TENANT, view.payout.id)).toBe(view);
    const missing = service.get(TENANT, randomUUID());
    await expect(missing).rejects.toBeInstanceOf(PayoutReadError);
    await expect(missing).rejects.toMatchObject({ code: 'PAYOUT_NOT_FOUND' });
  });
});

describe('byTask', () => {
  it('finds the payout of a task on a mandate, and nothing for another task', async () => {
    const view = viewOf();
    const { store, calls } = storeOf([view]);
    const service = createPayoutReadService({ store, chain: chainOf(budget(0n, 0n, 0n)).chain });
    expect(await service.byTask(TENANT, view.mandate.id, view.payout.taskId)).toBe(view);
    expect(await service.byTask(TENANT, view.mandate.id, 'task-other')).toBeUndefined();
    expect(calls.byTask).toEqual([
      { context: TENANT, mandateId: view.mandate.id, taskId: view.payout.taskId },
      { context: TENANT, mandateId: view.mandate.id, taskId: 'task-other' },
    ]);
  });
});

describe('approvals', () => {
  const waiting = (mandateId: string) =>
    viewOf({ mandateId, payout: { status: 'pending_approval', requestTxHash: TX } });

  it('reads each mandate once and takes what is spent and set aside off its budget', async () => {
    const shared = randomUUID();
    const { store, calls } = storeOf([waiting(shared), waiting(shared)], 'k');
    const { chain, reads } = chainOf(budget(50_000_000_000n, 1_200_000_000n, 3_000_000_000n));
    const page = await createPayoutReadService({ store, chain }).approvals(
      TENANT,
      { limit: 100 },
      'req-1',
    );
    expect(reads).toEqual([CONTRACT]);
    expect(page.next).toBe('k');
    expect(page.items.map((item) => item.budgetLeft)).toEqual([
      usdc(45_800_000_000n),
      usdc(45_800_000_000n),
    ]);
    expect(calls.waiting).toEqual([{ context: TENANT, page: { limit: 100 } }]);
  });

  it('never shows a budget below zero', async () => {
    const { store } = storeOf([waiting(randomUUID())]);
    const { chain } = chainOf(budget(10n, 8n, 5n));
    const page = await createPayoutReadService({ store, chain }).approvals(
      TENANT,
      { limit: 1 },
      'r',
    );
    expect(page.items[0]?.budgetLeft).toEqual(usdc(0n));
  });

  it('leaves the budget null and logs the code alone when the chain fails', async () => {
    const lines: string[] = [];
    const { store } = storeOf([waiting(randomUUID())]);
    const { chain } = chainOf(() =>
      Promise.reject(new ChainError('UNAVAILABLE', `rpc down for ${CONTRACT}`)),
    );
    const page = await createPayoutReadService({
      store,
      chain,
      log: (line) => lines.push(line),
    }).approvals(TENANT, { limit: 1, after: 'k' }, 'req-2');
    expect(page.items[0]?.budgetLeft).toBeNull();
    expect(lines).toEqual(['event=approvals_budget_unread correlationId=req-2 code=UNAVAILABLE']);
    expect(lines.join('\n')).not.toContain(CONTRACT);
  });

  it('lets an error that is not the chain surface', async () => {
    const { store } = storeOf([waiting(randomUUID())]);
    const { chain } = chainOf(() => Promise.reject(new TypeError('bug')));
    await expect(
      createPayoutReadService({ store, chain }).approvals(TENANT, { limit: 1 }, 'r'),
    ).rejects.toBeInstanceOf(TypeError);
  });

  it('does not ask a chain on another network about a mandate', async () => {
    const { store } = storeOf([waiting(randomUUID())]);
    const { chain, reads } = chainOf(budget(10n, 0n, 0n), 'stellar:pubnet');
    const page = await createPayoutReadService({ store, chain }).approvals(
      TENANT,
      { limit: 1 },
      'r',
    );
    expect(reads).toEqual([]);
    expect(page.items[0]?.budgetLeft).toBeNull();
  });

  it('gives every read on a page one deadline, and asks nothing once it has passed', async () => {
    const lines: string[] = [];
    const mandates = [randomUUID(), randomUUID(), randomUUID()];
    const { store } = storeOf(mandates.map(waiting));
    // Hangs until the call's own deadline aborts it, as a silent RPC would.
    const { chain, reads } = chainOf(
      (_contract, o: CallOptions) =>
        new Promise((_resolve, reject) => {
          o.signal.addEventListener('abort', () => {
            reject(new ChainError('TIMEOUT', 'no answer'));
          });
        }),
    );
    const page = await createPayoutReadService({
      store,
      chain,
      chainTimeoutMs: 20,
      chainConcurrency: 1,
      log: (line) => lines.push(line),
    }).approvals(TENANT, { limit: 3 }, 'r');
    expect(reads).toHaveLength(1);
    expect(page.items.map((item) => item.budgetLeft)).toEqual([null, null, null]);
    expect(lines).toHaveLength(3);
    expect(lines.every((line) => line.endsWith('code=TIMEOUT'))).toBe(true);
  });

  it('reads no more mandates at once than it is allowed', async () => {
    let inFlight = 0;
    let most = 0;
    const { store } = storeOf(Array.from({ length: 9 }, () => waiting(randomUUID())));
    const { chain, reads } = chainOf(async () => {
      inFlight += 1;
      most = Math.max(most, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 2));
      inFlight -= 1;
      return { config: config(10n), state: state(0n, 0n) };
    });
    await createPayoutReadService({ store, chain, chainConcurrency: 3 }).approvals(
      TENANT,
      { limit: 9 },
      'r',
    );
    expect(reads).toHaveLength(9);
    expect(most).toBe(3);
  });

  it('asks the chain nothing for an empty queue', async () => {
    const { store } = storeOf([]);
    const { chain, reads } = chainOf(budget(10n, 0n, 0n));
    const page = await createPayoutReadService({ store, chain }).approvals(
      TENANT,
      { limit: 5 },
      'r',
    );
    expect(page).toEqual({ items: [], next: null });
    expect(reads).toEqual([]);
  });
});
