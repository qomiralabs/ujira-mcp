// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// One receipt in one chain-neutral shape, whatever it came from: a row the
// worker issued for a finished payout, or an entry of the receipt log the
// server kept in a JSON file before it had a database. The views, the export
// and the verify check all read this shape, so a receipt imported from the
// old log is shown, exported and checked the same way as a new one.

import { z } from 'zod';

import type { ReceiptDetail } from '../db/index.js';
import { tokenAmount, type TokenAmount } from '../money/index.js';
import { isPayoutStatus, type PayoutStatus } from '../payouts/status.js';
import { ReceiptLegacyInvalidError } from './errors.js';
import type { Receipt as LogReceipt } from './log.js';

export interface ReceiptLegView {
  readonly index: number;
  // In full; views mask it.
  readonly destination: string;
  readonly amount: TokenAmount;
  readonly txHash: string | null;
}

export interface ReceiptView {
  readonly id: string;
  readonly payoutId: string;
  readonly principalId: string;
  readonly projectId: string;
  readonly mandate: { readonly id: string; readonly contractId: string };
  readonly recipient: {
    readonly id: string;
    readonly label: string;
    // The reference the mandate checks on chain; null for an old log entry.
    readonly ref: string | null;
  };
  readonly taskId: string;
  // The adapter's network id, such as stellar:testnet.
  readonly network: string;
  readonly amount: TokenAmount;
  readonly fee: TokenAmount;
  // A final payout status. An old log entry can also be one still moving.
  readonly outcome: PayoutStatus;
  // The spec error that refused it, exactly when the outcome is blocked.
  readonly blockedBy: string | null;
  // The transaction that paid it, only when the outcome is paid.
  readonly txHash: string | null;
  // The adapter's reference to that payment.
  readonly ref: string | null;
  readonly requestTxHash: string | null;
  readonly issuedAt: Date;
  readonly settledAt: Date | null;
  readonly legs: readonly ReceiptLegView[];
}

/** A receipt the worker issued, with what its payout says beside it. */
export function receiptFromDetail(detail: ReceiptDetail): ReceiptView {
  const { receipt } = detail;
  const paid = receipt.status === 'paid';
  return {
    id: receipt.id,
    payoutId: receipt.payoutId,
    principalId: detail.principalId,
    projectId: receipt.projectId,
    mandate: { id: detail.mandate.id, contractId: detail.mandate.contractAddress },
    recipient: {
      id: detail.recipient.id,
      label: detail.recipient.label,
      ref: detail.recipient.recipientRef,
    },
    taskId: detail.taskId,
    network: receipt.network,
    amount: receipt.amount,
    fee: receipt.fee,
    outcome: receipt.status,
    blockedBy: receipt.blockedBy,
    // A blocked, rejected or cancelled payout sent nothing, so it names no
    // transaction even if a leg recorded one before it stopped.
    txHash: paid ? (detail.legs[0]?.txHash ?? null) : null,
    ref: receipt.chainReceiptRef,
    requestTxHash: receipt.requestTxHash,
    issuedAt: receipt.createdAt,
    settledAt: receipt.settledAt,
    legs: detail.legs.map((leg) => ({
      index: leg.index,
      destination: leg.destination,
      amount: leg.amount,
      txHash: leg.txHash,
    })),
  };
}

/** Who an old log entry belongs to, decided by whoever imports it. */
export interface LegacyReceiptIds {
  readonly id: string;
  readonly payoutId: string;
  readonly principalId: string;
  readonly projectId: string;
  readonly mandateId: string;
  readonly recipientId: string;
  // The log kept only an address; the import may know a label for it.
  readonly recipientLabel?: string;
  /** The adapter's receipt reference for a transaction, such as ChainAdapter.receiptRef. */
  readonly receiptRef: (txHash: string, eventIndex: number) => string;
}

// The log's outcomes in the status names payouts use now.
const LEGACY_OUTCOMES: Readonly<Record<LogReceipt['outcome'], PayoutStatus>> = {
  paid: 'paid',
  approved_then_paid: 'paid',
  blocked: 'blocked',
  approval_required: 'pending_approval',
  settling: 'settling',
};

// The log named the network alone, from when there was one chain.
const LEGACY_NETWORKS: Readonly<Record<string, string>> = {
  testnet: 'stellar:testnet',
  pubnet: 'stellar:pubnet',
  mainnet: 'stellar:pubnet',
};

const SPEC_ERROR = /^[A-Z][A-Z0-9_]{0,63}$/;
const NETWORK_ID = /^[a-z][a-z0-9_]{0,31}:[a-z0-9_]{1,32}$/;
const TOKEN_ASSET = z.enum(['USDC']);

/**
 * An entry of the old receipt log in the same shape, so it renders through
 * the same views. The log said why a payout was blocked in lower case, such
 * as per_payment_cap_exceeded; the spec error is that name in upper case.
 */
export function receiptFromLegacy(entry: LogReceipt, ids: LegacyReceiptIds): ReceiptView {
  const network = LEGACY_NETWORKS[entry.network] ?? entry.network;
  if (!NETWORK_ID.test(network)) throw new ReceiptLegacyInvalidError('network');
  const asset = TOKEN_ASSET.safeParse(entry.asset);
  if (!asset.success) throw new ReceiptLegacyInvalidError('asset');
  const chain = network.split(':')[0];
  if (chain !== 'stellar') throw new ReceiptLegacyInvalidError('network');
  const outcome = LEGACY_OUTCOMES[entry.outcome];
  if (!isPayoutStatus(outcome)) throw new ReceiptLegacyInvalidError('outcome');
  const amount = tokenAmount(entry.amount, asset.data, chain);
  const blockedBy =
    outcome === 'blocked'
      ? (entry.reason ?? 'unknown').toUpperCase().replace(/[^A-Z0-9_]/g, '_')
      : null;
  if (blockedBy !== null && !SPEC_ERROR.test(blockedBy)) {
    throw new ReceiptLegacyInvalidError('reason');
  }
  const paid = outcome === 'paid';
  const txHash = paid ? (entry.tx_hash ?? null) : null;
  if (paid && txHash === null) throw new ReceiptLegacyInvalidError('tx_hash');
  const issuedAt = new Date(entry.updated_at);
  if (Number.isNaN(issuedAt.getTime())) throw new ReceiptLegacyInvalidError('updated_at');
  return {
    id: ids.id,
    payoutId: ids.payoutId,
    principalId: ids.principalId,
    projectId: ids.projectId,
    mandate: { id: ids.mandateId, contractId: entry.mandate },
    recipient: { id: ids.recipientId, label: ids.recipientLabel ?? entry.recipient, ref: null },
    taskId: entry.task_id,
    network,
    amount,
    fee: tokenAmount(0n, asset.data, chain),
    outcome,
    blockedBy,
    txHash,
    ref: txHash === null ? null : ids.receiptRef(txHash, 0),
    requestTxHash: entry.request_tx_hash ?? null,
    issuedAt,
    settledAt: paid ? issuedAt : null,
    legs: [
      {
        index: 0,
        destination: entry.destination,
        amount,
        txHash: entry.tx_hash ?? null,
      },
    ],
  };
}
