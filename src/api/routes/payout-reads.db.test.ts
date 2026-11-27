// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The payout read routes end to end: the /v1 app, the read service, the real
// database as the app role, and the Stellar adapter on the fake RPC for the
// budget the approvals queue shows. Two principals, the first with two
// projects, each seeded with a queued payout, one waiting for approval and
// one that failed and has its receipt, so every route is also run across
// tenants.

import { randomBytes, randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { FakeNetwork } from '../../../test/fake-network.js';
import {
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
  payoutMethods,
  payouts,
  projects,
  receipts,
  recipients,
  unwiredJobQueue,
  type Database,
  type ProjectContext,
} from '../../db/index.js';
import {
  createTestDatabase,
  databaseAsServiceRoles,
  type TestDatabase,
} from '../../db/testing/index.js';
import { tokenAmount } from '../../money/index.js';
import { createPayoutReadService, databasePayoutReads } from '../../payouts/payout-reads.js';
import { createV1App } from '../app.js';
import type { Authenticate, KeyCaller } from '../authenticate.js';
import { errorEnvelopeSchema } from '../errors.js';
import { payoutReadRoutes } from './payout-reads.js';

const adminUrl = inject('dbAdminUrl');
const roleUrls = inject('dbRoleUrls');

const FACTORY = 'CB4AYBA5NVQPVPNOWUCSZQK6ZIGOF7KSCS6SF6UV6D2OKPDXLHEPD4V7';
const ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
const TESTNET = 'stellar:testnet';
const AMOUNT = tokenAmount(25_000_000n, 'USDC', 'stellar');

interface Tenant {
  readonly context: ProjectContext;
  readonly mandateId: string;
  readonly recipientId: string;
  readonly destination: string;
  readonly queuedId: string;
  readonly waitingId: string;
  readonly failedId: string;
  readonly receiptId: string;
}

let database: TestDatabase;
let db: Database;
let rpc: FakeMandateRpc;
let adapter: StellarChainAdapter;

// A on the mandate the fake RPC serves; A's second project and B on
// contracts it does not, so their budgets cannot be read.
let a: Tenant;
let aSecond: Tenant;
let b: Tenant;

const hex = (): string => randomBytes(32).toString('hex');
const wallet = (): string => testSigner(`payout-reads-${randomUUID()}`).publicKey;

async function newPrincipal(name: string): Promise<ProjectContext> {
  const created = await db.unscoped((tx) =>
    entryPoints.createPrincipal(tx, { name, projectName: 'Main', ownerWallet: wallet() }),
  );
  return { principalId: created.principalId, projectId: created.projectId };
}

async function payout(
  context: ProjectContext,
  world: { mandateId: string; recipientId: string; methodId: string },
): Promise<string> {
  const created = await db.tenant(context).transaction((tx) =>
    payouts.create(
      tx,
      {
        idempotencyKey: `key-${randomUUID()}`,
        requestHash: hex(),
        mandateId: world.mandateId,
        recipientId: world.recipientId,
        taskId: `task-${randomUUID()}`,
        onchainPayoutId: hex(),
        amount: AMOUNT,
        metadata: { person: 'private-note' },
        legs: [{ payoutMethodId: world.methodId, amount: AMOUNT }],
      },
      unwiredJobQueue,
    ),
  );
  return created.payout.id;
}

async function seed(context: ProjectContext, contractAddress: string): Promise<Tenant> {
  const destination = wallet();
  const world = await db.tenant(context).transaction(async (tx) => {
    const key = await agentKeys.create(
      tx,
      {
        network: TESTNET,
        publicKey: wallet(),
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
        contractAddress,
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
      recipientRef: hex(),
    });
    const method = await payoutMethods.addWallet(
      tx,
      {
        recipientId: recipient.id,
        destination,
        destinationCheck: { receivable: true },
        verified: true,
      },
      adapter,
    );
    return { mandateId: mandate.id, recipientId: recipient.id, methodId: method.id };
  });
  const queuedId = await payout(context, world);
  const waitingId = await payout(context, world);
  const failedId = await payout(context, world);
  const receiptId = await db.withTenant('worker', { ...context, scope: 'project' }, async (tx) => {
    await payouts.transition(tx, waitingId, { from: 'queued', to: 'submitting' });
    await payouts.transition(tx, waitingId, {
      from: 'submitting',
      to: 'pending_approval',
      requestTxHash: hex(),
    });
    await payouts.transition(tx, failedId, { from: 'queued', to: 'failed' });
    return (await receipts.issue(tx, failedId, null)).receipt.id;
  });
  return {
    context,
    mandateId: world.mandateId,
    recipientId: world.recipientId,
    destination,
    queuedId,
    waitingId,
    failedId,
    receiptId,
  };
}

function routesFor(context: ProjectContext) {
  const caller: KeyCaller = {
    kind: 'key',
    ...context,
    tokenId: randomUUID(),
    scopes: ['payouts:read'],
  };
  // Every route here answers this one caller, whatever access it asks for;
  // which access each asks for is pinned in payout-reads.test.ts.
  const authenticate = (() => () => Promise.resolve(caller)) as unknown as Authenticate;
  const service = createPayoutReadService({ store: databasePayoutReads(db), chain: adapter });
  return payoutReadRoutes({ service, authenticate });
}

function appFor(context: ProjectContext) {
  const { app } = createV1App({ routes: routesFor(context) });
  return async (path: string) => {
    const response = await app.request(path);
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
}

interface Item {
  readonly id: string;
  readonly status: string;
  readonly receiptId: string | null;
  readonly legs: readonly { readonly destination: string }[];
  readonly budgetLeft?: unknown;
}

function itemsOf(body: Record<string, unknown>): Item[] {
  return (body as { items: Item[] }).items;
}

beforeAll(async () => {
  database = await createTestDatabase(adminUrl, import.meta.url);
  db = databaseAsServiceRoles(roleUrls, database);
  rpc = new FakeMandateRpc();
  adapter = new StellarChainAdapter({
    gateway: rpc,
    chain: new FakeNetwork(),
    factory: FACTORY,
    asset: { code: 'USDC', issuer: ISSUER, contract: ASSET },
  });
  const first = await newPrincipal('Alpha');
  const second = {
    principalId: first.principalId,
    projectId: await db.tenant(first).transaction((tx) => projects.create(tx, { name: 'Two' })),
  };
  a = await seed(first, MANDATE);
  aSecond = await seed(second, FACTORY);
  b = await seed(await newPrincipal('Bravo'), ASSET);
});

afterAll(async () => {
  await db.close();
  await database.drop();
});

describe('GET /v1/payouts', () => {
  it("lists the project's payouts newest first, masked, without metadata", async () => {
    const answer = await appFor(a.context)('/v1/payouts');
    expect(answer.status).toBe(200);
    expect(itemsOf(answer.body).map((item) => item.id)).toEqual([
      a.failedId,
      a.waitingId,
      a.queuedId,
    ]);
    const text = JSON.stringify(answer.body);
    expect(text).not.toContain(a.destination);
    expect(text).toContain(`${a.destination.slice(0, 4)}...${a.destination.slice(-4)}`);
    expect(text).not.toContain('private-note');
  });

  it('combines a status list with the mandate and recipient filters', async () => {
    const send = appFor(a.context);
    const both = await send(
      `/v1/payouts?status=pending_approval,failed&mandateId=${a.mandateId}&recipientId=${a.recipientId}`,
    );
    expect(itemsOf(both.body).map((item) => item.id)).toEqual([a.failedId, a.waitingId]);
    const none = await send('/v1/payouts?status=paid');
    expect(none.body).toEqual({ items: [], nextCursor: null });
    const future = await send(
      `/v1/payouts?createdFrom=${new Date(Date.now() + 60_000).toISOString()}`,
    );
    expect(future.body).toEqual({ items: [], nextCursor: null });
  });

  it('pages one at a time through every payout, once each', async () => {
    const send = appFor(a.context);
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const query: string = cursor === null ? 'limit=1' : `limit=1&cursor=${cursor}`;
      const page = await send(`/v1/payouts?${query}`);
      expect(page.status).toBe(200);
      seen.push(...itemsOf(page.body).map((item) => item.id));
      cursor = (page.body as { nextCursor: string | null }).nextCursor;
    } while (cursor !== null);
    expect(seen).toEqual([a.failedId, a.waitingId, a.queuedId]);
  });
});

describe('GET /v1/payouts/{id}', () => {
  it('shows a finished payout with its receipt and its timeline', async () => {
    const answer = await appFor(a.context)(`/v1/payouts/${a.failedId}`);
    expect(answer.status).toBe(200);
    const detail = (
      answer.body as {
        payout: Item & { timeline: { event: string }[]; mandate: { id: string } };
      }
    ).payout;
    expect(detail.receiptId).toBe(a.receiptId);
    expect(detail.mandate.id).toBe(a.mandateId);
    expect(detail.timeline.map((entry) => entry.event)).toEqual(['created', 'failed']);
    expect(JSON.stringify(answer.body)).not.toContain(a.destination);
  });
});

describe('GET /v1/approvals', () => {
  it('lists only the waiting payout, with what the budget on chain has left', async () => {
    rpc.spent = 20n * UNIT;
    rpc.committed = 30n * UNIT;
    const answer = await appFor(a.context)('/v1/approvals');
    expect(answer.status).toBe(200);
    const items = itemsOf(answer.body);
    expect(items.map((item) => [item.id, item.status])).toEqual([
      [a.waitingId, 'pending_approval'],
    ]);
    expect(items[0]?.budgetLeft).toEqual({
      amount: (rpc.limits.totalBudget - 50n * UNIT).toString(),
      asset: 'USDC',
      network: TESTNET,
      scale: 7,
    });
  });

  it('still answers, with no budget, for a mandate the chain cannot read', async () => {
    const answer = await appFor(aSecond.context)('/v1/approvals');
    expect(answer.status).toBe(200);
    const items = itemsOf(answer.body);
    expect(items.map((item) => item.id)).toEqual([aSecond.waitingId]);
    expect(items[0]?.budgetLeft).toBeNull();
  });
});

// Every route as tenant A against the rows of A's other project and of
// another principal. None of them may find or list anything there.
describe('across tenants', () => {
  const foreign = (): readonly Tenant[] => [aSecond, b];

  const cases: Record<string, () => Promise<void>> = {
    listPayouts: async () => {
      const send = appFor(a.context);
      const all = JSON.stringify((await send('/v1/payouts?limit=100')).body);
      for (const other of foreign()) {
        for (const id of [other.queuedId, other.waitingId, other.failedId]) {
          expect(all).not.toContain(id);
        }
        const named = await send(
          `/v1/payouts?mandateId=${other.mandateId}&recipientId=${other.recipientId}`,
        );
        expect(named.status).toBe(200);
        expect(named.body).toEqual({ items: [], nextCursor: null });
      }
    },
    getPayout: async () => {
      for (const other of foreign()) {
        for (const id of [other.queuedId, other.waitingId, other.failedId]) {
          const answer = await appFor(a.context)(`/v1/payouts/${id}`);
          expect(answer.status).toBe(404);
          expect(errorEnvelopeSchema.parse(answer.body).error.code).toBe('NOT_FOUND');
        }
      }
    },
    listApprovals: async () => {
      const answer = await appFor(a.context)('/v1/approvals?limit=100');
      const ids = itemsOf(answer.body).map((item) => item.id);
      expect(ids).toEqual([a.waitingId]);
      for (const other of foreign()) expect(ids).not.toContain(other.waitingId);
    },
  };

  it('has a case for every payout read route', () => {
    expect(
      routesFor(a.context)
        .map((route) => route.operationId)
        .sort(),
    ).toEqual(Object.keys(cases).sort());
  });

  it.each(Object.keys(cases))('%s cannot reach another tenant', async (name) => {
    const run = cases[name];
    if (run === undefined) throw new Error(`no case named ${name}`);
    await run();
  });
});
