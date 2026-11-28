// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The document is what a receipt hash covers. Amounts are decimal strings of
// minor units next to their asset, scale and network, so no reader ever has
// to round-trip money through a float, and the scale is part of what is
// hashed. The recipient's label is left out: it is the principal's own name
// for a person, not a fact about the payment, and it is not a hash input
// anyone outside the project could check.
//
// Receipt signing comes later; it will sign this same document hash.

import type { TokenAmount } from '../money/index.js';
import { canonicalJson, sha256Hex } from './canonical.js';
import type { ReceiptView } from './model.js';

/** Names the document layout. A change to the layout is a new format, never an edit. */
export const RECEIPT_DOCUMENT_FORMAT = 'ujira.receipt.v1';

export interface AmountDocument {
  readonly amount: string;
  readonly asset: string;
  readonly network: string;
  readonly scale: number;
}

export interface ReceiptDocument {
  readonly format: typeof RECEIPT_DOCUMENT_FORMAT;
  readonly id: string;
  readonly payoutId: string;
  readonly principalId: string;
  readonly projectId: string;
  readonly mandate: { readonly id: string; readonly contractId: string };
  readonly recipient: { readonly id: string; readonly ref: string | null };
  readonly taskId: string;
  readonly network: string;
  readonly amount: AmountDocument;
  readonly fee: AmountDocument;
  readonly outcome: string;
  readonly blockedBy: string | null;
  readonly txHash: string | null;
  readonly ref: string | null;
  readonly requestTxHash: string | null;
  readonly issuedAt: string;
  readonly settledAt: string | null;
  readonly legs: readonly {
    readonly index: number;
    readonly destination: string;
    readonly amount: AmountDocument;
    readonly txHash: string | null;
  }[];
}

function amountDocument(value: TokenAmount, network: string): AmountDocument {
  return { amount: value.amount.toString(), asset: value.asset, network, scale: value.scale };
}

/** The receipt as a plain JSON document, ready to hash. */
export function receiptDocument(r: ReceiptView): ReceiptDocument {
  return {
    format: RECEIPT_DOCUMENT_FORMAT,
    id: r.id,
    payoutId: r.payoutId,
    principalId: r.principalId,
    projectId: r.projectId,
    mandate: { id: r.mandate.id, contractId: r.mandate.contractId },
    recipient: { id: r.recipient.id, ref: r.recipient.ref },
    taskId: r.taskId,
    network: r.network,
    amount: amountDocument(r.amount, r.network),
    fee: amountDocument(r.fee, r.network),
    outcome: r.outcome,
    blockedBy: r.blockedBy,
    txHash: r.txHash,
    ref: r.ref,
    requestTxHash: r.requestTxHash,
    issuedAt: r.issuedAt.toISOString(),
    settledAt: r.settledAt === null ? null : r.settledAt.toISOString(),
    legs: r.legs.map((leg) => ({
      index: leg.index,
      destination: leg.destination,
      amount: amountDocument(leg.amount, r.network),
      txHash: leg.txHash,
    })),
  };
}

/** Lowercase hex SHA-256 over the canonical JSON of the receipt's document. */
export function documentSha256(r: ReceiptView): string {
  return sha256Hex(canonicalJson(receiptDocument(r)));
}
