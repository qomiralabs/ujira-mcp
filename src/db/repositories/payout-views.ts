// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// Payouts as a person reads them: each with its mandate's contract, the
// recipient's label, its legs and its receipt. A page costs the same five
// queries whether it holds one payout or a hundred, so a list never turns
// into a query per row, and every query runs under the caller's tenant
// policies, so another project's rows are simply not there.

import type { Kysely } from 'kysely';

import { isPayoutStatus, type PayoutStatus } from '../../payouts/status.js';
import type { Schema } from '../schema.js';
import { PAGE_TIME, newerThan, olderThan, pageKey } from './newest-first.js';
import { checkedLimit, type Page, type PageRequest } from './page.js';
import {
  legColumns,
  payoutColumns,
  toLeg,
  toPayout,
  type Payout,
  type PayoutLeg,
  type PayoutRow,
} from './payouts.js';
import { RepositoryInputError } from './values.js';

type Tx = Kysely<Schema>;

export interface PayoutView {
  readonly principalId: string;
  readonly payout: Payout;
  readonly mandate: { readonly id: string; readonly contractAddress: string };
  readonly recipient: { readonly id: string; readonly label: string };
  // In leg order.
  readonly legs: readonly PayoutLeg[];
  // Set once the payout has finished and its receipt is written.
  readonly receiptId: string | null;
}

export interface PayoutViewFilter {
  // Any of these. Every status when absent; an empty list is refused, since
  // it can only be a caller's mistake.
  readonly statuses?: readonly PayoutStatus[];
  readonly mandateId?: string;
  readonly recipientId?: string;
  // Inclusive.
  readonly createdFrom?: Date;
  // Exclusive.
  readonly createdTo?: Date;
}

type PagedRow = PayoutRow & { readonly page_time: string };

function byId<T extends { readonly id: string }>(rows: readonly T[]): Map<string, T> {
  return new Map(rows.map((row) => [row.id, row]));
}

// Foreign keys tie each payout to its mandate and recipient inside one
// tenant, so a missing one means the policies and the keys disagree.
function found<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`a payout names a ${what} this transaction cannot see`);
  return value;
}

async function viewsOf(db: Tx, rows: readonly PayoutRow[]): Promise<PayoutView[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((row) => row.id);
  const mandates = byId(
    await db
      .selectFrom('ujira.mandates')
      .select(['id', 'contract_address'])
      .where('id', 'in', [...new Set(rows.map((row) => row.mandate_id))])
      .execute(),
  );
  const recipients = byId(
    await db
      .selectFrom('ujira.recipients')
      .select(['id', 'label'])
      .where('id', 'in', [...new Set(rows.map((row) => row.recipient_id))])
      .execute(),
  );
  const legs = new Map<string, PayoutLeg[]>();
  const legRows = await db
    .selectFrom('ujira.payout_legs')
    .select(legColumns)
    .where('payout_id', 'in', ids)
    .orderBy('payout_id')
    .orderBy('leg_index')
    .execute();
  for (const row of legRows) {
    const list = legs.get(row.payout_id) ?? [];
    list.push(toLeg(row));
    legs.set(row.payout_id, list);
  }
  const receipts = new Map(
    (
      await db
        .selectFrom('ujira.receipts')
        .select(['id', 'payout_id'])
        .where('payout_id', 'in', ids)
        .execute()
    ).map((row) => [row.payout_id, row.id]),
  );
  return rows.map((row) => {
    const mandate = found(mandates.get(row.mandate_id), 'mandate');
    const recipient = found(recipients.get(row.recipient_id), 'recipient');
    return {
      principalId: row.principal_id,
      payout: toPayout(row),
      mandate: { id: mandate.id, contractAddress: mandate.contract_address },
      recipient: { id: recipient.id, label: recipient.label },
      legs: legs.get(row.id) ?? [],
      receiptId: receipts.get(row.id) ?? null,
    };
  });
}

async function pageOfViews(
  db: Tx,
  rows: readonly PagedRow[],
  limit: number,
): Promise<Page<PayoutView>> {
  // One row past the limit was fetched to learn whether a next page exists,
  // so the views are built for the page alone.
  const shown = rows.slice(0, limit);
  const last = shown.at(-1);
  return {
    items: await viewsOf(db, shown),
    next: rows.length > limit && last !== undefined ? pageKey(last) : null,
  };
}

function checkedStatuses(statuses: readonly PayoutStatus[]): PayoutStatus[] {
  if (statuses.length === 0 || statuses.some((status) => !isPayoutStatus(status))) {
    throw new RepositoryInputError('statuses');
  }
  return [...new Set(statuses)];
}

export const payoutViews = {
  // Newest first, by creation time and then id, so a page stays put while
  // payouts are added above it.
  list: async (db: Tx, filter: PayoutViewFilter, page: PageRequest): Promise<Page<PayoutView>> => {
    const limit = checkedLimit(page.limit);
    let query = db
      .selectFrom('ujira.payouts')
      .select([...payoutColumns, PAGE_TIME.as('page_time')])
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(limit + 1);
    if (filter.statuses !== undefined) {
      query = query.where('status', 'in', checkedStatuses(filter.statuses));
    }
    if (filter.mandateId !== undefined) query = query.where('mandate_id', '=', filter.mandateId);
    if (filter.recipientId !== undefined) {
      query = query.where('recipient_id', '=', filter.recipientId);
    }
    if (filter.createdFrom !== undefined) {
      query = query.where('created_at', '>=', filter.createdFrom);
    }
    if (filter.createdTo !== undefined) query = query.where('created_at', '<', filter.createdTo);
    if (page.after !== undefined) query = query.where(olderThan(page.after));
    return pageOfViews(db, await query.execute(), limit);
  },

  // The approvals queue: payouts waiting on an approver, oldest first, so the
  // one that has waited longest, and is nearest its time limit, comes first.
  waitingApproval: async (db: Tx, page: PageRequest): Promise<Page<PayoutView>> => {
    const limit = checkedLimit(page.limit);
    let query = db
      .selectFrom('ujira.payouts')
      .select([...payoutColumns, PAGE_TIME.as('page_time')])
      .where('status', '=', 'pending_approval')
      .orderBy('created_at', 'asc')
      .orderBy('id', 'asc')
      .limit(limit + 1);
    if (page.after !== undefined) query = query.where(newerThan(page.after));
    return pageOfViews(db, await query.execute(), limit);
  },

  get: async (db: Tx, id: string): Promise<PayoutView | undefined> => {
    const row = await db
      .selectFrom('ujira.payouts')
      .select(payoutColumns)
      .where('id', '=', id)
      .executeTakeFirst();
    if (row === undefined) return undefined;
    const [view] = await viewsOf(db, [row]);
    return view;
  },

  // How an agent asks after its own task. Another project's mandate holds no
  // payout here, the same answer as a task that was never asked for.
  findByTask: async (
    db: Tx,
    mandateId: string,
    taskId: string,
  ): Promise<PayoutView | undefined> => {
    const row = await db
      .selectFrom('ujira.payouts')
      .select(payoutColumns)
      .where('mandate_id', '=', mandateId)
      .where('task_id', '=', taskId)
      .executeTakeFirst();
    if (row === undefined) return undefined;
    const [view] = await viewsOf(db, [row]);
    return view;
  },
};

// For the cross-tenant matrix, which requires a case for each method here.
export const payoutViewRepositories = { payoutViews } as const;
