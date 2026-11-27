// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The three payout tasks the worker runs: payout.advance on the project's
// agent queue, payout.execute on the executor queue and receipt.issue on none.
// Each runs one workflow step under the job's tenant and shares one dead
// letter path: needs_attention where the status allows it.

import type { TenantSession } from '../db/index.js';
import { logLine, type Log } from '../log.js';
import type {
  PayoutJobContext,
  PayoutStore,
  PayoutWorkflow,
  StepOutcome,
} from '../payouts/workflow.js';
import {
  JobTargetMissingError,
  type PayoutTaskDefinition,
  type WorkerTransaction,
} from './payout-jobs.js';
import { deadLetterPayout, tenantPayoutStore } from './payout-store.js';

export interface PayoutTaskOptions {
  readonly workflow: PayoutWorkflow;
  readonly log: Log;
  /** The store a job's tenant session opens; the database one unless a test sets one. */
  readonly storeFor?: (tenant: TenantSession) => PayoutStore;
  readonly deadLetter?: (tx: WorkerTransaction, payoutId: string) => Promise<string | null>;
}

type Step = (job: PayoutJobContext, store: PayoutStore) => Promise<StepOutcome>;

export function payoutTasks(o: PayoutTaskOptions): readonly PayoutTaskDefinition[] {
  const storeFor = o.storeFor ?? tenantPayoutStore;
  const deadLetter = o.deadLetter ?? deadLetterPayout;
  const define = (task: PayoutTaskDefinition['task'], step: Step): PayoutTaskDefinition => ({
    task,
    run: async (job, tenant) => {
      const outcome = await step(
        {
          principalId: job.principalId,
          projectId: job.projectId,
          payoutId: job.payoutId,
          signal: job.signal,
        },
        storeFor(tenant),
      );
      if (outcome === 'missing') throw new JobTargetMissingError();
      o.log(
        logLine('payout_step', {
          principalId: job.principalId,
          projectId: job.projectId,
          payoutId: job.payoutId,
          task,
          outcome,
          attempt: job.attempt,
        }),
      );
    },
    deadLetter: async (tx, job) => deadLetter(tx, job.payoutId),
  });
  const w = o.workflow;
  return [
    define('payout.advance', async (job, store) => w.advance(job, store)),
    define('payout.execute', async (job, store) => w.execute(job, store)),
    define('receipt.issue', async (job, store) => w.issueReceipt(job, store)),
  ];
}
