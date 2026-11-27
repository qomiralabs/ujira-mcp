// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// Receipts: one per finished payout, written once and never changed. The
// database copies the outcome and the money from the payout itself, so a
// receipt can only ever say what the payout says.

import { sql, type Kysely } from 'kysely';

import type { TokenAmount } from '../../money/index.js';
import { isTerminal, isPayoutStatus, type PayoutStatus } from '../../payouts/status.js';
import { tokenFromRow } from '../money-mapper.js';
import type { Schema } from '../schema.js';
import { PAGE_TIME, olderThan, pageKey } from './newest-first.js';
import { checkedLimit, pageOf, type Page, type PageRequest } from './page.js';
import { RepositoryInputError, bytesHex32 } from './values.js';

type Tx = Kysely<Schema>;

const CURRENT_PRINCIPAL = sql<string>`ujira.current_principal_id()`;
const CURRENT_PROJECT = sql<string>`ujira.current_project_id()`;

// The adapter's receipt reference, such as ujira:tx:v1:stellar:testnet:<hash>:0.
const CHAIN_RECEIPT_REF = /^[A-Za-z0-9:._-]{1,512}$/;

export interface Receipt {
  readonly id: string;
  readonly projectId: string;
  readonly payoutId: string;
  // One of the terminal statuses.
  readonly status: PayoutStatus;
  readonly blockedBy: string | null;
  readonly network: string;
  readonly amount: TokenAmount;
  readonly fee: TokenAmount;
  // Set for a paid payout; may be set for another outcome the chain recorded.
  readonly chainReceiptRef: string | null;
  readonly requestTxHash: string | null;
  readonly settledAt: Date | null;
  // When the receipt was issued.
  readonly createdAt: Date;
}

export interface IssuedReceipt {
  // False when the payout already had its receipt.
  readonly created: boolean;
  readonly receipt: Receipt;
}

const receiptColumns = [
  'id',
  'project_id',
  'payout_id',
  'status',
  'blocked_by',
  'network',
  'chain',
  'amount',
  'fee_amount',
  'asset',
  'scale',
  'chain_receipt_ref',
  'request_tx_hash',
  'settled_at',
  'created_at',
] as const;

function statusOf(value: string): PayoutStatus {
  if (!isPayoutStatus(value) || !isTerminal(value)) {
    throw new Error('a receipt holds a status that is not a terminal payout status');
  }
  return value;
}

function toReceipt(row: {
  id: string;
  project_id: string;
  payout_id: string;
  status: string;
  blocked_by: string | null;
  network: string;
  chain: string;
  amount: string;
  fee_amount: string;
  asset: string;
  scale: number;
  chain_receipt_ref: string | null;
  request_tx_hash: Buffer | null;
  settled_at: Date | null;
  created_at: Date;
}): Receipt {
  const unit = { asset: row.asset, chain: row.chain, scale: row.scale };
  return {
    id: row.id,
    projectId: row.project_id,
    payoutId: row.payout_id,
    status: statusOf(row.status),
    blockedBy: row.blocked_by,
    network: row.network,
    amount: tokenFromRow({ ...unit, amount: row.amount }),
    fee: tokenFromRow({ ...unit, amount: row.fee_amount }),
    chainReceiptRef: row.chain_receipt_ref,
    requestTxHash: row.request_tx_hash === null ? null : bytesHex32(row.request_tx_hash),
    settledAt: row.settled_at,
    createdAt: row.created_at,
  };
}

async function forPayout(db: Tx, payoutId: string): Promise<Receipt | undefined> {
  const row = await db
    .selectFrom('ujira.receipts')
    .select(receiptColumns)
    .where('payout_id', '=', payoutId)
    .executeTakeFirst();
  return row === undefined ? undefined : toReceipt(row);
}

export const receipts = {
  // Writes the payout's receipt, or returns the one it already has, so the
  // job that issues it can run any number of times. A payout that has not
  // finished, or is not this project's, is refused, UJ008; a paid payout needs
  // its chain reference, 23514.
  issue: async (
    db: Tx,
    payoutId: string,
    chainReceiptRef: string | null,
  ): Promise<IssuedReceipt> => {
    if (chainReceiptRef !== null && !CHAIN_RECEIPT_REF.test(chainReceiptRef)) {
      throw new RepositoryInputError('chainReceiptRef');
    }
    const row = await db
      .insertInto('ujira.receipts')
      .values({
        principal_id: CURRENT_PRINCIPAL,
        project_id: CURRENT_PROJECT,
        payout_id: payoutId,
        chain_receipt_ref: chainReceiptRef,
      })
      .onConflict((conflict) => conflict.column('payout_id').doNothing())
      .returning(receiptColumns)
      .executeTakeFirst();
    if (row !== undefined) return { created: true, receipt: toReceipt(row) };
    const existing = await forPayout(db, payoutId);
    // The conflict was on this payout, which only this tenant can hold.
    if (existing === undefined) throw new Error('a receipt conflicted but cannot be read');
    return { created: false, receipt: existing };
  },

  get: async (db: Tx, id: string): Promise<Receipt | undefined> => {
    const row = await db
      .selectFrom('ujira.receipts')
      .select(receiptColumns)
      .where('id', '=', id)
      .executeTakeFirst();
    return row === undefined ? undefined : toReceipt(row);
  },

  forPayout,

  // Newest first.
  list: async (db: Tx, page: PageRequest): Promise<Page<Receipt>> => {
    const limit = checkedLimit(page.limit);
    let query = db
      .selectFrom('ujira.receipts')
      .select([...receiptColumns, PAGE_TIME.as('page_time')])
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(limit + 1);
    if (page.after !== undefined) query = query.where(olderThan(page.after));
    const rows = await query.execute();
    const keys = new Map(rows.map((row) => [row.id, pageKey(row)]));
    return pageOf(rows.map(toReceipt), limit, (receipt) => keys.get(receipt.id) ?? '');
  },
};

// For the cross-tenant matrix, which requires a case for each method here.
export const receiptRepositories = { receipts } as const;
