// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The payout jobs against the real Stellar adapter over the fake mandate RPC,
// with the payout held in memory by the database's rules. Every status move
// of the issue is here, and the worker is killed at both points that matter:
// after the request landed and after the execute landed. The same tasks over
// a real database and a real queue are in src/worker/payout-tasks.db.test.ts.

import { createHash, randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  ChainError,
  type CallOptions,
  type ChainAdapter,
  type TxSigner,
} from '../src/chain/adapter.js';
import { StellarChainAdapter } from '../src/chain/stellar/adapter.js';
import { address, bytes32 } from '../src/chain/stellar/codec.js';
import {
  TESTNET_FACTORY,
  TESTNET_USDC_CONTRACT,
  TESTNET_USDC_ISSUER,
} from '../src/chain/stellar/testnet.js';
import type { Database, QueuedJob } from '../src/db/index.js';
import { AgentKeyError } from '../src/keys/agent-keys.js';
import { PayoutRetryError } from '../src/payouts/errors.js';
import { payoutSigners, type ProjectKeySigner } from '../src/payouts/signers.js';
import {
  APPROVAL_RECHECK_MAX_SECONDS,
  APPROVAL_RECHECK_MIN_SECONDS,
  DEFAULT_SEND_WINDOW_MS,
  PayoutWorkflow,
  approvalRecheckSeconds,
  deadLetterPath,
} from '../src/payouts/workflow.js';
import { payoutJobHandler, type WorkerTransaction } from '../src/worker/payout-jobs.js';
import { payoutTasks } from '../src/worker/payout-tasks.js';
import {
  FakeMandateRpc,
  MANDATE,
  UNIT,
  agent,
  approver,
  executor,
  stranger,
  testSigner,
} from './fake-rpc.js';
import { FakeNetwork } from './fake-network.js';
import { KilledError, MemoryPayoutStore, PRINCIPAL, PROJECT } from './payout-memory-store.js';

const START = 1_800_000_000_000;

function first<T>(items: readonly T[]): T {
  const [item] = items;
  if (item === undefined) throw new Error('expected an item');
  return item;
}

interface WorldOptions {
  readonly amount: bigint;
  readonly legs?: readonly bigint[];
  readonly allowed?: boolean;
  readonly agentKeyId?: string | null;
  readonly projectKeys?: ProjectKeySigner;
  /** Stands in for some adapter calls; the rest reach the real adapter. */
  readonly chain?: (
    real: StellarChainAdapter,
    store: () => MemoryPayoutStore,
  ) => Partial<ChainAdapter>;
}

function world(o: WorldOptions) {
  const clock = { now: new Date(START) };
  const now = () => clock.now;
  const rpc = new FakeMandateRpc();
  const chain = new StellarChainAdapter({
    gateway: rpc,
    chain: new FakeNetwork(),
    factory: TESTNET_FACTORY,
    asset: { code: 'USDC', issuer: TESTNET_USDC_ISSUER, contract: TESTNET_USDC_CONTRACT },
    now: () => clock.now.getTime(),
  });
  const destination = testSigner('ada').publicKey;
  const recipientRef = createHash('sha256').update('ada').digest('hex');
  if (o.allowed !== false) rpc.allowRecipient(recipientRef, destination);
  const store = new MemoryPayoutStore(
    {
      amount: o.amount,
      destination,
      recipientRef,
      onchainPayoutId: randomBytes(32).toString('hex'),
      ...(o.legs === undefined ? {} : { legs: o.legs }),
      ...(o.agentKeyId === undefined ? {} : { agentKeyId: o.agentKeyId }),
    },
    now,
  );
  const lines: string[] = [];
  const projectKeys = o.projectKeys ?? { signer: () => Promise.resolve(agent) };
  const wrapped: ChainAdapter =
    o.chain === undefined
      ? chain
      : Object.assign(
          Object.create(chain) as ChainAdapter,
          o.chain(chain, () => store),
        );
  const workflow = new PayoutWorkflow({
    chain: wrapped,
    signers: payoutSigners({ executor, projectKeys }),
    log: (line) => lines.push(line),
    now,
  });
  const job = {
    principalId: PRINCIPAL,
    projectId: PROJECT,
    payoutId: store.payout.id,
    signal: new AbortController().signal,
  };
  const count = (call: string) => rpc.calls.filter((c) => c === call).length;
  return {
    rpc,
    chain,
    store,
    workflow,
    job,
    lines,
    destination,
    count,
    tick: (ms: number) => {
      clock.now = new Date(clock.now.getTime() + ms);
    },
    advance: () => workflow.advance(job, store),
    execute: () => workflow.execute(job, store),
    sign: async (method: 'approve' | 'reject') => {
      await rpc.invoke(
        MANDATE,
        method,
        [address(approver.publicKey), bytes32(store.payout.onchainPayoutId)],
        approver,
      );
    },
  };
}

type World = ReturnType<typeof world>;

function expectPaidOnce(w: World): void {
  expect(w.rpc.paid).toEqual([
    { destination: w.destination, amount: w.store.payout.amount.amount },
  ]);
  expect(w.count('invoke:request_payout')).toBe(1);
  const [leg] = w.store.legs;
  expect(leg?.status).toBe('settled');
  expect(leg?.txHash).toMatch(/^[0-9a-f]{64}$/);
  expect(w.rpc.txs.get(leg?.txHash ?? '')).toBe('SUCCESS');
  // Paid and the receipt job are one write.
  expect(w.store.writes.at(-1)).toMatchObject({
    path: [{ from: 'settling', to: 'paid' }],
    enqueue: [{ task: 'receipt.issue' }],
  });
}

describe('below the approval threshold', () => {
  it('goes queued, submitting, approved, settling, paid, and pays once', async () => {
    const w = world({ amount: 5n * UNIT });
    expect(await w.advance()).toBe('approved');
    expect(w.store.payout.requestTxHash).toMatch(/^[0-9a-f]{64}$/);
    expect(w.store.queued()).toEqual(['payout.execute']);
    expect(await w.execute()).toBe('paid');
    expect(w.store.history).toEqual(['queued', 'submitting', 'approved', 'settling', 'paid']);
    expect(w.store.payout.settledAt).not.toBeNull();
    expectPaidOnce(w);
    expect(w.store.queued()).toEqual(['payout.execute', 'receipt.issue']);
  });

  it('logs each move with ids and hashes, never the destination or the task', async () => {
    const w = world({ amount: 5n * UNIT });
    await w.advance();
    await w.execute();
    const text = w.lines.join('\n');
    expect(text).toContain(`event=payout_moved principalId=${PRINCIPAL} projectId=${PROJECT}`);
    expect(text).toContain('from=settling to=paid');
    expect(text).not.toContain(w.destination);
    expect(text).not.toContain(w.store.payout.taskId);
  });

  it('pays every leg of a split payout in one execute, with one hash', async () => {
    const w = world({ amount: 6n * UNIT, legs: [4n * UNIT, 2n * UNIT] });
    expect(await w.advance()).toBe('approved');
    expect(await w.execute()).toBe('paid');
    expect(w.store.legs.map((leg) => leg.status)).toEqual(['settled', 'settled']);
    expect(new Set(w.store.legs.map((leg) => leg.txHash)).size).toBe(1);
    expect(w.rpc.paid.map((leg) => leg.amount)).toEqual([4n * UNIT, 2n * UNIT]);
    expect(w.count('invoke:execute')).toBe(1);
  });
});

describe('at or above the approval threshold', () => {
  it('waits in pending_approval until the approver signs, then pays once', async () => {
    const w = world({ amount: 25n * UNIT });
    expect(await w.advance()).toBe('waiting');
    expect(w.store.payout.status).toBe('pending_approval');
    expect(w.store.payout.requestTxHash).toMatch(/^[0-9a-f]{64}$/);
    expect(w.store.queued()).toEqual([`payout.advance+${String(APPROVAL_RECHECK_MIN_SECONDS)}s`]);

    // Nobody has signed: the job looks again later and sends nothing.
    w.tick(20 * 60_000);
    expect(await w.advance()).toBe('waiting');
    expect(w.store.queued().at(-1)).toBe('payout.advance+120s');
    expect(await w.execute()).toBe('not_ready');
    expect(w.count('invoke:request_payout')).toBe(1);

    await w.sign('approve');
    expect(await w.advance()).toBe('approved');
    expect(await w.execute()).toBe('paid');
    expect(w.store.history).toEqual([
      'queued',
      'submitting',
      'pending_approval',
      'approved',
      'settling',
      'paid',
    ]);
    expectPaidOnce(w);
    // A late duplicate of either job changes nothing and sends nothing.
    expect(await w.advance()).toBe('finished');
    expect(await w.execute()).toBe('finished');
    expect(w.count('invoke:execute')).toBe(1);
  });

  it('moves to rejected when the approver rejects, cancelling the legs, and queues the receipt', async () => {
    const w = world({ amount: 25n * UNIT });
    await w.advance();
    await w.sign('reject');
    expect(await w.advance()).toBe('rejected');
    expect(w.store.history).toEqual(['queued', 'submitting', 'pending_approval', 'rejected']);
    expect(w.store.legs.map((leg) => leg.status)).toEqual(['cancelled']);
    expect(w.store.queued().at(-1)).toBe('receipt.issue');
    expect(w.rpc.paid).toEqual([]);
  });

  it('moves to cancelled when the chain cancelled it', async () => {
    const w = world({ amount: 25n * UNIT });
    await w.advance();
    w.rpc.payouts.set(w.store.payout.onchainPayoutId, { tombstone: 5 });
    expect(await w.advance()).toBe('cancelled');
    expect(w.store.payout.status).toBe('cancelled');
    expect(w.store.queued().at(-1)).toBe('receipt.issue');
  });

  it('reports drift, moving nothing, when the chain lost a pending payout', async () => {
    const w = world({ amount: 25n * UNIT });
    await w.advance();
    w.rpc.payouts.delete(w.store.payout.onchainPayoutId);
    expect(await w.advance()).toBe('drift');
    expect(w.store.payout.status).toBe('pending_approval');
    expect(w.lines.join('\n')).toContain('event=payout_drift');
  });
});

describe('killing the worker', () => {
  it('after the request landed: the retry requests nothing again and executes once', async () => {
    const w = world({ amount: 5n * UNIT });
    w.store.killWhen = (change) => change.path?.[0]?.to === 'approved';
    await expect(w.advance()).rejects.toBeInstanceOf(KilledError);
    expect(w.store.payout.status).toBe('submitting');
    expect(w.count('invoke:request_payout')).toBe(1);

    w.store.killWhen = undefined;
    expect(await w.advance()).toBe('approved');
    expect(await w.execute()).toBe('paid');
    expectPaidOnce(w);
    expect(w.count('invoke:execute')).toBe(1);
  });

  it('after the request landed but its answer was lost: it follows the chain', async () => {
    const w = world({ amount: 25n * UNIT });
    w.rpc.loseAnswerOf = 'request_payout';
    expect(await w.advance()).toBe('waiting');
    expect(w.store.payout.status).toBe('pending_approval');
    expect(w.count('invoke:request_payout')).toBe(1);
  });

  it('after the execute landed: the retry records it and sends nothing', async () => {
    const w = world({ amount: 5n * UNIT });
    await w.advance();
    w.store.killWhen = (change) => change.path?.[0]?.to === 'paid';
    await expect(w.execute()).rejects.toBeInstanceOf(KilledError);
    expect(w.store.payout.status).toBe('settling');
    expect(w.store.legs[0]?.status).toBe('submitted');
    expect(w.rpc.paid).toHaveLength(1);

    w.store.killWhen = undefined;
    expect(await w.execute()).toBe('paid');
    expect(w.count('invoke:execute')).toBe(1);
    expectPaidOnce(w);
  });

  it('after the execute landed but its answer was lost: the retry records it', async () => {
    const w = world({ amount: 5n * UNIT });
    await w.advance();
    w.rpc.loseAnswerOf = 'execute';
    await expect(w.execute()).rejects.toMatchObject({ code: 'TIMEOUT' });
    expect(await w.execute()).toBe('paid');
    expect(w.count('invoke:execute')).toBe(1);
    expectPaidOnce(w);
  });

  it('before the execute was recorded: nothing was sent, and the retry sends it once', async () => {
    const w = world({ amount: 5n * UNIT });
    await w.advance();
    w.store.killWhen = (change) => change.legs?.[0]?.change.to === 'submitted';
    await expect(w.execute()).rejects.toMatchObject({
      code: 'UNAVAILABLE',
      reason: 'before_send_failed',
    });
    expect(w.rpc.paid).toEqual([]);
    w.store.killWhen = undefined;
    expect(await w.execute()).toBe('paid');
    expectPaidOnce(w);
  });
});

describe('an execute that has not settled', () => {
  it('waits while a recorded send can still land, then sends again once it cannot', async () => {
    const w = world({ amount: 5n * UNIT });
    await w.advance();
    // A send recorded and then lost before the network saw it.
    const leg = first(w.store.legs);
    w.store.payout = { ...w.store.payout, status: 'settling' };
    w.store.legs = [
      { ...leg, status: 'submitted', txHash: 'ab'.repeat(32), updatedAt: new Date(START) },
    ];
    await expect(w.execute()).rejects.toMatchObject({ code: 'SETTLEMENT_PENDING' });
    expect(w.rpc.paid).toEqual([]);
    w.tick(DEFAULT_SEND_WINDOW_MS + 1);
    expect(await w.execute()).toBe('paid');
    expect(w.count('invoke:execute')).toBe(1);
    expectPaidOnce(w);
  });

  it('sends again at once after a send that failed on chain, and pays once', async () => {
    const w = world({ amount: 5n * UNIT });
    await w.advance();
    w.rpc.failOnChainOf = 'execute';
    await expect(w.execute()).rejects.toMatchObject({ code: 'TX_FAILED' });
    expect(w.store.legs[0]?.status).toBe('submitted');
    expect(await w.execute()).toBe('paid');
    expect(w.count('invoke:execute')).toBe(2);
    expectPaidOnce(w);
  });

  it('retries while the chain has not caught up with a send that succeeded', async () => {
    const w = world({ amount: 5n * UNIT });
    await w.advance();
    const hash = 'cd'.repeat(32);
    w.rpc.txs.set(hash, 'SUCCESS');
    w.store.payout = { ...w.store.payout, status: 'settling' };
    w.store.legs = [{ ...first(w.store.legs), status: 'submitted', txHash: hash }];
    await expect(w.execute()).rejects.toBeInstanceOf(PayoutRetryError);
    expect(w.rpc.paid).toEqual([]);
  });
});

describe('refusals and outages', () => {
  it('blocks a payout the contract refuses at request, with the spec error, and queues the receipt', async () => {
    const w = world({ amount: 60n * UNIT });
    expect(await w.advance()).toBe('blocked');
    expect(w.store.payout).toMatchObject({ status: 'blocked', blockedBy: 'PAYMENT_CAP_EXCEEDED' });
    expect(w.store.legs.map((leg) => leg.status)).toEqual(['cancelled']);
    expect(w.store.queued()).toEqual(['receipt.issue']);
    expect(w.count('invoke:request_payout')).toBe(1);
    expect(w.rpc.paid).toEqual([]);
  });

  it('blocks a recipient the mandate does not allow', async () => {
    const w = world({ amount: 1n * UNIT, allowed: false });
    expect(await w.advance()).toBe('blocked');
    expect(w.store.payout.blockedBy).toBe('RECIPIENT_NOT_ALLOWED');
  });

  it('keeps the payout in its state through an outage and retries', async () => {
    const w = world({ amount: 5n * UNIT });
    w.rpc.down = true;
    await expect(w.advance()).rejects.toBeInstanceOf(ChainError);
    expect(w.store.payout.status).toBe('submitting');
    await expect(w.advance()).rejects.toBeInstanceOf(ChainError);
    expect(w.store.payout.status).toBe('submitting');
    w.rpc.down = false;
    expect(await w.advance()).toBe('approved');
    expect(w.count('invoke:request_payout')).toBe(1);
  });

  it('moves to needs_attention after the tenth failed attempt, through the job handler', async () => {
    const w = world({ amount: 5n * UNIT });
    w.rpc.down = true;
    const lines: string[] = [];
    const db = {
      withTenant: async (
        _role: string,
        _context: unknown,
        work: (tx: WorkerTransaction) => Promise<unknown>,
      ) => work(undefined as unknown as WorkerTransaction),
    } as unknown as Database;
    const [advance] = payoutTasks({
      workflow: w.workflow,
      log: (line) => lines.push(line),
      storeFor: () => w.store,
      deadLetter: async () => {
        await w.store.apply(w.store.payout.id, { path: deadLetterPath(w.store.payout.status) });
        return w.store.payout.status;
      },
    });
    if (advance === undefined) throw new Error('no advance task');
    const handler = payoutJobHandler(db, advance, (line) => lines.push(line));
    const queued = (attempt: number): QueuedJob => ({
      id: '7',
      task: 'payout.advance',
      payload: { principalId: PRINCIPAL, projectId: PROJECT, payoutId: w.store.payout.id },
      attempt,
      maxAttempts: 10,
      signal: new AbortController().signal,
    });
    for (let attempt = 1; attempt < 10; attempt += 1) {
      await expect(handler(queued(attempt))).rejects.toBeInstanceOf(ChainError);
      expect(w.store.payout.status).toBe('submitting');
    }
    await expect(handler(queued(10))).rejects.toBeInstanceOf(ChainError);
    expect(w.store.payout.status).toBe('needs_attention');
    expect(lines.at(-1)).toContain('event=payout_dead_letter task=payout.advance');
    expect(lines.at(-1)).toContain('payout_status=needs_attention');
    expect(w.count('invoke:request_payout')).toBe(0);
  });

  it('moves to needs_attention when the mandate execute refuses, sending nothing more', async () => {
    const w = world({ amount: 5n * UNIT });
    await w.advance();
    w.rpc.executors = [stranger.publicKey];
    expect(await w.execute()).toBe('needs_attention');
    expect(w.store.payout.status).toBe('needs_attention');
    expect(w.lines.join('\n')).toContain('event=payout_execute_refused');
    // Put right, a person queues execute again and it pays once.
    w.rpc.executors = [executor.publicKey];
    expect(await w.execute()).toBe('paid');
    expectPaidOnce(w);
  });
});

describe('keys', () => {
  it('signs the request with the project key the mandate names', async () => {
    const asked: string[] = [];
    const w = world({
      amount: 5n * UNIT,
      projectKeys: {
        signer: (context, id) => {
          asked.push(`${context.projectId}/${id}`);
          return Promise.resolve(agent);
        },
      },
    });
    expect(await w.advance()).toBe('approved');
    expect(asked).toEqual([`${PROJECT}/${w.store.mandate.agentKeyId ?? ''}`]);
  });

  it.each([
    ['a mandate with no project key', { agentKeyId: null }],
    ['a key for another account', { projectKeys: { signer: () => Promise.resolve(stranger) } }],
    [
      'a key that no longer opens',
      {
        projectKeys: {
          signer: () => Promise.reject(new AgentKeyError('KEY_UNREADABLE', 'does not open')),
        },
      },
    ],
  ])('sends nothing and needs a person for %s', async (_label, options) => {
    const w = world({ amount: 5n * UNIT, ...options });
    expect(await w.advance()).toBe('needs_attention');
    expect(w.store.payout.status).toBe('needs_attention');
    expect(w.count('invoke:request_payout')).toBe(0);
    expect(w.lines.join('\n')).toContain('reason=AGENT_KEY_UNAVAILABLE');
  });

  it('lets an outage reading the key go back to the queue', async () => {
    const w = world({
      amount: 5n * UNIT,
      projectKeys: { signer: () => Promise.reject(new Error('connection refused')) },
    });
    await expect(w.advance()).rejects.toThrow('connection refused');
    expect(w.store.payout.status).toBe('submitting');
  });
});

describe('other states', () => {
  it('hands an approved payout to the executor, and re-queues a lost receipt job', async () => {
    const w = world({ amount: 5n * UNIT });
    await w.advance();
    expect(await w.advance()).toBe('handed_on');
    await w.execute();
    w.store.jobs.length = 0;
    expect(await w.advance()).toBe('finished');
    expect(w.store.queued()).toEqual(['receipt.issue']);
    w.store.hasReceipt = true;
    w.store.jobs.length = 0;
    expect(await w.execute()).toBe('finished');
    expect(w.store.queued()).toEqual([]);
  });

  it('answers missing for a payout the store does not hold, which the task ends at once', async () => {
    const w = world({ amount: 5n * UNIT });
    const other = { ...w.job, payoutId: '00000000-0000-4000-8000-000000000000' };
    expect(await w.workflow.advance(other, w.store)).toBe('missing');
    expect(await w.workflow.execute(other, w.store)).toBe('missing');
    const tasks = payoutTasks({
      workflow: w.workflow,
      log: () => undefined,
      storeFor: () => w.store,
    });
    expect(tasks.map((task) => task.task)).toEqual(['payout.advance', 'payout.execute']);
    const tenant = { transaction: () => Promise.reject(new Error('not used')) };
    await expect(
      first(tasks).run(
        { ...other, task: 'payout.advance', jobId: '1', attempt: 1, maxAttempts: 10 },
        tenant,
      ),
    ).rejects.toMatchObject({ code: 'TARGET_MISSING' });
  });

  it('marks a payout the chain executed without its record as needing attention', async () => {
    const w = world({ amount: 5n * UNIT });
    await w.advance();
    w.rpc.payouts.set(w.store.payout.onchainPayoutId, { tombstone: 3 });
    expect(await w.execute()).toBe('needs_attention');
    expect(w.lines.join('\n')).toContain('reason=EXECUTED_UNRECORDED');
  });

  it('re-requests from needs_attention once a person queues it again', async () => {
    const w = world({ amount: 5n * UNIT, agentKeyId: null });
    expect(await w.advance()).toBe('needs_attention');
    const fixed = world({ amount: 5n * UNIT });
    fixed.store.payout = { ...fixed.store.payout, status: 'needs_attention' };
    expect(await fixed.advance()).toBe('approved');
  });

  it('leaves a stale run without effect', async () => {
    const w = world({ amount: 5n * UNIT });
    w.store.killWhen = undefined;
    const original = w.store.apply.bind(w.store);
    w.store.apply = (id, change) =>
      change.path?.[0]?.from === 'queued' ? Promise.resolve(false) : original(id, change);
    expect(await w.advance()).toBe('stale');
    expect(w.count('read:payout')).toBe(0);
  });
});

describe('timing', () => {
  it('looks at a pending payout again after a tenth of its wait, within bounds', () => {
    expect(approvalRecheckSeconds(0)).toBe(APPROVAL_RECHECK_MIN_SECONDS);
    expect(approvalRecheckSeconds(-5)).toBe(APPROVAL_RECHECK_MIN_SECONDS);
    expect(approvalRecheckSeconds(20 * 60_000)).toBe(120);
    expect(approvalRecheckSeconds(24 * 3_600_000)).toBe(APPROVAL_RECHECK_MAX_SECONDS);
  });

  it('dead letters to needs_attention wherever the status machine allows it', () => {
    expect(deadLetterPath('queued').map((s) => s.to)).toEqual(['submitting', 'needs_attention']);
    expect(deadLetterPath('submitting').map((s) => s.to)).toEqual(['needs_attention']);
    expect(deadLetterPath('approved').map((s) => s.to)).toEqual(['settling', 'needs_attention']);
    expect(deadLetterPath('settling').map((s) => s.to)).toEqual(['needs_attention']);
    for (const status of ['pending_approval', 'paid', 'blocked', 'needs_attention'] as const) {
      expect(deadLetterPath(status)).toEqual([]);
    }
  });
});

describe('every other path', () => {
  const refused = (specError?: string) =>
    new ChainError('CONTRACT_REFUSED', 'refused', specError === undefined ? {} : { specError });

  it('names CONTRACT_REFUSED when a refusal carries no spec error name', async () => {
    const w = world({
      amount: 5n * UNIT,
      chain: () => ({ requestPayout: () => Promise.reject(refused()) }),
    });
    expect(await w.advance()).toBe('blocked');
    expect(w.store.payout.blockedBy).toBe('CONTRACT_REFUSED');
  });

  it('retries a request that failed on chain, since nothing landed', async () => {
    const w = world({ amount: 5n * UNIT });
    w.rpc.failOnChainOf = 'request_payout';
    await expect(w.advance()).rejects.toMatchObject({ code: 'TX_FAILED' });
    expect(w.store.payout.status).toBe('submitting');
    expect(await w.advance()).toBe('approved');
  });

  it('reads the chain when the adapter does not say what the request left', async () => {
    const w = world({
      amount: 5n * UNIT,
      chain: (real) => ({
        requestPayout: async (...args: Parameters<ChainAdapter['requestPayout']>) => ({
          txHash: (await real.requestPayout(...args)).txHash,
        }),
      }),
    });
    expect(await w.advance()).toBe('approved');
    expect(w.store.payout.requestTxHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('retries when the chain does not show a request that answered', async () => {
    const w = world({
      amount: 5n * UNIT,
      chain: () => ({ requestPayout: () => Promise.resolve({ txHash: 'ef'.repeat(32) }) }),
    });
    await expect(w.advance()).rejects.toMatchObject({ code: 'CHAIN_LAGGING' });
    expect(w.store.payout.status).toBe('submitting');
  });

  it('records the hash of a request whose answer was lost, once the network confirms it', async () => {
    const w = world({
      amount: 25n * UNIT,
      chain: (real) => ({
        requestPayout: async (...args: Parameters<ChainAdapter['requestPayout']>) => {
          const { txHash } = await real.requestPayout(...args);
          throw new ChainError('TIMEOUT', 'lost', { txHash });
        },
      }),
    });
    expect(await w.advance()).toBe('waiting');
    expect(w.store.payout.requestTxHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('leaves the request hash unset after a lost answer that is not a chain error', async () => {
    const w = world({
      amount: 25n * UNIT,
      chain: (real) => ({
        requestPayout: async (...args: Parameters<ChainAdapter['requestPayout']>) => {
          await real.requestPayout(...args);
          throw new Error('socket closed');
        },
      }),
    });
    expect(await w.advance()).toBe('waiting');
    expect(w.store.payout.requestTxHash).toBeNull();
  });

  it('moves a submitting payout the approver already rejected through pending_approval', async () => {
    const w = world({ amount: 25n * UNIT });
    w.store.killWhen = (change) => change.path?.[0]?.to === 'pending_approval';
    await expect(w.advance()).rejects.toBeInstanceOf(KilledError);
    w.store.killWhen = undefined;
    await w.sign('reject');
    expect(await w.advance()).toBe('rejected');
    expect(w.store.history).toEqual(['queued', 'submitting', 'pending_approval', 'rejected']);
  });

  it('answers not_ready for a reserved status', async () => {
    const w = world({ amount: 5n * UNIT });
    w.store.payout = { ...w.store.payout, status: 'partly_paid' };
    expect(await w.advance()).toBe('not_ready');
  });

  it('runs on the wall clock when no clock is given', async () => {
    const w = world({ amount: 5n * UNIT });
    const plain = new PayoutWorkflow({
      chain: w.chain,
      signers: payoutSigners({ executor, projectKeys: { signer: () => Promise.resolve(agent) } }),
      log: () => undefined,
    });
    expect(await plain.advance({ ...w.job, payoutId: 'none' }, w.store)).toBe('missing');
  });

  it('answers stale wherever another run moved the payout first', async () => {
    const stale = (when: (change: Parameters<MemoryPayoutStore['apply']>[1]) => boolean) => {
      const w = world({ amount: 5n * UNIT });
      const original = w.store.apply.bind(w.store);
      w.store.apply = (id, change) =>
        when(change) ? Promise.resolve(false) : original(id, change);
      return w;
    };
    const toApproved = stale((change) => change.path?.[0]?.to === 'approved');
    expect(await toApproved.advance()).toBe('stale');

    const toSettling = stale((change) => change.path?.[0]?.to === 'settling');
    await toSettling.advance();
    expect(await toSettling.execute()).toBe('stale');

    const sendRecord = stale((change) => change.legs?.[0]?.change.to === 'submitted');
    await sendRecord.advance();
    await expect(sendRecord.execute()).rejects.toMatchObject({ reason: 'before_send_failed' });
    expect(sendRecord.rpc.paid).toEqual([]);

    const reset = stale((change) => change.legs?.[0]?.change.to === 'planned');
    await reset.advance();
    reset.rpc.failOnChainOf = 'execute';
    await expect(reset.execute()).rejects.toMatchObject({ code: 'TX_FAILED' });
    expect(await reset.execute()).toBe('stale');
  });

  it('settles a refused execute from the chain when an earlier send paid it', async () => {
    const w = world({
      amount: 5n * UNIT,
      chain: (real) => ({
        executePayout: async (...args: Parameters<ChainAdapter['executePayout']>) => {
          await real.executePayout(...args);
          throw refused('PAYOUT_WRONG_STATUS');
        },
      }),
    });
    await w.advance();
    expect(await w.execute()).toBe('paid');
    expectPaidOnce(w);
  });

  it('answers stale when a refused execute finds the payout moved on', async () => {
    const w = world({
      amount: 5n * UNIT,
      chain: (_real, store) => ({
        executePayout: () => {
          store().payout = { ...store().payout, status: 'needs_attention' };
          return Promise.reject(refused('PAYOUT_WRONG_STATUS'));
        },
      }),
    });
    await w.advance();
    expect(await w.execute()).toBe('stale');
  });

  it('settles legs it could not record before the send, for an adapter without the hook', async () => {
    const w = world({
      amount: 5n * UNIT,
      chain: (real) => ({
        executePayout: (contract: string, id: string, signer: TxSigner, o: CallOptions) =>
          real.executePayout(contract, id, signer, o),
      }),
    });
    await w.advance();
    expect(await w.execute()).toBe('paid');
    expect(w.store.writes.at(-1)?.legs?.[0]?.change.from).toBe('planned');
  });

  it('waits on an executed payout whose recorded send the network has not shown yet', async () => {
    const w = world({ amount: 5n * UNIT });
    await w.advance();
    w.store.payout = { ...w.store.payout, status: 'settling' };
    w.store.legs = [{ ...first(w.store.legs), status: 'submitted', txHash: '12'.repeat(32) }];
    w.rpc.payouts.set(w.store.payout.onchainPayoutId, { tombstone: 3 });
    await expect(w.execute()).rejects.toMatchObject({ code: 'CHAIN_LAGGING' });
    w.tick(DEFAULT_SEND_WINDOW_MS + 1);
    expect(await w.execute()).toBe('needs_attention');
    expect(w.lines.join('\n')).toContain('reason=EXECUTED_UNRECORDED');
  });

  it('needs a person for an executed payout whose recorded send failed', async () => {
    const w = world({ amount: 5n * UNIT });
    await w.advance();
    const hash = '34'.repeat(32);
    w.rpc.txs.set(hash, 'FAILED');
    w.store.payout = { ...w.store.payout, status: 'settling' };
    w.store.legs = [{ ...first(w.store.legs), status: 'submitted', txHash: hash }];
    w.rpc.payouts.set(w.store.payout.onchainPayoutId, { tombstone: 3 });
    expect(await w.execute()).toBe('needs_attention');
  });

  it('needs a person when the chain says the payout is not approved at execute', async () => {
    const w = world({ amount: 25n * UNIT });
    await w.advance();
    w.store.payout = { ...w.store.payout, status: 'approved' };
    expect(await w.execute()).toBe('needs_attention');
    expect(w.lines.join('\n')).toContain('reason=CHAIN_PENDING');
    expect(w.rpc.paid).toEqual([]);
  });

  it('sends legs recorded apart again under one hash', async () => {
    const w = world({ amount: 6n * UNIT, legs: [4n * UNIT, 2n * UNIT] });
    await w.advance();
    const [a, b] = w.store.legs;
    if (a === undefined || b === undefined) throw new Error('two legs expected');
    w.store.payout = { ...w.store.payout, status: 'settling' };
    w.store.legs = [{ ...a, status: 'submitted', txHash: '56'.repeat(32) }, b];
    // Not every leg was recorded under one hash, so nothing is looked up and the planned leg is sent.
    expect(await w.execute()).toBe('paid');
    expect(w.store.legs.map((leg) => leg.status)).toEqual(['settled', 'settled']);
    expect(w.count('invoke:execute')).toBe(1);
  });
});
