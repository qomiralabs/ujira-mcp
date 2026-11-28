// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// Checks a receipt against the chain, not against our own rows: the
// transaction it names is read through the adapter, and the receipt matches
// only if that transaction succeeded, called the receipt's mandate, and moved
// exactly the receipt's legs out of it, each to its destination for its
// amount. The answer names the first thing that differs, so a person can see
// what is wrong without reading a transaction.
//
// A receipt of a payout that never paid (blocked, rejected, cancelled,
// failed) names no transaction, so there is nothing on chain to match and
// the answer says so with the field `txHash`.

import type { CallOptions, ChainAdapter, ChainTransfer } from '../chain/adapter.js';
import { ReceiptNetworkNotServedError } from './errors.js';
import type { ReceiptView } from './model.js';

/** In the order they are checked. */
export const VERIFY_FIELDS = ['txHash', 'mandate', 'destination', 'amount'] as const;
export type VerifyField = (typeof VERIFY_FIELDS)[number];

export interface Verification {
  readonly matched: boolean;
  // The first field that differs from the chain; null when it matched.
  readonly field: VerifyField | null;
  readonly txHash: string | null;
}

const differs = (field: VerifyField, txHash: string | null): Verification => ({
  matched: false,
  field,
  txHash,
});

/**
 * Chain failures (TIMEOUT, UNAVAILABLE) are thrown as ChainError: a check
 * that could not be made says nothing about the receipt, so it is never
 * answered as a mismatch.
 */
export async function verifyReceipt(
  receipt: ReceiptView,
  chain: Pick<ChainAdapter, 'network' | 'transfers'>,
  o: CallOptions,
): Promise<Verification> {
  const txHash = receipt.outcome === 'paid' ? receipt.txHash : null;
  if (txHash === null) return differs('txHash', null);
  if (receipt.network !== chain.network) throw new ReceiptNetworkNotServedError();

  const tx = await chain.transfers(txHash, o);
  if (tx.status !== 'SUCCESS') return differs('txHash', txHash);
  const mandate = receipt.mandate.contractId;
  if (!tx.calls.some((call) => call.contract === mandate)) return differs('mandate', txHash);
  const out: ChainTransfer[] = tx.transfers.filter((t) => t.from === mandate);
  if (out.length === 0) return differs('mandate', txHash);

  // Each leg takes one transfer of its own: one with the same destination
  // and amount if there is one, so two legs to one wallet cannot both match
  // the same transfer.
  const unclaimed = [...out];
  for (const leg of receipt.legs) {
    const exact = unclaimed.findIndex(
      (t) => t.to === leg.destination && t.amount === leg.amount.amount,
    );
    const anyTo = unclaimed.findIndex((t) => t.to === leg.destination);
    if (anyTo === -1) return differs('destination', txHash);
    if (exact === -1) return differs('amount', txHash);
    unclaimed.splice(exact, 1);
  }
  // Anything else that left the mandate in this transaction is the fee, and
  // nothing more: a receipt that left out money moved is not a match.
  const rest = unclaimed.reduce((sum, t) => sum + t.amount, 0n);
  if (rest !== receipt.fee.amount) return differs('amount', txHash);
  return { matched: true, field: null, txHash };
}
