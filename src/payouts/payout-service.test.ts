// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The payout service's rules on the real Stellar adapter, over the fake RPC
// and an in-memory store: what the chain is asked, what a refusal is written
// as, and what happens when the chain does not answer. The same service on a
// real database is in src/api/routes/payouts.db.test.ts.

import { randomUUID } from 'node:crypto';

import { beforeEach, describe, expect, it } from 'vitest';

import { FakeNetwork } from '../../test/fake-network.js';
import {
  agent,
  ASSET,
  FakeMandateRpc,
  MANDATE,
  principal,
  testSigner,
  UNIT,
} from '../../test/fake-rpc.js';
import { StellarChainAdapter } from '../chain/stellar/adapter.js';
import type {
  CreatedPayout,
  Mandate,
  NewPayout,
  PayoutMethod,
  ProjectContext,
  Recipient,
  StorableCheck,
} from '../db/index.js';
import { PayoutConflictError } from '../db/index.js';
import { payoutIdFor } from '../ids.js';
import type { TokenAmount } from '../money/index.js';
import {
  createPayoutService,
  decide,
  LOCAL_BLOCKS,
  payoutRequestHash,
  PayoutServiceError,
  type CreatePayoutInput,
  type PayoutStore,
  type PayoutTarget,
} from './payout-service.js';

const ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
const USDC = `USDC:${ISSUER}`;
const TESTNET = 'stellar:testnet';
// The fake mandate's clock, so simulated deadlines are in its future.
const CHAIN_NOW = new Date(1_800_000_000_000);
const CONTEXT: ProjectContext = { principalId: randomUUID(), projectId: randomUUID() };
const CREATED = new Date('2026-11-27T09:00:00.000Z');

class MemoryStore implements PayoutStore {
  mandate: Mandate | undefined;
  recipient: Recipient | undefined;
  method: PayoutMethod | null = null;
  readonly written: NewPayout[] = [];
  readonly checks: StorableCheck[] = [];
  targetReads = 0;

  target(context: ProjectContext, mandateId: string, recipientId: string): Promise<PayoutTarget> {
    this.targetReads += 1;
    const ours = context.projectId === CONTEXT.projectId;
    const mandate = ours && this.mandate?.id === mandateId ? this.mandate : undefined;
    const recipient =
      mandate !== undefined && this.recipient?.id === recipientId ? this.recipient : undefined;
    return Promise.resolve({ mandate, recipient, method: this.method });
  }

  hasTask(_context: ProjectContext, mandateId: string, taskId: string): Promise<boolean> {
    return Promise.resolve(
      this.written.some((p) => p.mandateId === mandateId && p.taskId === taskId),
    );
  }

  recordCheck(_context: ProjectContext, _methodId: string, check: StorableCheck): Promise<void> {
    this.checks.push(check);
    if (this.method !== null && check.receivable) {
      this.method = { ...this.method, destinationStatus: 'receivable' };
    }
    return Promise.resolve();
  }

  create(_context: ProjectContext, input: NewPayout): Promise<CreatedPayout> {
    const earlier = this.written.find(
      (p) => p.idempotencyKey === input.idempotencyKey || p.taskId === input.taskId,
    );
    if (earlier !== undefined) {
      if (earlier.idempotencyKey !== input.idempotencyKey) {
        return Promise.reject(new PayoutConflictError('TASK_ID_REUSED'));
      }
      if (earlier.requestHash !== input.requestHash) {
        return Promise.reject(new PayoutConflictError('IDEMPOTENCY_KEY_REUSED'));
      }
      return Promise.resolve(this.row(earlier, false));
    }
    this.written.push(input);
    return Promise.resolve(this.row(input, true));
  }

  private row(input: NewPayout, created: boolean): CreatedPayout {
    const zero: TokenAmount = { ...input.amount, amount: 0n };
    const id = randomUUID();
    return {
      created,
      payout: {
        id,
        projectId: CONTEXT.projectId,
        mandateId: input.mandateId,
        recipientId: input.recipientId,
        taskId: input.taskId,
        idempotencyKey: input.idempotencyKey,
        network: TESTNET,
        amount: input.amount,
        fee: zero,
        status: input.blockedBy === undefined ? 'queued' : 'blocked',
        blockedBy: input.blockedBy ?? null,
        onchainPayoutId: input.onchainPayoutId,
        requestTxHash: null,
        metadata: input.metadata ?? {},
        createdAt: CREATED,
        updatedAt: CREATED,
        settledAt: null,
      },
      legs: input.legs.map((leg, index) => ({
        id: randomUUID(),
        payoutId: id,
        index,
        payoutMethodId: leg.payoutMethodId,
        method: 'stellar_wallet',
        destination: this.method?.destination ?? '',
        amount: leg.amount,
        fee: zero,
        legKey: 'b'.repeat(64),
        txHash: null,
        status: input.blockedBy === undefined ? 'planned' : 'cancelled',
        createdAt: CREATED,
        updatedAt: CREATED,
      })),
    };
  }
}

let rpc: FakeMandateRpc;
let network: FakeNetwork;
let store: MemoryStore;
let logged: string[];
const destination = testSigner('payout-service-recipient').publicKey;
const recipientRef = 'c'.repeat(64);

function service(timeoutMs?: number) {
  const adapter = new StellarChainAdapter({
    gateway: rpc,
    chain: network,
    factory: 'CB4AYBA5NVQPVPNOWUCSZQK6ZIGOF7KSCS6SF6UV6D2OKPDXLHEPD4V7',
    asset: { code: 'USDC', issuer: ISSUER, contract: ASSET },
  });
  return createPayoutService({
    store,
    chain: adapter,
    destinationAsset: () => USDC,
    now: () => CHAIN_NOW,
    log: (line) => logged.push(line),
    ...(timeoutMs === undefined ? {} : { chainTimeoutMs: timeoutMs }),
  });
}

function usdc(minor: bigint) {
  return { amount: minor.toString(), asset: 'USDC', network: TESTNET, scale: 7 };
}

function createInput(over: Partial<CreatePayoutInput> = {}): CreatePayoutInput {
  return {
    mandateId: store.mandate?.id ?? '',
    recipientId: store.recipient?.id ?? '',
    amount: usdc(5n * UNIT),
    taskId: `task-${randomUUID()}`,
    idempotencyKey: `key-${randomUUID()}`,
    ...over,
  };
}

beforeEach(() => {
  rpc = new FakeMandateRpc();
  rpc.allowRecipient(recipientRef, destination);
  network = new FakeNetwork();
  network.facts.set(destination, { exists: true, trustlines: [USDC], memoRequired: false });
  logged = [];
  store = new MemoryStore();
  const mandateId = randomUUID();
  store.mandate = {
    id: mandateId,
    projectId: CONTEXT.projectId,
    name: 'Payroll',
    network: TESTNET,
    contractAddress: MANDATE,
    asset: 'USDC',
    scale: 7,
    agentKeyId: randomUUID(),
    agentAddress: agent.publicKey,
    principalWallet: principal.publicKey,
    createdTxHash: null,
    createdAt: CREATED,
  };
  store.recipient = {
    id: randomUUID(),
    projectId: CONTEXT.projectId,
    mandateId,
    label: 'Ada',
    recipientRef,
    status: 'active',
    createdAt: CREATED,
  };
  store.method = {
    id: randomUUID(),
    projectId: CONTEXT.projectId,
    recipientId: store.recipient.id,
    method: 'stellar_wallet',
    destination,
    verifiedAt: null,
    destinationStatus: 'receivable',
    checkedAt: CREATED,
    createdAt: CREATED,
  };
});

describe('decide', () => {
  it('blocks with the spec error, and asks for approval at the threshold', () => {
    expect(decide({ ok: false, specError: 'DAILY_CAP_EXCEEDED' }, 1n, 10n)).toEqual({
      decision: 'blocked',
      blockedBy: 'DAILY_CAP_EXCEEDED',
    });
    expect(decide({ ok: true }, 9n, 10n).decision).toBe('allowed');
    expect(decide({ ok: true }, 10n, 10n).decision).toBe('approval_required');
  });
});

describe('payoutRequestHash', () => {
  it('ignores metadata order and id case, and changes with anything that matters', () => {
    const base = createInput({ metadata: { a: '1', b: '2', c: '3' } });
    const same = payoutRequestHash({
      ...base,
      mandateId: base.mandateId.toUpperCase(),
      metadata: { c: '3', a: '1', b: '2' },
    });
    expect(same).toBe(payoutRequestHash(base));
    expect(payoutRequestHash({ ...base, amount: usdc(6n * UNIT) })).not.toBe(same);
    expect(payoutRequestHash({ ...base, taskId: 'other' })).not.toBe(same);
    expect(payoutRequestHash({ ...base, metadata: { a: '1' } })).not.toBe(same);
    expect(payoutRequestHash(base)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('quote', () => {
  it('allows a payout under the threshold and asks for approval at it', async () => {
    const allowed = await service().quote(CONTEXT, createInput(), 'req-1');
    expect(allowed).toMatchObject({ decision: 'allowed', blockedBy: null, network: TESTNET });
    expect(allowed.amount.amount).toBe(5n * UNIT);
    const big = await service().quote(CONTEXT, createInput({ amount: usdc(20n * UNIT) }), 'r');
    expect(big).toMatchObject({ decision: 'approval_required', blockedBy: null });
    expect(store.written).toHaveLength(0);
  });

  it('names the spec error the mandate refuses with', async () => {
    rpc.balance = 1n * UNIT;
    const low = await service().quote(CONTEXT, createInput(), 'r');
    expect(low).toMatchObject({ decision: 'blocked', blockedBy: 'INSUFFICIENT_FUNDS' });
    rpc.allow.clear();
    const off = await service().quote(CONTEXT, createInput(), 'r');
    expect(off).toMatchObject({ decision: 'blocked', blockedBy: 'RECIPIENT_NOT_ALLOWED' });
  });

  it('says when the chain already holds the task', async () => {
    const input = createInput();
    rpc.payouts.set(payoutIdFor(MANDATE, input.taskId), { tombstone: 3 });
    const answer = await service().quote(CONTEXT, input, 'r');
    expect(answer).toMatchObject({ decision: 'blocked', blockedBy: 'PAYOUT_ID_EXISTS' });
    // Without a task, a fresh id is simulated, so the earlier payout does not matter.
    const fresh = await service().quote(CONTEXT, { ...input, taskId: undefined }, 'r');
    expect(fresh.decision).toBe('allowed');
  });

  it('blocks a suspended recipient and one without a wallet before asking the chain', async () => {
    if (store.recipient === undefined) throw new Error('fixture');
    store.recipient = { ...store.recipient, status: 'suspended' };
    rpc.down = true;
    expect(await service().quote(CONTEXT, createInput(), 'r')).toMatchObject({
      decision: 'blocked',
      blockedBy: LOCAL_BLOCKS.recipientSuspended,
    });
    store.recipient = { ...store.recipient, status: 'active' };
    store.method = null;
    expect(await service().quote(CONTEXT, createInput(), 'r')).toMatchObject({
      decision: 'blocked',
      blockedBy: LOCAL_BLOCKS.noMethod,
    });
  });

  it('reads a wallet that could not receive again, and records what it finds', async () => {
    if (store.method === null) throw new Error('fixture');
    store.method = { ...store.method, destinationStatus: 'no_trustline' };
    network.facts.set(destination, { exists: true, trustlines: [], memoRequired: false });
    expect(await service().quote(CONTEXT, createInput(), 'r')).toMatchObject({
      blockedBy: LOCAL_BLOCKS.notReceivable,
    });
    network.facts.delete(destination);
    expect(await service().quote(CONTEXT, createInput(), 'r')).toMatchObject({
      blockedBy: LOCAL_BLOCKS.notReceivable,
    });
    network.facts.set(destination, { exists: true, trustlines: [USDC], memoRequired: true });
    expect(await service().quote(CONTEXT, createInput(), 'r')).toMatchObject({
      blockedBy: LOCAL_BLOCKS.notReceivable,
    });
    network.facts.set(destination, { exists: true, trustlines: [USDC], memoRequired: false });
    expect(await service().quote(CONTEXT, createInput(), 'r')).toMatchObject({
      decision: 'allowed',
    });
    // The memo answer is never stored; the others are.
    expect(LOCAL_BLOCKS.notReceivable).toBe('DESTINATION_NOT_RECEIVABLE');
    expect(store.checks).toEqual([
      { receivable: false, reason: 'NO_TRUSTLINE' },
      { receivable: false, reason: 'NO_ACCOUNT' },
      { receivable: true },
    ]);
  });

  it('answers CHAIN_UNAVAILABLE when the chain does not answer', async () => {
    rpc.down = true;
    await expect(service().quote(CONTEXT, createInput(), 'req-9')).rejects.toMatchObject({
      code: 'CHAIN_UNAVAILABLE',
    });
    expect(logged.join('\n')).toContain('event=payout_quote_chain_unavailable');
  });

  it('treats a destination check that times out as no answer', async () => {
    if (store.method === null) throw new Error('fixture');
    store.method = { ...store.method, destinationStatus: 'unchecked' };
    network.accountFacts = () => new Promise(() => undefined);
    await expect(service(5).quote(CONTEXT, createInput(), 'r')).rejects.toMatchObject({
      code: 'CHAIN_UNAVAILABLE',
    });
  });

  it.each([
    ['asset', { asset: 'EURC' }],
    ['network', { network: 'stellar:pubnet' }],
    ['scale', { scale: 6 }],
    ['amount', { amount: '9'.repeat(39) }],
  ] as const)('refuses an amount whose %s is not the mandate unit', async (field, over) => {
    const input = createInput();
    await expect(
      service().quote(CONTEXT, { ...input, amount: { ...input.amount, ...over } }, 'r'),
    ).rejects.toMatchObject({ code: 'AMOUNT_MISMATCH', field });
  });

  it.each([
    ['asset', { asset: 'EURC' }],
    ['network', { network: 'celo:alfajores' }],
    ['scale', { scale: 6 }],
  ] as const)(
    'refuses a %s the token table does not know, even when the mandate row says it',
    async (field, over) => {
      if (store.mandate === undefined) throw new Error('fixture');
      store.mandate = { ...store.mandate, ...over };
      const input = createInput();
      await expect(
        service().quote(CONTEXT, { ...input, amount: { ...input.amount, ...over } }, 'r'),
      ).rejects.toMatchObject({ code: 'AMOUNT_MISMATCH', field });
    },
  );

  it('passes on a chain error that is not an outage, from either check', async () => {
    if (store.method === null || store.mandate === undefined) throw new Error('fixture');
    const method = store.method;
    store.method = { ...method, destinationStatus: 'unchecked', destination: 'not-an-account' };
    await expect(service().quote(CONTEXT, createInput(), 'r')).rejects.toMatchObject({
      name: 'ChainError',
      code: 'INVALID_ADDRESS',
    });
    store.method = method;
    store.mandate = { ...store.mandate, contractAddress: 'not-a-contract' };
    await expect(service().create(CONTEXT, createInput(), 'r')).rejects.toMatchObject({
      name: 'ChainError',
    });
    expect(store.written).toHaveLength(0);
  });

  it('runs on the server clock and a silent log when none is given', async () => {
    rpc.now = BigInt(Math.floor(Date.now() / 1000));
    const adapter = new StellarChainAdapter({
      gateway: rpc,
      chain: network,
      factory: 'CB4AYBA5NVQPVPNOWUCSZQK6ZIGOF7KSCS6SF6UV6D2OKPDXLHEPD4V7',
      asset: { code: 'USDC', issuer: ISSUER, contract: ASSET },
    });
    const plain = createPayoutService({ store, chain: adapter, destinationAsset: () => USDC });
    expect((await plain.quote(CONTEXT, createInput(), 'r')).decision).toBe('allowed');
    expect((await plain.create(CONTEXT, createInput(), 'r')).payout.status).toBe('queued');
  });

  it('refuses a mandate on a network this adapter does not serve', async () => {
    if (store.mandate === undefined) throw new Error('fixture');
    store.mandate = { ...store.mandate, network: 'stellar:pubnet' };
    const input = createInput();
    await expect(
      service().quote(
        CONTEXT,
        { ...input, amount: { ...input.amount, network: 'stellar:pubnet' } },
        'r',
      ),
    ).rejects.toMatchObject({ code: 'MANDATE_NOT_SERVED' });
  });

  it('does not find a mandate or a recipient of another project or mandate', async () => {
    const other = { principalId: randomUUID(), projectId: randomUUID() };
    await expect(service().quote(other, createInput(), 'r')).rejects.toMatchObject({
      code: 'MANDATE_NOT_FOUND',
    });
    await expect(
      service().quote(CONTEXT, createInput({ recipientId: randomUUID() }), 'r'),
    ).rejects.toMatchObject({ code: 'RECIPIENT_NOT_FOUND' });
    if (store.recipient === undefined) throw new Error('fixture');
    store.recipient = { ...store.recipient, mandateId: randomUUID() };
    await expect(service().quote(CONTEXT, createInput(), 'r')).rejects.toBeInstanceOf(
      PayoutServiceError,
    );
  });
});

describe('create', () => {
  it('writes a payout the mandate takes as queued, with one leg to the wallet', async () => {
    const input = createInput({ metadata: { batch: 'week-48' } });
    const record = await service().create(CONTEXT, input, 'req-1');
    expect(record.created).toBe(true);
    expect(record.payout).toMatchObject({ status: 'queued', blockedBy: null });
    expect(record.principalId).toBe(CONTEXT.principalId);
    expect(record.recipient.label).toBe('Ada');
    const [written] = store.written;
    expect(written).toMatchObject({
      idempotencyKey: input.idempotencyKey,
      requestHash: payoutRequestHash(input),
      taskId: input.taskId,
      onchainPayoutId: payoutIdFor(MANDATE, input.taskId),
      metadata: { batch: 'week-48' },
    });
    expect(written?.blockedBy).toBeUndefined();
    expect(written?.legs).toHaveLength(1);
    expect(written?.legs[0]?.payoutMethodId).toBe(store.method?.id);
    expect(written?.legs[0]?.amount.amount).toBe(5n * UNIT);
    // Simulation only: nothing is requested on chain at creation.
    expect(rpc.calls.filter((c) => c.startsWith('invoke:'))).toEqual([]);
    expect(logged.join('\n')).toContain('event=payout_created');
  });

  it('writes a payout the mandate refuses as blocked with the spec error', async () => {
    rpc.allow.clear();
    const record = await service().create(CONTEXT, createInput(), 'r');
    expect(record.payout).toMatchObject({ status: 'blocked', blockedBy: 'RECIPIENT_NOT_ALLOWED' });
    rpc.allow.add(`${recipientRef}|${destination}`);
    rpc.balance = 1n;
    const poor = await service().create(CONTEXT, createInput(), 'r');
    expect(poor.payout).toMatchObject({ status: 'blocked', blockedBy: 'INSUFFICIENT_FUNDS' });
    expect(rpc.calls.filter((c) => c.startsWith('invoke:'))).toEqual([]);
  });

  it('writes a payout queued when the chain does not answer, for the worker to judge', async () => {
    rpc.down = true;
    const record = await service().create(CONTEXT, createInput(), 'r');
    expect(record.payout).toMatchObject({ status: 'queued', blockedBy: null });
    expect(logged.join('\n')).toContain('event=payout_quote_chain_unavailable');
  });

  it('does not block a task the chain already holds; the worker resumes it', async () => {
    const input = createInput();
    rpc.payouts.set(payoutIdFor(MANDATE, input.taskId), { tombstone: 3 });
    const record = await service().create(CONTEXT, input, 'r');
    expect(record.payout).toMatchObject({ status: 'queued', blockedBy: null });
  });

  it('refuses a recipient with no wallet, since a payout needs a leg', async () => {
    store.method = null;
    await expect(service().create(CONTEXT, createInput(), 'r')).rejects.toMatchObject({
      code: 'RECIPIENT_HAS_NO_METHOD',
    });
    expect(store.written).toHaveLength(0);
  });

  it('finds the first payout on a retry without asking the chain again', async () => {
    const input = createInput();
    await service().create(CONTEXT, input, 'r');
    const simulated = rpc.calls.length;
    rpc.down = true;
    const again = await service().create(CONTEXT, input, 'r');
    expect(again.created).toBe(false);
    expect(rpc.calls.length).toBe(simulated);
    expect(store.written).toHaveLength(1);
    expect(logged.join('\n')).toContain('event=payout_create_retried');
  });

  it('passes the conflicts of the unique keys on', async () => {
    const input = createInput();
    await service().create(CONTEXT, input, 'r');
    await expect(
      service().create(CONTEXT, { ...input, idempotencyKey: 'another' }, 'r'),
    ).rejects.toMatchObject({ code: 'TASK_ID_REUSED' });
    await expect(
      service().create(CONTEXT, { ...input, amount: usdc(6n * UNIT) }, 'r'),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
  });

  it('never logs the destination, the task or the metadata', async () => {
    const input = createInput({ metadata: { note: 'private-note' } });
    await service().create(CONTEXT, input, 'r');
    const text = logged.join('\n');
    expect(text).not.toContain(destination);
    expect(text).not.toContain(input.taskId);
    expect(text).not.toContain('private-note');
  });
});
