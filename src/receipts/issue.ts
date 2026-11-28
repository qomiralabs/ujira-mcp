// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// Issuing the one receipt a finished payout gets. It runs inside the worker
// job's tenant transaction, as the worker login, which is the only one that
// may write a receipt. The database copies the outcome and the money from
// the payout, and the receipt is unique on the payout, so running this twice,
// or two runs racing, leaves exactly one receipt: the second finds the first.
//
// No chain call is made here. A paid payout already recorded the transaction
// that paid it on its leg; the receipt references it, and the chain is read
// when someone asks to verify.

import type { ChainAdapter } from '../chain/adapter.js';
import {
  payoutLegs,
  payouts,
  receipts,
  type IssuedReceipt,
  type TenantSession,
} from '../db/index.js';
import { isTerminal } from '../payouts/status.js';
import { ReceiptNoTransactionError, ReceiptNotFinishedError } from './errors.js';

type Tx = Parameters<Parameters<TenantSession['transaction']>[0]>[0];

/** Undefined when the tenant has no such payout. */
export async function issueReceipt(
  tx: Tx,
  payoutId: string,
  chain: Pick<ChainAdapter, 'receiptRef'>,
): Promise<IssuedReceipt | undefined> {
  const payout = await payouts.get(tx, payoutId);
  if (payout === undefined) return undefined;
  if (!isTerminal(payout.status)) throw new ReceiptNotFinishedError();
  let ref: string | null = null;
  if (payout.status === 'paid') {
    // Every leg of a payout is paid by the one execute transaction.
    const [first] = await payoutLegs.list(tx, payout.id);
    if (first?.txHash === null || first?.txHash === undefined) {
      throw new ReceiptNoTransactionError();
    }
    ref = chain.receiptRef(first.txHash, 0);
  }
  return receipts.issue(tx, payout.id, ref);
}
