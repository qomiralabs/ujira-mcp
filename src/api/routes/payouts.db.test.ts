// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The payout routes end to end: the /v1 app, the payout service, the real
// database as the app role with the Graphile job queue, and the Stellar
// adapter on the fake RPC. Two principals, so every route is also run across
// tenants, and two pools for the races, as two server instances would be.

import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import { FakeNetwork } from '../../../test/fake-network.js';
import {
  agent,
  ASSET,
  FakeMandateRpc,
  MANDATE,
  principal,
  testSigner,
  UNIT,
} from '../../../test/fake-rpc.js';
import { StellarChainAdapter } from '../../chain/stellar/adapter.js';
import {
  agentKeys,
  entryPoints,
  mandates,
  payoutJobQueue,
  payoutMethods,
  payouts,
  recipients,
  type Database,
  type ProjectContext,
} from '../../db/index.js';
import {
  createTestDatabase,
  databaseAsServiceRoles,
  queueFixture,
  type QueueFixture,
  type TestDatabase,
} from '../../db/testing/index.js';
import { createPayoutService } from '../../payouts/payout-service.js';
import { databasePayoutStore } from '../../payouts/payout-store.js';
import { createV1App } from '../app.js';
import type { Authenticate, Caller } from '../authenticate.js';
import { errorEnvelopeSchema } from '../errors.js';
import { databaseIdempotencyStore } from '../idempotency-store.js';
import { payoutRoutes } from './payouts.js';

const adminUrl = inject('dbAdminUrl');
const roleUrls = inject('dbRoleUrls');

const FACTORY = 'CB4AYBA5NVQPVPNOWUCSZQK6ZIGOF7KSCS6SF6UV6D2OKPDXLHEPD4V7';
const ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
const USDC = `USDC:${ISSUER}`;
const TESTNET = 'stellar:testnet';
// The fake mandate's clock, so simulated deadlines are in its future.
const CHAIN_NOW = new Date(1_800_000_000_000);

interface World {
  readonly context: ProjectContext;
  readonly mandateId: string;
  readonly recipientId: string;
  readonly recipientRef: string;
  readonly destination: string;
}

let database: TestDatabase;
let queue: QueueFixture;
let db: Database;
let second: Database;
let rpc: FakeMandateRpc;
let network: FakeNetwork;
let adapter: StellarChainAdapter;
let a: World;
let b: World;

let seed = 0;
function wallet(): string {
  seed += 1;
  return testSigner(`payouts-db-${String(seed)}-${randomUUID()}`).publicKey;
}

async function worldFor(name: string, contract: string, onChain: boolean): Promise<World> {
  const created = await db.unscoped((tx) =>
    entryPoints.createPrincipal(tx, { name, projectName: 'Main', ownerWallet: wallet() }),
  );
  const context = { principalId: created.principalId, projectId: created.projectId };
  const destination = wallet();
  network.facts.set(destination, { exists: true, trustlines: [USDC], memoRequired: false });
  const recipientRef = randomUUID().replace(/-/g, '').repeat(2);
  const ids = await db.tenant(context).transaction(async (tx) => {
    const key = await agentKeys.create(
      tx,
      {
        network: TESTNET,
        // The fake mandate names this agent, so its simulation accepts the request.
        publicKey: onChain ? agent.publicKey : wallet(),
        secretCiphertext: Buffer.alloc(48, 1),
        secretNonce: Buffer.alloc(12, 2),
      },
      adapter,
    );
    const mandate = await mandates.create(
      tx,
      {
        name: 'Payroll',
        network: TESTNET,
        contractAddress: contract,
        asset: 'USDC',
        scale: 7,
        agent: { keyId: key.id },
        principalWallet: principal.publicKey,
      },
      adapter,
    );
    const recipient = await recipients.create(tx, {
      mandateId: mandate.id,
      label: 'Ada',
      recipientRef,
    });
    await payoutMethods.addWallet(
      tx,
      {
        recipientId: recipient.id,
        destination,
        destinationCheck: { receivable: true },
        verified: false,
      },
      adapter,
    );
    return { mandateId: mandate.id, recipientId: recipient.id };
  });
  return { context, ...ids, recipientRef, destination };
}

function appFor(context: ProjectContext, on: Database = db) {
  const authenticate = (() => () =>
    Promise.resolve<Caller>({
      kind: 'key',
      ...context,
      tokenId: randomUUID(),
      scopes: ['payouts:read', 'payouts:write'],
    })) as unknown as Authenticate;
  const service = createPayoutService({
    store: databasePayoutStore(on, payoutJobQueue),
    chain: adapter,
    destinationAsset: () => USDC,
    now: () => CHAIN_NOW,
  });
  const { app } = createV1App({
    routes: payoutRoutes({
      service,
      authenticate,
      idempotency: { store: databaseIdempotencyStore(on), log: () => undefined },
    }),
  });
  const send = async (path: string, body: unknown, key?: string) => {
    const response = await app.request(path, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(key === undefined ? {} : { 'idempotency-key': key }),
      },
      body: JSON.stringify(body),
    });
    return {
      status: response.status,
      replayed: response.headers.get('idempotent-replayed') === 'true',
      body: (await response.json()) as Record<string, unknown>,
    };
  };
  return {
    create: (body: unknown, key = `key-${randomUUID()}`) => send('/v1/payouts', body, key),
    quote: (body: unknown) => send('/v1/payouts/quote', body),
  };
}

function payoutBody(world: World, over: Record<string, unknown> = {}) {
  return {
    mandateId: world.mandateId,
    recipientId: world.recipientId,
    amount: { amount: (5n * UNIT).toString(), asset: 'USDC', network: TESTNET, scale: 7 },
    taskId: `task-${randomUUID()}`,
    ...over,
  };
}

function quoteBody(world: World) {
  const { mandateId, recipientId, amount } = payoutBody(world);
  return { mandateId, recipientId, amount };
}

function codeOf(body: Record<string, unknown>): string {
  return errorEnvelopeSchema.parse(body).error.code;
}

interface PayoutWire {
  readonly id: string;
  readonly status: string;
  readonly blockedBy: string | null;
}

// As the tenant sees them, newest first.
async function payoutsOf(
  world: World,
): Promise<{ id: string; status: string; blocked_by: string | null }[]> {
  const page = await db
    .tenant(world.context)
    .transaction((tx) => payouts.list(tx, {}, { limit: 100 }));
  return page.items.map((p) => ({ id: p.id, status: p.status, blocked_by: p.blockedBy }));
}

async function jobsOf(payoutId: string): Promise<string[]> {
  const rows = await queue.jobs();
  return rows
    .filter((row) => (row.payload as { payoutId?: unknown }).payoutId === payoutId)
    .map((row) => row.task);
}

function sentOnChain(): string[] {
  return rpc.calls.filter((call) => call.startsWith('invoke:'));
}

beforeAll(async () => {
  database = await createTestDatabase(adminUrl, import.meta.url);
  queue = await queueFixture(database);
  db = databaseAsServiceRoles(roleUrls, database, 4);
  second = databaseAsServiceRoles(roleUrls, database, 4);
  rpc = new FakeMandateRpc();
  network = new FakeNetwork();
  adapter = new StellarChainAdapter({
    gateway: rpc,
    chain: network,
    factory: FACTORY,
    asset: { code: 'USDC', issuer: ISSUER, contract: ASSET },
  });
  a = await worldFor('Alpha', MANDATE, true);
  b = await worldFor('Bravo', FACTORY, false);
});

beforeEach(() => {
  rpc.balance = 500n * UNIT;
  rpc.allow.clear();
  rpc.allowRecipient(a.recipientRef, a.destination);
  rpc.calls.length = 0;
});

afterAll(async () => {
  await db.close();
  await second.close();
  await queue.close();
  await database.drop();
});

describe('POST /v1/payouts', () => {
  it('writes a payout the mandate takes as queued, with its leg and its payout.advance job', async () => {
    const answer = await appFor(a.context).create(payoutBody(a, { metadata: { batch: 'w48' } }));
    expect(answer.status).toBe(202);
    const payout = answer.body['payout'] as PayoutWire & { legs: unknown[] };
    expect(payout).toMatchObject({ status: 'queued', blockedBy: null, receiptId: null });
    expect(payout.legs).toHaveLength(1);
    expect(await jobsOf(payout.id)).toEqual(['payout.advance']);
    // Simulated only; the worker requests it.
    expect(sentOnChain()).toEqual([]);
  });

  it('answers the same key and body twice with one payout, the second replayed', async () => {
    const app = appFor(a.context);
    const body = payoutBody(a);
    const first = await app.create(body, 'same-key-1');
    const again = await app.create(body, 'same-key-1');
    expect(again.status).toBe(202);
    expect(again.replayed).toBe(true);
    expect(again.body).toEqual(first.body);
    const id = (first.body['payout'] as PayoutWire).id;
    expect((await payoutsOf(a)).filter((p) => p.id === id)).toHaveLength(1);
    expect(await jobsOf(id)).toEqual(['payout.advance']);
  });

  it('answers 20 identical requests at once, on two instances, with one payout and one job', async () => {
    const body = payoutBody(a);
    const before = (await payoutsOf(a)).length;
    const answers = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        appFor(a.context, i % 2 === 0 ? db : second).create(body, 'burst-key'),
      ),
    );
    const accepted = answers.filter((x) => x.status === 202);
    const busy = answers.filter((x) => x.status === 409);
    expect(accepted.length + busy.length).toBe(20);
    expect(accepted.length).toBeGreaterThanOrEqual(1);
    for (const x of busy) expect(codeOf(x.body)).toBe('IDEMPOTENCY_IN_PROGRESS');
    expect(new Set(accepted.map((x) => (x.body['payout'] as PayoutWire).id)).size).toBe(1);
    const after = await payoutsOf(a);
    expect(after.length).toBe(before + 1);
    const id = (accepted[0]?.body['payout'] as PayoutWire).id;
    expect(await jobsOf(id)).toEqual(['payout.advance']);
  });

  it('answers 409 TASK_ID_REUSED for the same task on the mandate under another key', async () => {
    const app = appFor(a.context);
    const body = payoutBody(a);
    expect((await app.create(body, 'task-key-1')).status).toBe(202);
    const other = await app.create(body, 'task-key-2');
    expect(other.status).toBe(409);
    expect(codeOf(other.body)).toBe('TASK_ID_REUSED');
  });

  it.each([
    ['asset', { asset: 'EURC' }],
    ['network', { network: 'stellar:pubnet' }],
    ['scale', { scale: 6 }],
  ] as const)('answers 400 at body.amount.%s and writes nothing', async (field, over) => {
    const before = (await payoutsOf(a)).length;
    const body = payoutBody(a);
    const answer = await appFor(a.context).create({ ...body, amount: { ...body.amount, ...over } });
    expect(answer.status).toBe(400);
    expect(errorEnvelopeSchema.parse(answer.body).error.details).toEqual([
      { path: `body.amount.${field}`, issue: 'mismatch' },
    ]);
    expect((await payoutsOf(a)).length).toBe(before);
  });

  it('writes a recipient the mandate does not allow as blocked, with a receipt job', async () => {
    rpc.allow.clear();
    const answer = await appFor(a.context).create(payoutBody(a));
    expect(answer.status).toBe(202);
    const payout = answer.body['payout'] as PayoutWire & { legs: { status: string }[] };
    expect(payout).toMatchObject({ status: 'blocked', blockedBy: 'RECIPIENT_NOT_ALLOWED' });
    expect(payout.legs[0]?.status).toBe('cancelled');
    expect(await jobsOf(payout.id)).toEqual(['receipt.issue']);
    expect(sentOnChain()).toEqual([]);
  });

  it('writes a payout past the free balance as blocked with the spec error, sending nothing', async () => {
    rpc.balance = 1n * UNIT;
    const answer = await appFor(a.context).create(payoutBody(a));
    const payout = answer.body['payout'] as PayoutWire;
    expect(payout).toMatchObject({ status: 'blocked', blockedBy: 'INSUFFICIENT_FUNDS' });
    const stored = (await payoutsOf(a)).find((p) => p.id === payout.id);
    expect(stored).toMatchObject({ status: 'blocked', blocked_by: 'INSUFFICIENT_FUNDS' });
    expect(await jobsOf(payout.id)).toEqual(['receipt.issue']);
    expect(sentOnChain()).toEqual([]);
  });

  it("finds another tenant's mandate as not found and writes nothing for either", async () => {
    const beforeA = (await payoutsOf(a)).length;
    const beforeB = (await payoutsOf(b)).length;
    const answer = await appFor(b.context).create(payoutBody(a));
    expect(answer.status).toBe(404);
    expect(codeOf(answer.body)).toBe('NOT_FOUND');
    // B's own mandate with A's recipient is not found either.
    const mixed = await appFor(b.context).create(payoutBody(b, { recipientId: a.recipientId }));
    expect(mixed.status).toBe(404);
    expect((await payoutsOf(a)).length).toBe(beforeA);
    expect((await payoutsOf(b)).length).toBe(beforeB);
  });

  it("keeps one tenant's Idempotency-Key apart from another's", async () => {
    const shared = 'shared-key';
    const first = await appFor(a.context).create(payoutBody(a), shared);
    const other = await appFor(b.context).create(payoutBody(b), shared);
    expect(first.status).toBe(202);
    // B's agent is not on any fake mandate, so its payout is blocked, but it is B's own.
    expect(other.status).toBe(202);
    expect(other.replayed).toBe(false);
    expect((other.body['payout'] as PayoutWire).id).not.toBe(
      (first.body['payout'] as PayoutWire).id,
    );
  });
});

describe('POST /v1/payouts/quote', () => {
  it('answers allowed, approval_required and blocked, and writes nothing', async () => {
    const app = appFor(a.context);
    const before = (await payoutsOf(a)).length;
    const noTask = quoteBody(a);
    expect((await app.quote(noTask)).body).toMatchObject({
      quote: { decision: 'allowed', blockedBy: null },
    });
    const big = { ...noTask, amount: { ...noTask.amount, amount: (20n * UNIT).toString() } };
    expect((await app.quote(big)).body).toMatchObject({
      quote: { decision: 'approval_required', blockedBy: null },
    });
    rpc.balance = 1n;
    expect((await app.quote(noTask)).body).toMatchObject({
      quote: { decision: 'blocked', blockedBy: 'INSUFFICIENT_FUNDS' },
    });
    expect((await payoutsOf(a)).length).toBe(before);
    expect(sentOnChain()).toEqual([]);
  });

  it("finds another tenant's mandate as not found", async () => {
    const answer = await appFor(b.context).quote(quoteBody(a));
    expect(answer.status).toBe(404);
  });
});
