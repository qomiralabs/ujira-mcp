// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// Reading payouts back: the project's list, one payout with what happened to
// it, and the approvals queue. The database is the record; only the queue
// asks the chain anything, for how much budget each waiting mandate has left,
// because that is what an approver weighs and it lives on the contract.
//
// The budget is a help, not the record, so a chain that does not answer in
// time leaves it null for that mandate and the queue still loads. The person
// can still approve: the contract checks the budget again when they sign.

import { callOptions, ChainError, type ChainAdapter, type CallOptions } from '../chain/adapter.js';
import {
  payoutViews,
  type Database,
  type Page,
  type PageRequest,
  type PayoutView,
  type PayoutViewFilter,
  type ProjectContext,
} from '../db/index.js';
import { tokenAmount, type TokenAmount } from '../money/index.js';
import type { LegStatus } from './leg-status.js';
import type { PayoutStatus } from './status.js';

export type PayoutReadErrorCode = 'PAYOUT_NOT_FOUND';

export class PayoutReadError extends Error {
  override readonly name = 'PayoutReadError';

  constructor(
    readonly code: PayoutReadErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface PayoutListQuery {
  readonly statuses?: readonly PayoutStatus[] | undefined;
  readonly mandateId?: string | undefined;
  readonly recipientId?: string | undefined;
  readonly createdFrom?: Date | undefined;
  readonly createdTo?: Date | undefined;
  readonly after?: string | undefined;
  readonly limit: number;
}

export interface ApprovalView extends PayoutView {
  // What the mandate's total budget still allows once what is spent and what
  // is set aside for waiting payouts, this one included, are taken off. Null
  // when the chain did not say.
  readonly budgetLeft: TokenAmount | null;
}

export interface PayoutReadService {
  list(context: ProjectContext, query: PayoutListQuery): Promise<Page<PayoutView>>;
  get(context: ProjectContext, id: string): Promise<PayoutView>;
  // Undefined when the task has no payout on that mandate in this project.
  byTask(
    context: ProjectContext,
    mandateId: string,
    taskId: string,
  ): Promise<PayoutView | undefined>;
  approvals(
    context: ProjectContext,
    page: { readonly after?: string | undefined; readonly limit: number },
    correlationId: string,
  ): Promise<Page<ApprovalView>>;
}

// Where the views come from, each read in one transaction under the tenant.
// A port, so the service can be run against rows held in memory.
export interface PayoutReadStore {
  list(
    context: ProjectContext,
    filter: PayoutViewFilter,
    page: PageRequest,
  ): Promise<Page<PayoutView>>;
  get(context: ProjectContext, id: string): Promise<PayoutView | undefined>;
  findByTask(
    context: ProjectContext,
    mandateId: string,
    taskId: string,
  ): Promise<PayoutView | undefined>;
  waitingApproval(context: ProjectContext, page: PageRequest): Promise<Page<PayoutView>>;
}

export function databasePayoutReads(db: Database): PayoutReadStore {
  return {
    list: (context, filter, page) =>
      db.tenant(context).transaction((tx) => payoutViews.list(tx, filter, page)),
    get: (context, id) => db.tenant(context).transaction((tx) => payoutViews.get(tx, id)),
    findByTask: (context, mandateId, taskId) =>
      db.tenant(context).transaction((tx) => payoutViews.findByTask(tx, mandateId, taskId)),
    waitingApproval: (context, page) =>
      db.tenant(context).transaction((tx) => payoutViews.waitingApproval(tx, page)),
  };
}

export interface PayoutReadServiceOptions {
  readonly store: PayoutReadStore;
  readonly chain: Pick<ChainAdapter, 'network' | 'readMandate'>;
  // One deadline for every chain read a queue page makes; the adapter's
  // default when absent.
  readonly chainTimeoutMs?: number;
  // How many mandates are read from the chain at once.
  readonly chainConcurrency?: number;
  readonly log?: (line: string) => void;
}

export const DEFAULT_CHAIN_CONCURRENCY = 4;

export type TimelineEvent =
  | 'created'
  | 'requested'
  | `leg_${Exclude<LegStatus, 'planned'>}`
  | Exclude<PayoutStatus, 'queued'>;

export interface TimelineEntry {
  readonly event: TimelineEvent;
  // When it happened, or null where the database keeps no time for it.
  readonly at: Date | null;
  readonly legIndex: number | null;
  readonly txHash: string | null;
}

/**
 * What the record proves happened to a payout, in order. Only the creation,
 * each leg's latest move, the payout's latest move and the payment carry a
 * time, since those are the times kept; the request transaction is shown by
 * its hash. Nothing is inferred, so a step the record cannot prove is absent.
 */
export function timelineOf(view: PayoutView): TimelineEntry[] {
  const { payout } = view;
  const entries: TimelineEntry[] = [
    { event: 'created', at: payout.createdAt, legIndex: null, txHash: null },
  ];
  if (payout.requestTxHash !== null) {
    entries.push({ event: 'requested', at: null, legIndex: null, txHash: payout.requestTxHash });
  }
  for (const leg of view.legs) {
    if (leg.status === 'planned') continue;
    entries.push({
      event: `leg_${leg.status}`,
      at: leg.updatedAt,
      legIndex: leg.index,
      txHash: leg.txHash,
    });
  }
  if (payout.status !== 'queued') {
    entries.push({
      event: payout.status,
      at: payout.settledAt ?? payout.updatedAt,
      legIndex: null,
      txHash: null,
    });
  }
  return entries;
}

function filterOf(query: PayoutListQuery): PayoutViewFilter {
  return {
    ...(query.statuses === undefined ? {} : { statuses: query.statuses }),
    ...(query.mandateId === undefined ? {} : { mandateId: query.mandateId }),
    ...(query.recipientId === undefined ? {} : { recipientId: query.recipientId }),
    ...(query.createdFrom === undefined ? {} : { createdFrom: query.createdFrom }),
    ...(query.createdTo === undefined ? {} : { createdTo: query.createdTo }),
  };
}

function pageRequest(page: {
  readonly after?: string | undefined;
  readonly limit: number;
}): PageRequest {
  return { limit: page.limit, ...(page.after === undefined ? {} : { after: page.after }) };
}

async function eachLimited<T>(
  items: readonly T[],
  concurrency: number,
  work: (item: T) => Promise<void>,
): Promise<void> {
  const queue = [...items];
  const worker = async (): Promise<void> => {
    for (let item = queue.shift(); item !== undefined; item = queue.shift()) await work(item);
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
}

export function createPayoutReadService(o: PayoutReadServiceOptions): PayoutReadService {
  const log = o.log ?? (() => undefined);
  const concurrency = Math.max(1, o.chainConcurrency ?? DEFAULT_CHAIN_CONCURRENCY);

  async function budgetLeft(
    view: PayoutView,
    call: CallOptions,
    correlationId: string,
  ): Promise<TokenAmount | null> {
    const { payout } = view;
    // A mandate on a network this server does not serve cannot be read here.
    if (payout.network !== o.chain.network) return null;
    // A page with many mandates shares one deadline; once it has passed, the
    // rest are not asked at all.
    if (call.signal.aborted) {
      log(`event=approvals_budget_unread correlationId=${correlationId} code=TIMEOUT`);
      return null;
    }
    try {
      const { config, state } = await o.chain.readMandate(view.mandate.contractAddress, call);
      const left = config.limits.totalBudget - state.spent - state.committed;
      return tokenAmount(left > 0n ? left : 0n, payout.amount.asset, payout.amount.chain);
    } catch (error) {
      if (!(error instanceof ChainError)) throw error;
      log(`event=approvals_budget_unread correlationId=${correlationId} code=${error.code}`);
      return null;
    }
  }

  return {
    async list(context, query) {
      return o.store.list(context, filterOf(query), pageRequest(query));
    },

    async get(context, id) {
      const view = await o.store.get(context, id);
      if (view === undefined) {
        throw new PayoutReadError('PAYOUT_NOT_FOUND', 'no such payout in this project');
      }
      return view;
    },

    async byTask(context, mandateId, taskId) {
      return o.store.findByTask(context, mandateId, taskId);
    },

    async approvals(context, page, correlationId) {
      const found = await o.store.waitingApproval(context, pageRequest(page));
      // The chain is read after the transaction ends, so a slow chain never
      // holds a database connection.
      const byMandate = new Map<string, PayoutView>();
      for (const view of found.items) {
        if (!byMandate.has(view.mandate.id)) byMandate.set(view.mandate.id, view);
      }
      const call = callOptions(correlationId, o.chainTimeoutMs);
      const left = new Map<string, TokenAmount | null>();
      await eachLimited([...byMandate.values()], concurrency, async (view) => {
        left.set(view.mandate.id, await budgetLeft(view, call, correlationId));
      });
      return {
        items: found.items.map((view) => ({
          ...view,
          budgetLeft: left.get(view.mandate.id) ?? null,
        })),
        next: found.next,
      };
    },
  };
}
