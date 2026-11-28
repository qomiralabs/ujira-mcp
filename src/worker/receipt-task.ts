// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The receipt.issue task: writes the one receipt of a payout that reached a
// final status. The payout tasks queue it in the same transaction as that
// move, and its job key collapses a second enqueue, but either way it may run
// more than once; the receipt is unique on its payout, so a second run finds
// the first receipt and writes nothing.
//
// Its dead letter shares the payout tasks' path. A finished payout keeps its
// status, so the payout stays as it is, the line names that status, and the
// missing receipt is plain to see in the log and to the reconcile sweep.

import type { ChainAdapter } from '../chain/adapter.js';
import { logLine, type Log } from '../log.js';
import { issueReceipt } from '../receipts/issue.js';
import {
  JobTargetMissingError,
  type PayoutTaskDefinition,
  type WorkerTransaction,
} from './payout-jobs.js';
import { deadLetterPayout } from './payout-store.js';

export interface ReceiptTaskOptions {
  readonly chain: Pick<ChainAdapter, 'receiptRef'>;
  readonly log: Log;
  readonly deadLetter?: (tx: WorkerTransaction, payoutId: string) => Promise<string | null>;
}

export function receiptTask(o: ReceiptTaskOptions): PayoutTaskDefinition {
  const deadLetter = o.deadLetter ?? deadLetterPayout;
  return {
    task: 'receipt.issue',
    run: async (job, tenant) => {
      const issued = await tenant.transaction(async (tx) =>
        issueReceipt(tx, job.payoutId, o.chain),
      );
      if (issued === undefined) throw new JobTargetMissingError();
      o.log(
        logLine('receipt_issued', {
          principalId: job.principalId,
          projectId: job.projectId,
          payoutId: job.payoutId,
          receiptId: issued.receipt.id,
          outcome: issued.receipt.status,
          created: issued.created,
          attempt: job.attempt,
        }),
      );
    },
    deadLetter: async (tx, job) => deadLetter(tx, job.payoutId),
  };
}
