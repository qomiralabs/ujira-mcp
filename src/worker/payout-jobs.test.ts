// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The payout job wrapper with the database stood in for: what it trusts from
// a payload, which tenant it opens, and when the dead letter path runs. The
// same paths against a real queue and real policies are in queue.db.test.ts.

import { describe, expect, it } from 'vitest';

import type { Database, QueuedJob, TenantContext } from '../db/index.js';
import {
  errorCode,
  JobTargetMissingError,
  payoutJobHandler,
  type PayoutJob,
  type PayoutTaskDefinition,
  type WorkerTransaction,
} from './payout-jobs.js';

const PRINCIPAL = '0b8f4a52-6f2e-4d4b-9f39-2f6f5b1c7a10';
const PROJECT = '5a1e7c3d-1b2a-4c5d-8e9f-0a1b2c3d4e5f';
const PAYOUT = '9d2c1b0a-8f7e-4d6c-9b5a-4f3e2d1c0b9a';

interface Recorded {
  readonly role: string;
  readonly context: TenantContext;
}

function database(options: { failWrites?: boolean } = {}): {
  readonly db: Database;
  readonly opened: Recorded[];
} {
  const opened: Recorded[] = [];
  const refuse = () => Promise.reject(new Error('not used here'));
  const db: Database = {
    withTenant: async (role, context, work) => {
      opened.push({ role, context: { ...context } });
      if (options.failWrites === true) {
        throw Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' });
      }
      // No handler here touches the transaction; the real one is in the db test.
      return work(undefined as unknown as WorkerTransaction);
    },
    tenant: () => ({ transaction: refuse }),
    principal: () => ({ transaction: refuse }),
    unscoped: refuse,
    close: () => Promise.resolve(),
  };
  return { db, opened };
}

function queued(overrides: Partial<QueuedJob> = {}): QueuedJob {
  return {
    id: '42',
    task: 'payout.advance',
    payload: { principalId: PRINCIPAL, projectId: PROJECT, payoutId: PAYOUT },
    attempt: 1,
    maxAttempts: 10,
    signal: new AbortController().signal,
    ...overrides,
  };
}

function definition(
  run: PayoutTaskDefinition['run'],
  moved = true,
): PayoutTaskDefinition & { readonly deadLetters: PayoutJob[] } {
  const deadLetters: PayoutJob[] = [];
  return {
    task: 'payout.advance',
    run,
    deadLetter: (_tx, job) => {
      deadLetters.push(job);
      return Promise.resolve(moved ? 'needs_attention' : null);
    },
    deadLetters,
  };
}

const ok: PayoutTaskDefinition['run'] = async (_job, tenant) => {
  await tenant.transaction(() => Promise.resolve());
};

describe('payoutJobHandler', () => {
  it('runs under exactly the tenant the payload names, as the worker, with one project', async () => {
    const { db, opened } = database();
    const seen: PayoutJob[] = [];
    const lines: string[] = [];
    const handler = payoutJobHandler(
      db,
      definition(async (job, tenant) => {
        seen.push(job);
        await tenant.transaction(() => Promise.resolve());
      }),
      (line) => lines.push(line),
    );
    await handler(queued());
    expect(opened).toEqual([
      { role: 'worker', context: { principalId: PRINCIPAL, projectId: PROJECT, scope: 'project' } },
    ]);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      principalId: PRINCIPAL,
      projectId: PROJECT,
      payoutId: PAYOUT,
      task: 'payout.advance',
      jobId: '42',
      attempt: 1,
      maxAttempts: 10,
    });
    expect(lines).toEqual([]);
  });

  it.each([
    ['a missing payout id', { principalId: PRINCIPAL, projectId: PROJECT }],
    ['an extra field', { principalId: PRINCIPAL, projectId: PROJECT, payoutId: PAYOUT, x: '1' }],
    [
      'an upper case id',
      { principalId: PRINCIPAL.toUpperCase(), projectId: PROJECT, payoutId: PAYOUT },
    ],
    ['a number', { principalId: PRINCIPAL, projectId: PROJECT, payoutId: 7 }],
    ['no object at all', 'payout'],
    ['null', null],
  ])(
    'opens no transaction and runs nothing for %s, and logs a dead letter',
    async (_label, payload) => {
      const { db, opened } = database();
      const lines: string[] = [];
      let ran = false;
      const task = definition(() => {
        ran = true;
        return Promise.resolve();
      });
      await payoutJobHandler(db, task, (line) => lines.push(line))(queued({ payload }));
      expect(ran).toBe(false);
      expect(opened).toEqual([]);
      expect(task.deadLetters).toEqual([]);
      expect(lines).toEqual([
        'event=payout_dead_letter task=payout.advance job=42 attempt=1/10 reason=PAYLOAD_INVALID',
      ]);
    },
  );

  it('lets an early failure through for the queue to retry, with no dead letter', async () => {
    const { db } = database();
    const lines: string[] = [];
    const failure = Object.assign(new Error('rpc timed out'), { code: 'TIMEOUT' });
    const task = definition(() => Promise.reject(failure));
    await expect(
      payoutJobHandler(db, task, (line) => lines.push(line))(queued({ attempt: 9 })),
    ).rejects.toBe(failure);
    expect(task.deadLetters).toEqual([]);
    expect(lines).toEqual([]);
  });

  it('moves the payout to needs_attention on the last attempt, logs it, and still fails the job', async () => {
    const { db, opened } = database();
    const lines: string[] = [];
    const failure = Object.assign(new Error('the secret abc was refused'), { code: 'TX_FAILED' });
    const task = definition(() => Promise.reject(failure));
    await expect(
      payoutJobHandler(db, task, (line) => lines.push(line))(queued({ attempt: 10 })),
    ).rejects.toBe(failure);
    expect(task.deadLetters.map((job) => job.payoutId)).toEqual([PAYOUT]);
    expect(opened.map((entry) => entry.context.principalId)).toEqual([PRINCIPAL]);
    expect(lines).toEqual([
      `event=payout_dead_letter task=payout.advance principal=${PRINCIPAL} project=${PROJECT} payout=${PAYOUT} job=42 attempt=10/10 reason=TX_FAILED payout_status=needs_attention`,
    ]);
    // The error's message is never logged, only its code.
    expect(lines.join('\n')).not.toContain('secret');
  });

  it('ends a job whose payout the tenant does not have at once, moving nothing', async () => {
    const { db } = database();
    const lines: string[] = [];
    const task = definition(() => Promise.reject(new JobTargetMissingError()), false);
    await expect(
      payoutJobHandler(db, task, (line) => lines.push(line))(queued()),
    ).resolves.toBeUndefined();
    expect(task.deadLetters).toHaveLength(1);
    expect(lines).toEqual([
      `event=payout_dead_letter task=payout.advance principal=${PRINCIPAL} project=${PROJECT} payout=${PAYOUT} job=42 attempt=1/10 reason=TARGET_MISSING payout_status=not_found`,
    ]);
  });

  it('retries a missing payout when the dead letter write itself fails', async () => {
    const { db } = database({ failWrites: true });
    const lines: string[] = [];
    const task = definition(() => Promise.reject(new JobTargetMissingError()));
    await expect(payoutJobHandler(db, task, (line) => lines.push(line))(queued())).rejects.toThrow(
      'connection refused',
    );
    expect(lines).toEqual([
      `event=payout_dead_letter_failed task=payout.advance principal=${PRINCIPAL} project=${PROJECT} payout=${PAYOUT} job=42 attempt=1/10 reason=TARGET_MISSING error=ECONNREFUSED`,
    ]);
  });

  it('keeps the job error as the failure when the last dead letter write fails', async () => {
    let calls = 0;
    const base = database();
    const db: Database = {
      ...base.db,
      withTenant: async (role, context, work) => {
        calls += 1;
        if (calls === 1) return base.db.withTenant(role, context, work);
        throw Object.assign(new Error('down'), { code: '57P01' });
      },
    };
    const lines: string[] = [];
    const failure = Object.assign(new Error('refused'), { code: 'CONTRACT_REFUSED' });
    const task = definition(async (_job, tenant) => {
      await tenant.transaction(() => Promise.resolve());
      throw failure;
    });
    await expect(
      payoutJobHandler(db, task, (line) => lines.push(line))(queued({ attempt: 10 })),
    ).rejects.toBe(failure);
    expect(lines).toEqual([
      `event=payout_dead_letter_failed task=payout.advance principal=${PRINCIPAL} project=${PROJECT} payout=${PAYOUT} job=42 attempt=10/10 reason=CONTRACT_REFUSED error=57P01`,
    ]);
  });

  it('passes the stop signal through to the handler', async () => {
    const { db } = database();
    const controller = new AbortController();
    let signal: AbortSignal | undefined;
    await payoutJobHandler(
      db,
      definition(async (job, tenant) => {
        signal = job.signal;
        await ok(job, tenant);
      }),
      () => undefined,
    )(queued({ signal: controller.signal }));
    controller.abort();
    expect(signal?.aborted).toBe(true);
  });
});

describe('errorCode', () => {
  it.each([
    [Object.assign(new Error('x'), { code: 'TX_FAILED' }), 'TX_FAILED'],
    [Object.assign(new Error('x'), { code: 'has spaces and a secret' }), 'Error'],
    [Object.assign(new Error('x'), { code: 7 }), 'Error'],
    [new TypeError('x'), 'TypeError'],
    [new JobTargetMissingError(), 'TARGET_MISSING'],
    ['a string', 'unknown'],
    [undefined, 'unknown'],
  ])('reads %s as %s', (error, code) => {
    expect(errorCode(error)).toBe(code);
  });

  it('never repeats an odd error name', () => {
    const error = new Error('x');
    error.name = 'name with a value in it';
    expect(errorCode(error)).toBe('Error');
  });
});
