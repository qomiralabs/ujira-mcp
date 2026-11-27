// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// Adding a payout's job. It runs in the transaction that writes the payout, so
// a rolled back write leaves no job and a committed one always has its job.
// No method takes a tenant id, a queue or a job key: the database function
// builds all three from the transaction's tenant and the task.

import { sql, type Kysely } from 'kysely';

import type { Schema } from '../schema.js';
import type { PayoutJobQueue } from './payout-jobs.js';
import { RepositoryInputError } from './values.js';

type Tx = Kysely<Schema>;

/**
 * The queued work on one payout. Each names its queue in the database:
 * `payout.advance` runs on `agent:<project id>`, one at a time per agent key;
 * `payout.execute` on `executor`, one at a time for the one executor key;
 * `receipt.issue` on no queue.
 */
export const PAYOUT_JOB_TASKS = ['payout.advance', 'payout.execute', 'receipt.issue'] as const;
export type PayoutJobTask = (typeof PAYOUT_JOB_TASKS)[number];

/** Tries per job, the last of which moves the payout to needs_attention. */
export const MAX_JOB_ATTEMPTS = 10;

/** The longest a job may be put off, as the database bounds it. */
export const MAX_JOB_DELAY_SECONDS = 3600;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const jobs = {
  /**
   * Queues `task` for the payout. A second call for the same payout and task
   * while the first job waits replaces it, so a retried request makes one
   * job; one that finds it running queues the next run behind it.
   */
  enqueuePayout: async (db: Tx, task: PayoutJobTask, payoutId: string): Promise<bigint> => {
    if (!(PAYOUT_JOB_TASKS as readonly string[]).includes(task)) {
      throw new RepositoryInputError('task');
    }
    if (!UUID.test(payoutId)) throw new RepositoryInputError('payoutId');
    const { rows } = await sql<{ job_id: string }>`
      select ujira_jobs.enqueue_payout(${task}, ${payoutId}::uuid)::text as job_id
    `.execute(db);
    const [row] = rows;
    if (row === undefined) throw new Error('enqueue_payout returned no job');
    return BigInt(row.job_id);
  },

  /**
   * As enqueuePayout, to run `delaySeconds` from now, 1 to 3600. The worker
   * login only: it is how a job comes back to a payout that is waiting on
   * someone else, without spending a retry.
   */
  enqueuePayoutLater: async (
    db: Tx,
    task: PayoutJobTask,
    payoutId: string,
    delaySeconds: number,
  ): Promise<bigint> => {
    if (!(PAYOUT_JOB_TASKS as readonly string[]).includes(task)) {
      throw new RepositoryInputError('task');
    }
    if (!UUID.test(payoutId)) throw new RepositoryInputError('payoutId');
    if (!Number.isInteger(delaySeconds) || delaySeconds < 1 || delaySeconds > MAX_JOB_DELAY_SECONDS) {
      throw new RepositoryInputError('delaySeconds');
    }
    const { rows } = await sql<{ job_id: string }>`
      select ujira_jobs.enqueue_payout_later(${task}, ${payoutId}::uuid, ${delaySeconds}::integer)::text as job_id
    `.execute(db);
    const [row] = rows;
    if (row === undefined) throw new Error('enqueue_payout_later returned no job');
    return BigInt(row.job_id);
  },
};

/**
 * The job queue payouts.create writes a payout's first job to. Only the task
 * and the payout id are passed on: the database takes the tenant from the
 * transaction and builds the queue and the key itself, with the project in
 * front of the key, so whatever else a caller put in the job cannot reach
 * another tenant or another tenant's queue.
 */
export const payoutJobQueue: PayoutJobQueue = {
  enqueue: async (db, job) => {
    await jobs.enqueuePayout(db, job.task, job.payload.payoutId);
  },
};
