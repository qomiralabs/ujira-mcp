// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The first job of a payout, written in the transaction that writes the
// payout, so a payout never exists without the work that moves it and work is
// never queued for a payout that rolled back.
//
// The queue takes the transaction itself, because the job runner keeps its
// jobs in the same database and adds one with a function call: whatever the
// runner, the job commits or rolls back with the payout.

import type { Kysely } from 'kysely';

import type { Schema } from '../schema.js';

type Tx = Kysely<Schema>;

export type PayoutTask = 'payout.advance' | 'receipt.issue';

// Ids only, so a job payload never carries money, addresses or personal data,
// and the handler reads everything else inside its own tenant transaction.
export interface PayoutJobPayload {
  readonly principalId: string;
  readonly projectId: string;
  readonly payoutId: string;
}

export interface PayoutJob {
  readonly task: PayoutTask;
  // One queue per agent key runs one job at a time, so a key never races its
  // own sequence number. Null for work that signs nothing.
  readonly queue: string | null;
  // A second enqueue of the same work collapses into the first.
  readonly jobKey: string;
  readonly payload: PayoutJobPayload;
}

export interface PayoutJobQueue {
  readonly enqueue: (db: Tx, job: PayoutJob) => Promise<void>;
}

export function payoutJob(task: PayoutTask, payload: PayoutJobPayload): PayoutJob {
  return {
    task,
    queue: task === 'payout.advance' ? `agent:${payload.projectId}` : null,
    jobKey: `payout:${payload.payoutId}:${task}`,
    payload,
  };
}

// Until the job runner is in, a job goes nowhere: the payout is written and
// waits in queued. The runner replaces this with its own queue, and nothing
// that calls create changes.
export const unwiredJobQueue: PayoutJobQueue = {
  enqueue: () => Promise.resolve(),
};
