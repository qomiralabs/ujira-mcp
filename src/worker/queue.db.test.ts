// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The payout queue end to end: a real Graphile Worker, installed by the worker
// login, running payout jobs against real tenant policies. Each test empties
// the queue first, so no runner meets another test's jobs.

import { afterAll, beforeAll, beforeEach, describe, expect, inject, it, vi } from 'vitest';

import {
  jobs,
  loadDatabaseConfig,
  startJobRunner,
  type Database,
  type DatabaseConfig,
  type JobRunner,
  type ProjectContext,
} from '../db/index.js';
import {
  createTestDatabase,
  databaseAsServiceRoles,
  queueFixture,
  roleUrl,
  type QueueFixture,
  type QueueRow,
  type TestDatabase,
} from '../db/testing/index.js';
import {
  JobTargetMissingError,
  payoutJobHandler,
  type PayoutJob,
  type PayoutTaskDefinition,
} from './payout-jobs.js';

const adminUrl = inject('dbAdminUrl');
const roleUrls = inject('dbRoleUrls');

let database: TestDatabase;
let fixture: QueueFixture;
let db: Database;
let config: DatabaseConfig;

const WAIT = { timeout: 30_000, interval: 100 };

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

beforeAll(async () => {
  database = await createTestDatabase(adminUrl, import.meta.url);
  fixture = await queueFixture(database);
  db = databaseAsServiceRoles(roleUrls, database, 4);
  config = loadDatabaseConfig({
    UJIRA_DB_APP_URL: roleUrl(roleUrls, 'ujira_app', database.name),
    UJIRA_DB_WORKER_URL: roleUrl(roleUrls, 'ujira_worker', database.name),
    UJIRA_DB_READER_URL: roleUrl(roleUrls, 'ujira_reader', database.name),
    UJIRA_DB_MIGRATOR_URL: database.url,
    UJIRA_DB_TLS: 'off',
    UJIRA_DB_POOL_SIZE: '2',
  });
});

beforeEach(async () => {
  await fixture.clearJobs();
});

afterAll(async () => {
  await db.close();
  await fixture.close();
  await database.drop();
});

/** A committed payout of the tenant and its first job, in one transaction. */
async function payoutWithJob(
  tenant: ProjectContext,
  task: 'payout.advance' | 'payout.execute' | 'receipt.issue' = 'payout.advance',
): Promise<string> {
  return db.tenant(tenant).transaction(async (tx) => {
    const id = await fixture.payouts.insert(tx);
    await jobs.enqueuePayout(tx, task, id);
    return id;
  });
}

async function jobsOf(tenant: ProjectContext): Promise<readonly QueueRow[]> {
  return (await fixture.jobs()).filter(
    (row) => (row.payload as { projectId?: string } | null)?.projectId === tenant.projectId,
  );
}

interface Started {
  readonly runner: JobRunner;
  readonly lines: string[];
}

async function runnerFor(
  definition: PayoutTaskDefinition,
  options: { concurrency?: number; abortAfterMs?: number } = {},
): Promise<Started> {
  const lines: string[] = [];
  const log = (line: string) => {
    lines.push(line);
  };
  const runner = await startJobRunner(config, {
    tasks: { [definition.task]: payoutJobHandler(db, definition, log) },
    concurrency: options.concurrency ?? 4,
    log,
    pollIntervalMs: 200,
    ...(options.abortAfterMs === undefined ? {} : { abortAfterMs: options.abortAfterMs }),
  });
  return { runner, lines };
}

/** Reads the payout under the job's tenant first, as every real handler will. */
function advance(work: (job: PayoutJob) => Promise<void>): PayoutTaskDefinition {
  return {
    task: 'payout.advance',
    run: async (job, tenant) => {
      const status = await tenant.transaction(async (tx) =>
        fixture.payouts.status(tx, job.payoutId),
      );
      if (status === undefined) throw new JobTargetMissingError();
      await work(job);
    },
    deadLetter: async (tx, job) =>
      (await fixture.payouts.markNeedsAttention(tx, job.payoutId)) ? 'needs_attention' : null,
  };
}

describe('enqueueing a payout job', () => {
  it('writes the payout row and its job atomically: a rollback leaves neither', async () => {
    const tenant = await fixture.tenant('Atomic');
    const before = await fixture.payouts.count();
    await expect(
      db.tenant(tenant).transaction(async (tx) => {
        const id = await fixture.payouts.insert(tx);
        await jobs.enqueuePayout(tx, 'payout.advance', id);
        throw new Error('the request failed after the job was added');
      }),
    ).rejects.toThrow('the request failed after the job was added');
    expect(await fixture.payouts.count()).toBe(before);
    expect(await jobsOf(tenant)).toEqual([]);

    const id = await payoutWithJob(tenant);
    expect(await fixture.payouts.count()).toBe(before + 1);
    expect(await jobsOf(tenant)).toEqual([
      expect.objectContaining({
        task: 'payout.advance',
        queue: `agent:${tenant.projectId}`,
        key: `${tenant.projectId}:payout:${id}:payout.advance`,
        payload: { principalId: tenant.principalId, projectId: tenant.projectId, payoutId: id },
        attempts: 0,
        maxAttempts: 10,
        locked: false,
      }),
    ]);
  });

  it('makes one job of two enqueues with one job key, in one transaction or two', async () => {
    const tenant = await fixture.tenant('Twice');
    const id = await db.tenant(tenant).transaction(async (tx) => {
      const created = await fixture.payouts.insert(tx);
      await jobs.enqueuePayout(tx, 'payout.advance', created);
      await jobs.enqueuePayout(tx, 'payout.advance', created);
      return created;
    });
    await db.tenant(tenant).transaction(async (tx) => {
      await jobs.enqueuePayout(tx, 'payout.advance', id);
    });
    const advanceJobs = (await jobsOf(tenant)).filter((row) => row.task === 'payout.advance');
    expect(advanceJobs).toHaveLength(1);
  });

  it('puts each task on its own queue: one per agent key, one for the executor, none for receipts', async () => {
    const tenant = await fixture.tenant('Queues');
    const id = await payoutWithJob(tenant, 'payout.execute');
    await db.tenant(tenant).transaction(async (tx) => {
      await jobs.enqueuePayout(tx, 'receipt.issue', id);
    });
    const rows = await jobsOf(tenant);
    expect(rows.map((row) => [row.task, row.queue])).toEqual([
      ['payout.execute', 'executor'],
      ['receipt.issue', null],
    ]);
  });

  it('keeps two tenants apart even when one names the other one payout id', async () => {
    const a = await fixture.tenant('Keys A');
    const b = await fixture.tenant('Keys B');
    const id = await payoutWithJob(a);
    // A wrong id under B's context is B's job, under B's key, and cannot
    // replace the job A is waiting on.
    await db.tenant(b).transaction(async (tx) => {
      await jobs.enqueuePayout(tx, 'payout.advance', id);
    });
    const [ofA] = await jobsOf(a);
    const [ofB] = await jobsOf(b);
    expect(ofA?.payload).toEqual({
      principalId: a.principalId,
      projectId: a.projectId,
      payoutId: id,
    });
    expect(ofB?.payload).toEqual({
      principalId: b.principalId,
      projectId: b.projectId,
      payoutId: id,
    });
    expect(ofA?.key).not.toBe(ofB?.key);
  });
});

describe('running payout jobs', () => {
  it('never runs two jobs of one queue at the same time, and runs two queues side by side', async () => {
    const principal = await fixture.tenant('Serial');
    const second = await fixture.project(principal.principalId, 'Serial two');
    const active = new Map<string, number>();
    const most = new Map<string, number>();
    let overall = 0;
    let overallMost = 0;
    let done = 0;
    const { runner } = await runnerFor(
      advance(async (job) => {
        const now = (active.get(job.projectId) ?? 0) + 1;
        active.set(job.projectId, now);
        most.set(job.projectId, Math.max(most.get(job.projectId) ?? 0, now));
        overall += 1;
        overallMost = Math.max(overallMost, overall);
        await sleep(300);
        active.set(job.projectId, (active.get(job.projectId) ?? 1) - 1);
        overall -= 1;
        done += 1;
      }),
      { concurrency: 4 },
    );
    try {
      for (let i = 0; i < 3; i += 1) {
        await payoutWithJob(principal);
        await payoutWithJob(second);
      }
      await vi.waitFor(() => {
        expect(done).toBe(6);
      }, WAIT);
    } finally {
      await runner.stop();
    }
    expect(most.get(principal.projectId)).toBe(1);
    expect(most.get(second.projectId)).toBe(1);
    // Not vacuous: the runner did run jobs at once, just never two of one queue.
    expect(overallMost).toBe(2);
  });

  it('lets a running job finish on stop, records it done, and never runs it again', async () => {
    const tenant = await fixture.tenant('Finish');
    let started = 0;
    let finished = 0;
    const definition = advance(async () => {
      started += 1;
      await sleep(500);
      finished += 1;
    });
    const first = await runnerFor(definition);
    await payoutWithJob(tenant);
    await vi.waitFor(() => {
      expect(started).toBe(1);
    }, WAIT);
    await first.runner.stop();
    expect(finished).toBe(1);
    expect(await jobsOf(tenant)).toEqual([]);

    const second = await runnerFor(definition);
    await sleep(1_000);
    await second.runner.stop();
    expect(started).toBe(1);
  });

  it('releases a job still running when the stop aborts it, and a restart picks it up', async () => {
    const tenant = await fixture.tenant('Release');
    let runs = 0;
    let completed = 0;
    const definition = advance(async (job) => {
      runs += 1;
      if (runs === 1) {
        // A handler that honours the signal, as every chain call does.
        await new Promise<void>((_resolve, reject) => {
          job.signal.addEventListener('abort', () => {
            reject(Object.assign(new Error('stopped'), { code: 'ABORTED' }));
          });
        });
      }
      completed += 1;
    });
    const first = await runnerFor(definition, { abortAfterMs: 300 });
    await payoutWithJob(tenant);
    await vi.waitFor(() => {
      expect(runs).toBe(1);
    }, WAIT);
    await first.runner.stop();
    const [released] = await jobsOf(tenant);
    expect(released).toMatchObject({ attempts: 1, locked: false });
    expect(released?.lastError).not.toBeNull();
    expect(completed).toBe(0);

    // The library waits e seconds before a first retry.
    const second = await runnerFor(definition);
    try {
      await vi.waitFor(() => {
        expect(completed).toBe(1);
      }, WAIT);
    } finally {
      await second.runner.stop();
    }
    expect(await jobsOf(tenant)).toEqual([]);
  });

  it('ends a job naming another tenant payout without touching it, and logs a dead letter', async () => {
    const owner = await fixture.tenant('Victim');
    const other = await fixture.tenant('Other');
    const id = await db.tenant(owner).transaction(async (tx) => fixture.payouts.insert(tx));
    // One through the only door, one written past it as a hand edit would be.
    await db.tenant(other).transaction(async (tx) => {
      await jobs.enqueuePayout(tx, 'payout.advance', id);
    });
    await fixture.addRawJob(
      'payout.advance',
      { principalId: other.principalId, projectId: other.projectId, payoutId: id },
      `agent:${other.projectId}`,
    );
    let ran = 0;
    const { runner, lines } = await runnerFor(
      advance(() => {
        ran += 1;
        return Promise.resolve();
      }),
    );
    try {
      await vi.waitFor(async () => {
        expect(await jobsOf(other)).toEqual([]);
      }, WAIT);
    } finally {
      await runner.stop();
    }
    expect(ran).toBe(0);
    expect(await fixture.payouts.statusAsAdmin(id)).toBe('queued');
    const deadLetters = lines.filter((line) => line.startsWith('event=payout_dead_letter '));
    expect(deadLetters).toHaveLength(2);
    for (const line of deadLetters) {
      expect(line).toContain(`principal=${other.principalId} project=${other.projectId}`);
      expect(line).toContain('reason=TARGET_MISSING payout_status=not_found');
    }
  });

  it('runs nothing for a payload the database did not write', async () => {
    const tenant = await fixture.tenant('Forged');
    const id = await db.tenant(tenant).transaction(async (tx) => fixture.payouts.insert(tx));
    await fixture.addRawJob('payout.advance', { payoutId: id }, null);
    let ran = 0;
    const { runner, lines } = await runnerFor(
      advance(() => {
        ran += 1;
        return Promise.resolve();
      }),
    );
    try {
      await vi.waitFor(async () => {
        expect(await fixture.jobs()).toEqual([]);
      }, WAIT);
    } finally {
      await runner.stop();
    }
    expect(ran).toBe(0);
    expect(await fixture.payouts.statusAsAdmin(id)).toBe('queued');
    expect(lines.filter((line) => line.includes('reason=PAYLOAD_INVALID'))).toHaveLength(1);
  });

  it('moves the payout to needs_attention on the last failed attempt, and never claims the job again', async () => {
    const tenant = await fixture.tenant('Dead');
    const id = await payoutWithJob(tenant);
    const [job] = await jobsOf(tenant);
    if (job === undefined) throw new Error('no job was queued');
    // Nine failed runs already, without nine rounds of backoff.
    await fixture.setAttempts(job.id, 9);
    let runs = 0;
    const { runner, lines } = await runnerFor(
      advance(() => {
        runs += 1;
        return Promise.reject(
          Object.assign(new Error('refused for GDEST personal detail'), {
            code: 'CONTRACT_REFUSED',
          }),
        );
      }),
    );
    try {
      await vi.waitFor(async () => {
        expect(await fixture.payouts.statusAsAdmin(id)).toBe('needs_attention');
      }, WAIT);
      await vi.waitFor(async () => {
        expect((await jobsOf(tenant))[0]?.lastError).not.toBeNull();
      }, WAIT);
      await fixture.setAttempts(job.id, 10);
      await sleep(1_500);
    } finally {
      await runner.stop();
    }
    expect(runs).toBe(1);
    const rows = await jobsOf(tenant);
    expect(rows).toEqual([
      expect.objectContaining({ attempts: 10, maxAttempts: 10, locked: false }),
    ]);
    // The queue keeps the code; the message never reaches its row or its log.
    expect(rows[0]?.lastError).toContain('CONTRACT_REFUSED');
    expect(rows[0]?.lastError).not.toContain('personal detail');
    expect(lines.join('\n')).not.toContain('personal detail');
    expect(lines).toContain(
      `event=payout_dead_letter task=payout.advance principal=${tenant.principalId} project=${tenant.projectId} payout=${id} job=${job.id} attempt=10/10 reason=CONTRACT_REFUSED payout_status=needs_attention`,
    );
  });

  it('leaves a job of a task this runner does not run waiting in the queue', async () => {
    const tenant = await fixture.tenant('Waiting');
    await payoutWithJob(tenant, 'payout.execute');
    const { runner } = await runnerFor(advance(() => Promise.resolve()));
    await sleep(1_000);
    await runner.stop();
    expect(await jobsOf(tenant)).toEqual([
      expect.objectContaining({ task: 'payout.execute', attempts: 0, locked: false }),
    ]);
  });
});
