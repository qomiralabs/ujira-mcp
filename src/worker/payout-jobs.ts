// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// What every payout job runs inside. The queue hands over a payload it stored;
// this checks it, opens transactions only under the tenant it names, and owns
// the last failure: the payout moves to needs_attention and a dead letter line
// is logged.
//
// The payload is the only place a job's tenant comes from, and it was written
// by the database from the enqueuing transaction's own tenant. Even so it is
// parsed here before anything trusts it, and the handler gets a tenant session
// already bound to it, never a database it could point at another tenant. A
// payload naming a payout the tenant does not have, whether missing or another
// tenant's, finds nothing under the policies, and the job ends there.

import { z } from 'zod';

import type { Database, JobHandler, PayoutJobTask, QueuedJob, TenantSession } from '../db/index.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const id = z.string().regex(UUID);

/** Exactly what ujira_jobs.enqueue_payout writes, and nothing more. */
export const payoutJobPayload = z.strictObject({
  principalId: id,
  projectId: id,
  payoutId: id,
});

export type PayoutJobPayload = z.infer<typeof payoutJobPayload>;

/** One transaction under the job's tenant, as the repositories take it. */
export type WorkerTransaction = Parameters<Parameters<TenantSession['transaction']>[0]>[0];

export interface PayoutJob extends PayoutJobPayload {
  readonly task: PayoutJobTask;
  readonly jobId: string;
  readonly attempt: number;
  readonly maxAttempts: number;
  /** Aborts when the worker is stopping. A chain call takes it, so the job gives up promptly. */
  readonly signal: AbortSignal;
}

export interface PayoutTaskDefinition {
  readonly task: PayoutJobTask;
  /**
   * Does the work. `tenant` opens transactions under the job's tenant only;
   * a handler keeps each one short and makes chain calls between them, not
   * inside one. A throw fails this attempt and the queue tries again later.
   */
  readonly run: (job: PayoutJob, tenant: TenantSession) => Promise<void>;
  /**
   * After the last attempt failed: moves the payout to needs_attention where
   * its status allows it. Resolves to the payout's status afterwards, which a
   * payout waiting on its approvers or already finished keeps, or null when
   * the tenant has no such payout.
   */
  readonly deadLetter: (tx: WorkerTransaction, job: PayoutJob) => Promise<string | null>;
}

/**
 * The payout a job names does not exist for the job's tenant. Thrown by a
 * handler. Trying again cannot change it, since a payout and its first job
 * commit together, so the job ends at once as a dead letter.
 */
export class JobTargetMissingError extends Error {
  override readonly name = 'JobTargetMissingError';
  readonly code = 'TARGET_MISSING';

  constructor() {
    super('the payout this job names does not exist for its tenant');
  }
}

/** A code for a log line. Never the message, which can carry anything. */
export function errorCode(error: unknown): string {
  if (error instanceof Error) {
    const code: unknown = (error as { code?: unknown }).code;
    if (typeof code === 'string' && /^[A-Za-z0-9_]{1,64}$/.test(code)) return code;
    return /^[A-Za-z0-9_]{1,64}$/.test(error.name) ? error.name : 'Error';
  }
  return 'unknown';
}

function tenantOf(db: Database, payload: PayoutJobPayload): TenantSession {
  const context = {
    principalId: payload.principalId,
    projectId: payload.projectId,
    scope: 'project',
  } as const;
  return { transaction: async (work) => db.withTenant('worker', context, work) };
}

/**
 * The queue's handler for one payout task. On the last attempt, or at once
 * when the payout is missing, the dead letter path runs before the job ends.
 */
export function payoutJobHandler(
  db: Database,
  definition: PayoutTaskDefinition,
  log: (line: string) => void,
): JobHandler {
  return async (queued: QueuedJob) => {
    const parsed = payoutJobPayload.safeParse(queued.payload);
    if (!parsed.success) {
      // No tenant can be trusted from it, so nothing runs and nothing is moved.
      // Only the database writes these payloads, so this is a bug or a hand
      // edit, and a retry would read the same bytes.
      log(
        `event=payout_dead_letter task=${definition.task} job=${queued.id} attempt=${queued.attempt}/${queued.maxAttempts} reason=PAYLOAD_INVALID`,
      );
      return;
    }
    const job: PayoutJob = {
      ...parsed.data,
      task: definition.task,
      jobId: queued.id,
      attempt: queued.attempt,
      maxAttempts: queued.maxAttempts,
      signal: queued.signal,
    };
    const tenant = tenantOf(db, parsed.data);
    try {
      await definition.run(job, tenant);
    } catch (error) {
      if (error instanceof JobTargetMissingError) {
        // Throws only if the dead letter write itself failed, and then the
        // queue tries the job again rather than lose the record.
        await deadLetter(tenant, definition, job, error.code, log);
        return;
      }
      if (job.attempt >= job.maxAttempts) {
        // A failed dead letter write is already logged inside; the job's own
        // error is the one the queue records.
        await deadLetter(tenant, definition, job, errorCode(error), log).catch(() => undefined);
      }
      throw error;
    }
  };
}

async function deadLetter(
  tenant: TenantSession,
  definition: PayoutTaskDefinition,
  job: PayoutJob,
  reason: string,
  log: (line: string) => void,
): Promise<void> {
  const where = `task=${job.task} principal=${job.principalId} project=${job.projectId} payout=${job.payoutId} job=${job.jobId} attempt=${job.attempt}/${job.maxAttempts} reason=${reason}`;
  let status: string | null;
  try {
    status = await tenant.transaction(async (tx) => definition.deadLetter(tx, job));
  } catch (error) {
    // The job stays failed in the queue, and the reconcile sweep finds the
    // payout stuck past its deadline.
    log(`event=payout_dead_letter_failed ${where} error=${errorCode(error)}`);
    throw error;
  }
  log(`event=payout_dead_letter ${where} payout_status=${status ?? 'not_found'}`);
}
