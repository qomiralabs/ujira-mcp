// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// How a receipt is shown: the /v1 answer the console reads, and the one
// formatted amount people see. Destinations leave masked. Money stays minor
// units on the wire; the formatted amount is plain decimal text in the
// token's own unit, with no grouping or symbol, so a spreadsheet reads it
// as the number it is in any locale.

import { toDecimalString, type TokenAmount } from '../money/index.js';
import { documentSha256 } from './document.js';
import type { ReceiptView } from './model.js';

export interface AmountWire {
  readonly amount: string;
  readonly asset: string;
  readonly network: string;
  readonly scale: number;
}

export interface ReceiptWire {
  readonly id: string;
  readonly payoutId: string;
  readonly mandate: { readonly id: string; readonly contractId: string };
  readonly recipient: { readonly id: string; readonly label: string; readonly ref: string | null };
  readonly taskId: string;
  readonly network: string;
  readonly amount: AmountWire;
  readonly fee: AmountWire;
  readonly outcome: string;
  readonly blockedBy: string | null;
  readonly txHash: string | null;
  readonly ref: string | null;
  readonly requestTxHash: string | null;
  readonly issuedAt: string;
  readonly settledAt: string | null;
  readonly legs: {
    readonly index: number;
    readonly destination: string;
    readonly amount: AmountWire;
    readonly txHash: string | null;
  }[];
  readonly documentSha256: string;
}

/** The first and last four characters, as every other /v1 answer masks an address. */
export function maskDestination(address: string): string {
  return address.length <= 12 ? address : `${address.slice(0, 4)}...${address.slice(-4)}`;
}

/** 25000000 at scale 7 as "2.5"; a whole amount has no point. */
export function formatAmount(value: TokenAmount): string {
  const text = toDecimalString(value);
  return text.includes('.') ? text.replace(/0+$/, '').replace(/\.$/, '') : text;
}

function amountWire(value: TokenAmount, network: string): AmountWire {
  return { amount: value.amount.toString(), asset: value.asset, network, scale: value.scale };
}

export function receiptWire(r: ReceiptView): ReceiptWire {
  return {
    id: r.id,
    payoutId: r.payoutId,
    mandate: { id: r.mandate.id, contractId: r.mandate.contractId },
    recipient: { id: r.recipient.id, label: r.recipient.label, ref: r.recipient.ref },
    taskId: r.taskId,
    network: r.network,
    amount: amountWire(r.amount, r.network),
    fee: amountWire(r.fee, r.network),
    outcome: r.outcome,
    blockedBy: r.blockedBy,
    txHash: r.txHash,
    ref: r.ref,
    requestTxHash: r.requestTxHash,
    issuedAt: r.issuedAt.toISOString(),
    settledAt: r.settledAt === null ? null : r.settledAt.toISOString(),
    legs: r.legs.map((leg) => ({
      index: leg.index,
      destination: maskDestination(leg.destination),
      amount: amountWire(leg.amount, r.network),
      txHash: leg.txHash,
    })),
    documentSha256: documentSha256(r),
  };
}
