// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The payout jobs' database side, over the repositories, inside the tenant
// session the job handler opened. Every method is one transaction. A change is
// all or nothing: if the payout or one leg has moved since it was read, the
// whole transaction rolls back and the caller is told, so two runs that race
// cannot both act.

import {
  jobs,
  mandates,
  payoutLegs,
  payouts,
  receipts,
  recipients,
  type TenantSession,
} from '../db/index.js';
import type { PayoutChange, PayoutSnapshot, PayoutStore } from '../payouts/workflow.js';
import { deadLetterPath } from '../payouts/workflow.js';

type Tx = Parameters<Parameters<TenantSession['transaction']>[0]>[0];

/** Thrown inside a transaction to roll it back when a row moved under it. */
class Moved extends Error {
  override readonly name = 'Moved';
}

async function snapshot(tx: Tx, payoutId: string): Promise<PayoutSnapshot | undefined> {
  const payout = await payouts.get(tx, payoutId);
  if (payout === undefined) return undefined;
  // One after another: a transaction is one connection.
  const legs = await payoutLegs.list(tx, payoutId);
  const mandate = await mandates.get(tx, payout.mandateId);
  const recipient = await recipients.get(tx, payout.recipientId);
  const receipt = await receipts.forPayout(tx, payoutId);
  // The composite keys make these unreachable for a payout the tenant can read.
  if (mandate === undefined || recipient === undefined) {
    throw new Error('a payout is missing its mandate or recipient');
  }
  return { payout, legs, mandate, recipient, hasReceipt: receipt !== undefined };
}

async function apply(tx: Tx, payoutId: string, change: PayoutChange): Promise<void> {
  for (const step of change.path ?? []) {
    if ((await payouts.transition(tx, payoutId, step)) === undefined) throw new Moved();
  }
  for (const leg of change.legs ?? []) {
    const moved = await payoutLegs.transition(tx, leg.legId, leg.change);
    if (moved?.payoutId !== payoutId) throw new Moved();
  }
  for (const job of change.enqueue ?? []) {
    if (job.afterSeconds === undefined) await jobs.enqueuePayout(tx, job.task, payoutId);
    else await jobs.enqueuePayoutLater(tx, job.task, payoutId, job.afterSeconds);
  }
}

export function tenantPayoutStore(tenant: TenantSession): PayoutStore {
  return {
    load: (payoutId) => tenant.transaction(async (tx) => snapshot(tx, payoutId)),
    apply: async (payoutId, change) => {
      try {
        await tenant.transaction(async (tx) => {
          await apply(tx, payoutId, change);
        });
        return true;
      } catch (error) {
        if (error instanceof Moved) return false;
        throw error;
      }
    },
    issueReceipt: (payoutId, chainReceiptRef) =>
      tenant.transaction(async (tx) => (await receipts.issue(tx, payoutId, chainReceiptRef)).created),
  };
}

/**
 * The dead letter move, inside the handler's transaction: the payout's status
 * after it, or null when the tenant has no such payout.
 */
export async function deadLetterPayout(tx: Tx, payoutId: string): Promise<string | null> {
  const payout = await payouts.get(tx, payoutId);
  if (payout === undefined) return null;
  let status: string = payout.status;
  for (const step of deadLetterPath(payout.status)) {
    const moved = await payouts.transition(tx, payoutId, step);
    // Moved by another run since the read: what it is now is the answer.
    if (moved === undefined) return (await payouts.get(tx, payoutId))?.status ?? null;
    status = moved.status;
  }
  return status;
}
