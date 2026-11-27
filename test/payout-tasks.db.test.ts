// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The payout tasks end to end: a real Graphile Worker and real tenant policies,
// with payouts written by the repository as the API writes them, and the
// chain answered by the fake mandate RPC behind the real Stellar adapter.

import { afterAll, beforeAll, beforeEach, describe, expect, inject, it, vi } from 'vitest';

import { StellarChainAdapter } from '../src/chain/stellar/adapter.js';
import { address, bytes32 } from '../src/chain/stellar/codec.js';
import {
  TESTNET_FACTORY,
  TESTNET_USDC_CONTRACT,
  TESTNET_USDC_ISSUER,
} from '../src/chain/stellar/testnet.js';
import {
  jobs,
  loadDatabaseConfig,
  payoutJobQueue,
  payoutLegs,
  payouts,
  startJobRunner,
  type Database,
  type DatabaseConfig,
  type JobRunner,
  type Payout,
} from '../src/db/index.js';
import {
  createTestDatabase,
  databaseAsServiceRoles,
  newPayout,
  payoutWorld,
  queueFixture,
  roleUrl,
  usdc,
  type PayoutWorld,
  type QueueFixture,
  type TestDatabase,
} from '../src/db/testing/index.js';
import { payoutSigners } from '../src/payouts/signers.js';
import { PayoutWorkflow } from '../src/payouts/workflow.js';
import { payoutJobHandler } from '../src/worker/payout-jobs.js';
import { deadLetterPayout } from '../src/worker/payout-store.js';
import { payoutTasks } from '../src/worker/payout-tasks.js';
import {
  FakeMandateRpc,
  MANDATE,
  UNIT,
  agent,
  approver,
  executor,
  testSigner,
} from './fake-rpc.js';
import { FakeNetwork } from './fake-network.js';

const adminUrl = inject('dbAdminUrl');
const roleUrls = inject('dbRoleUrls');
const WAIT = { timeout: 30_000, interval: 100 };

let database: TestDatabase;
let fixture: QueueFixture;
let db: Database;
let config: DatabaseConfig;
let world: PayoutWorld;
const rpc = new FakeMandateRpc();
const destination = testSigner('ada').publicKey;
const recipientRef = 'a1'.repeat(32);

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
  const tenant = await fixture.tenant('Payout jobs');
  world = await payoutWorld(db, tenant, {
    contractAddress: MANDATE,
    agentPublicKey: agent.publicKey,
    destination,
    recipientRef,
  });
  rpc.allowRecipient(recipientRef, destination);
});

beforeEach(async () => {
  await fixture.clearJobs();
  rpc.down = false;
});

afterAll(async () => {
  await db.close();
  await fixture.close();
  await database.drop();
});

async function payoutOf(id: string): Promise<Payout | undefined> {
  return db.withTenant('worker', { ...world.context, scope: 'project' }, (tx) =>
    payouts.get(tx, id),
  );
}

async function create(amount: bigint): Promise<Payout> {
  const created = await db
    .tenant(world.context)
    .transaction((tx) =>
      payouts.create(tx, newPayout(world, { amount: usdc(amount) }), payoutJobQueue),
    );
  return created.payout;
}

async function runner(lines: string[] = []): Promise<JobRunner> {
  const chain = new StellarChainAdapter({
    gateway: rpc,
    chain: new FakeNetwork(),
    factory: TESTNET_FACTORY,
    asset: { code: 'USDC', issuer: TESTNET_USDC_ISSUER, contract: TESTNET_USDC_CONTRACT },
  });
  const log = (line: string) => {
    lines.push(line);
  };
  const workflow = new PayoutWorkflow({
    chain,
    signers: payoutSigners({ executor, projectKeys: { signer: () => Promise.resolve(agent) } }),
    log,
    // The fake mandate's clock, so request deadlines are in its future.
    now: () => new Date(Number(rpc.now) * 1000),
  });
  const tasks = payoutTasks({ workflow, log });
  return startJobRunner(config, {
    tasks: Object.fromEntries(tasks.map((task) => [task.task, payoutJobHandler(db, task, log)])),
    concurrency: 2,
    log,
    pollIntervalMs: 200,
  });
}

async function jobsFor(id: string) {
  return (await fixture.jobs()).filter(
    (row) => (row.payload as { payoutId?: string } | null)?.payoutId === id,
  );
}

describe('the payout tasks on a real queue', () => {
  it('pays a payout below the threshold once and leaves its receipt job queued', async () => {
    const running = await runner();
    try {
      const payout = await create(5n * UNIT);
      await vi.waitFor(async () => {
        expect((await payoutOf(payout.id))?.status).toBe('paid');
      }, WAIT);
      const paid = await payoutOf(payout.id);
      expect(paid?.requestTxHash).toMatch(/^[0-9a-f]{64}$/);
      expect(paid?.settledAt).not.toBeNull();
      const legs = await db.withTenant('worker', { ...world.context, scope: 'project' }, (tx) =>
        payoutLegs.list(tx, payout.id),
      );
      expect(legs.map((leg) => leg.status)).toEqual(['settled']);
      expect(rpc.txs.get(legs[0]?.txHash ?? '')).toBe('SUCCESS');
      await vi.waitFor(async () => {
        expect((await jobsFor(payout.id)).map((row) => row.task)).toEqual(['receipt.issue']);
      }, WAIT);
    } finally {
      await running.stop();
    }
    expect(rpc.paid.filter((leg) => leg.destination === destination)).toHaveLength(1);
  });

  it('waits for the approver with a later job, then pays once', async () => {
    const running = await runner();
    try {
      const payout = await create(25n * UNIT);
      await vi.waitFor(async () => {
        expect((await payoutOf(payout.id))?.status).toBe('pending_approval');
      }, WAIT);
      // The run that queued it ends first, so one job is left: the later look.
      await vi.waitFor(async () => {
        expect(await jobsFor(payout.id)).toHaveLength(1);
      }, WAIT);
      const [later] = await jobsFor(payout.id);
      expect(later).toMatchObject({
        task: 'payout.advance',
        queue: `agent:${world.context.projectId}`,
      });
      await rpc.invoke(
        MANDATE,
        'approve',
        [address(approver.publicKey), bytes32(payout.onchainPayoutId)],
        approver,
      );
      // Brings the later look forward rather than waiting out its delay.
      if (later !== undefined) await fixture.setAttempts(later.id, 0);
      await vi.waitFor(async () => {
        expect((await payoutOf(payout.id))?.status).toBe('paid');
      }, WAIT);
    } finally {
      await running.stop();
    }
  });

  it('keeps the payout submitting through an outage and dead letters it on the tenth attempt', async () => {
    rpc.down = true;
    const payout = await create(3n * UNIT);
    const [job] = await jobsFor(payout.id);
    if (job === undefined) throw new Error('no job was queued');
    await fixture.setAttempts(job.id, 9);
    const lines: string[] = [];
    const running = await runner(lines);
    try {
      await vi.waitFor(async () => {
        expect((await payoutOf(payout.id))?.status).toBe('needs_attention');
      }, WAIT);
    } finally {
      await running.stop();
    }
    expect(lines.join('\n')).toContain('payout_status=needs_attention');
  });

  it('blocks a payout the contract refuses, with the spec error', async () => {
    const running = await runner();
    try {
      const payout = await create(60n * UNIT);
      await vi.waitFor(async () => {
        expect(await payoutOf(payout.id)).toMatchObject({
          status: 'blocked',
          blockedBy: 'PAYMENT_CAP_EXCEEDED',
        });
      }, WAIT);
    } finally {
      await running.stop();
    }
  });
});

describe('the dead letter move', () => {
  it('reports null for a payout the tenant cannot see', async () => {
    const other = await fixture.tenant('Elsewhere');
    const payout = await create(1n * UNIT);
    const status = await db.withTenant('worker', { ...other, scope: 'project' }, (tx) =>
      deadLetterPayout(tx, payout.id),
    );
    expect(status).toBeNull();
    expect((await payoutOf(payout.id))?.status).toBe('queued');
  });

  it('walks a queued payout to needs_attention', async () => {
    const payout = await create(1n * UNIT);
    const status = await db.withTenant('worker', { ...world.context, scope: 'project' }, (tx) =>
      deadLetterPayout(tx, payout.id),
    );
    expect(status).toBe('needs_attention');
  });
});

describe('enqueue_payout_later', () => {
  it('queues the job for later, and only the worker may call it', async () => {
    const payout = await create(1n * UNIT);
    await fixture.clearJobs();
    await db.withTenant('worker', { ...world.context, scope: 'project' }, async (tx) => {
      await jobs.enqueuePayoutLater(tx, 'payout.advance', payout.id, 60);
    });
    expect((await jobsFor(payout.id)).map((row) => row.task)).toEqual(['payout.advance']);
    await expect(
      db.tenant(world.context).transaction(async (tx) => {
        await jobs.enqueuePayoutLater(tx, 'payout.advance', payout.id, 60);
      }),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('refuses a delay outside 1 to 3600 seconds before any SQL', async () => {
    const payout = await create(1n * UNIT);
    for (const delay of [0, 3601, 1.5]) {
      await expect(
        db.withTenant('worker', { ...world.context, scope: 'project' }, async (tx) =>
          jobs.enqueuePayoutLater(tx, 'payout.advance', payout.id, delay),
        ),
      ).rejects.toMatchObject({ name: 'RepositoryInputError' });
    }
  });
});
