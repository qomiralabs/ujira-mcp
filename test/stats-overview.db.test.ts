// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// GET /v1/stats/overview exactly as the web role composes it, on a test
// database logged in as the service roles and the Stellar adapter on the fake
// RPC. Alice's organisation has two projects and Bob has his own, each with
// seeded payouts, so every figure is checked against rows that must stay out
// of it: the other project, the other principal, and a period with nothing in
// it.

import { randomBytes, randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { createV1App } from '../src/api/app.js';
import { callOptions } from '../src/chain/adapter.js';
import { StellarChainAdapter } from '../src/chain/stellar/adapter.js';
import { StellarAgentAccounts } from '../src/chain/stellar/agent-accounts.js';
import { TESTNET_USDC_ISSUER } from '../src/chain/stellar/testnet.js';
import {
  agentKeys,
  entryPoints,
  mandates,
  payoutMethods,
  payouts,
  principals,
  recipients,
  unwiredJobQueue,
  type Database,
  type Payout,
  type ProjectContext,
} from '../src/db/index.js';
import {
  createTestDatabase,
  databaseAsServiceRoles,
  type TestDatabase,
} from '../src/db/testing/index.js';
import { createSealer } from '../src/keys/sealer.js';
import { tokenAmount } from '../src/money/index.js';
import { wallClock } from '../src/payouts/overview-period.js';
import { v1Routes } from '../src/server/v1-routes.js';
import { codeOf, requestFor, type Request } from './api-key-helpers.js';
import { FakeNetwork } from './fake-network.js';
import { ASSET, FakeMandateRpc, MANDATE, principal } from './fake-rpc.js';
import { clientFor, ORIGIN, signInWith, wallet, type Call } from './sign-in-helpers.js';

const adminUrl = inject('dbAdminUrl');
const roleUrls = inject('dbRoleUrls');

const FACTORY = 'CB4AYBA5NVQPVPNOWUCSZQK6ZIGOF7KSCS6SF6UV6D2OKPDXLHEPD4V7';
const TESTNET = 'stellar:testnet';
const DAY = 86_400_000;

const usdcWire = (amount: string) => ({ amount, asset: 'USDC', network: TESTNET, scale: 7 });

let database: TestDatabase;
let db: Database;
let adapter: StellarChainAdapter;
let request: Request;
let call: Call;
const lines: string[] = [];

interface Person {
  readonly cookie: string;
  readonly main: ProjectContext;
}

interface World {
  readonly context: ProjectContext;
  readonly mandateId: string;
  readonly recipientId: string;
  readonly methodId: string;
}

let alice: Person;
let aliceGrants: ProjectContext;
let bob: Person;

async function signedIn(name: string): Promise<Person> {
  const kp = wallet();
  const made = await db.unscoped((tx) =>
    entryPoints.createPrincipal(tx, { name, projectName: 'Main', ownerWallet: kp.publicKey() }),
  );
  const { token } = await signInWith(call, kp, { client: `client-${randomUUID()}` });
  if (token === undefined) throw new Error('sign in failed');
  return { cookie: token, main: { principalId: made.principalId, projectId: made.projectId } };
}

/** A mandate at the contract, with one recipient who has a wallet. */
async function world(context: ProjectContext, name: string, contract: string): Promise<World> {
  return db.tenant(context).transaction(async (tx) => {
    const key =
      (await agentKeys.active(tx, TESTNET)) ??
      (await agentKeys.create(
        tx,
        {
          network: TESTNET,
          publicKey: wallet().publicKey(),
          secretCiphertext: Buffer.alloc(48, 1),
          secretNonce: Buffer.alloc(12, 2),
        },
        adapter,
      ));
    const mandate = await mandates.create(
      tx,
      {
        name,
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
      recipientRef: randomBytes(32).toString('hex'),
    });
    const method = await payoutMethods.addWallet(
      tx,
      {
        recipientId: recipient.id,
        destination: wallet().publicKey(),
        destinationCheck: { receivable: true },
        verified: true,
      },
      adapter,
    );
    return { context, mandateId: mandate.id, recipientId: recipient.id, methodId: method.id };
  });
}

const PATHS: Readonly<Record<'paid' | 'pending_approval', readonly Payout['status'][]>> = {
  paid: ['submitting', 'approved', 'settling', 'paid'],
  pending_approval: ['submitting', 'pending_approval'],
};

async function payout(
  w: World,
  minor: bigint,
  outcome: 'paid' | 'pending_approval' | { blockedBy: string },
): Promise<void> {
  const amount = tokenAmount(minor, 'USDC', 'stellar');
  const { payout: made } = await db.tenant(w.context).transaction(async (tx) =>
    payouts.create(
      tx,
      {
        idempotencyKey: `key-${randomUUID()}`,
        requestHash: randomBytes(32).toString('hex'),
        mandateId: w.mandateId,
        recipientId: w.recipientId,
        taskId: `task-${randomUUID()}`,
        onchainPayoutId: randomBytes(32).toString('hex'),
        amount,
        legs: [{ payoutMethodId: w.methodId, amount }],
        ...(typeof outcome === 'object' ? { blockedBy: outcome.blockedBy } : {}),
      },
      unwiredJobQueue,
    ),
  );
  if (typeof outcome === 'object') return;
  let from = made.status;
  for (const to of PATHS[outcome]) {
    const moved = await db.withTenant('worker', { ...w.context, scope: 'project' }, (tx) =>
      payouts.transition(tx, made.id, { from, to }),
    );
    if (moved === undefined) throw new Error(`the seeded payout did not move to ${to}`);
    from = moved.status;
  }
}

function overview(person: Person, project: string, query = '') {
  return request('GET', `/v1/stats/overview${query}`, { cookie: person.cookie, project });
}

beforeAll(async () => {
  database = await createTestDatabase(adminUrl, import.meta.url);
  db = databaseAsServiceRoles(roleUrls, database);
  adapter = new StellarChainAdapter({
    gateway: new FakeMandateRpc(),
    chain: new FakeNetwork(),
    factory: FACTORY,
    asset: { code: 'USDC', issuer: TESTNET_USDC_ISSUER, contract: ASSET },
  });
  const composed = v1Routes({
    db,
    adapter,
    origin: ORIGIN,
    network: 'testnet',
    log: (line) => lines.push(line),
    sealer: createSealer(randomBytes(32).toString('base64')),
    agentAccounts: new StellarAgentAccounts({
      network: TESTNET,
      chain: {
        friendbot: () => Promise.resolve(),
        accountFacts: () => Promise.resolve({ exists: true, trustlines: [], memoRequired: false }),
      },
    }),
  });
  const { app } = createV1App({ routes: composed.routes, log: (line) => lines.push(line) });
  request = requestFor(app);
  call = clientFor(app);

  alice = await signedIn('Acme');
  bob = await signedIn('Globex');
  const added = await request('POST', '/v1/projects', {
    cookie: alice.cookie,
    body: { principalId: alice.main.principalId, name: 'Grants' },
  });
  expect(added.status).toBe(201);
  aliceGrants = {
    principalId: alice.main.principalId,
    projectId: (added.json?.['project'] as { id: string }).id,
  };
  await db
    .tenant(alice.main)
    .transaction((tx) =>
      principals.setReportingTimeZone(tx, alice.main.principalId, 'Africa/Lagos'),
    );

  // Alice's main project: two paid, one waiting, one blocked, on the mandate
  // the fake RPC serves, and a second mandate the chain does not know.
  const payroll = await world(alice.main, 'Payroll', MANDATE);
  await world(alice.main, 'Bonuses', FACTORY);
  await payout(payroll, 25_000_000n, 'paid');
  await payout(payroll, 100_000_000n, 'paid');
  await payout(payroll, 3_000_000n, 'pending_approval');
  await payout(payroll, 4_000_000n, { blockedBy: 'DAILY_CAP_EXCEEDED' });

  // Rows that would change every figure above if they leaked into it.
  const grants = await world(aliceGrants, 'Grants', ASSET);
  await payout(grants, 999_000_000n, 'paid');
  await payout(grants, 1_000_000n, 'pending_approval');
  const globex = await world(bob.main, 'Globex payroll', `C${'B'.repeat(55)}`);
  await payout(globex, 555_000_000n, 'paid');
  await payout(globex, 1_000_000n, { blockedBy: 'MANDATE_PAUSED' });
});

afterAll(async () => {
  await db.close();
  await database.drop();
});

describe('the overview as the web role serves it', () => {
  it("counts the project's payouts over the last 7 days of the principal's zone", async () => {
    const answer = await overview(alice, alice.main.projectId);
    expect(answer.status).toBe(200);
    const body = answer.json as {
      period: { from: string; to: string; timeZone: string };
      mandates: { name: string }[];
    };
    expect(body.period.timeZone).toBe('Africa/Lagos');
    const to = Date.parse(body.period.to);
    // Lagos keeps one offset all year, so its week is exactly seven days.
    expect(to - Date.parse(body.period.from)).toBe(7 * DAY);
    expect(wallClock('Africa/Lagos', to) % DAY).toBe(0);
    expect(to).toBeGreaterThan(Date.now());
    expect(to - Date.now()).toBeLessThanOrEqual(DAY);

    const { state } = await adapter.readMandate(MANDATE, callOptions('test'));
    const sorted = [...body.mandates].sort((a, b) => a.name.localeCompare(b.name));
    expect({ ...body, mandates: sorted }).toEqual({
      period: body.period,
      paid: [usdcWire('125000000')],
      byStatus: { paid: 2, pending_approval: 1, blocked: 1 },
      blockedByRule: { DAILY_CAP_EXCEEDED: 1 },
      approvalsWaiting: 1,
      mandates: [
        { id: expect.any(String) as unknown, contractId: FACTORY, name: 'Bonuses', state: null },
        {
          id: expect.any(String) as unknown,
          contractId: MANDATE,
          name: 'Payroll',
          state: {
            balance: usdcWire(state.balance.toString()),
            committed: usdcWire(state.committed.toString()),
            free: usdcWire(state.free.toString()),
          },
        },
      ],
      moreMandates: false,
    });
    // The mandate the chain did not know is logged by id and code only.
    expect(lines.some((l) => l.startsWith('event=overview_mandate_unread'))).toBe(true);
    expect(lines.join('\n')).not.toContain(FACTORY);
  });

  it('counts nothing in a period with no payouts, but still the approvals waiting now', async () => {
    const answer = await overview(
      alice,
      alice.main.projectId,
      '?from=2020-01-01T00:00:00.000Z&to=2020-01-08T00:00:00.000Z',
    );
    expect(answer.status).toBe(200);
    expect(answer.json).toMatchObject({
      period: {
        from: '2020-01-01T00:00:00.000Z',
        to: '2020-01-08T00:00:00.000Z',
        timeZone: 'Africa/Lagos',
      },
      paid: [usdcWire('0')],
      byStatus: {},
      blockedByRule: {},
      approvalsWaiting: 1,
    });
  });

  it("keeps the principal's other project apart, under the same session", async () => {
    const answer = await overview(alice, aliceGrants.projectId);
    expect(answer.status).toBe(200);
    expect(answer.json).toMatchObject({
      paid: [usdcWire('999000000')],
      byStatus: { paid: 1, pending_approval: 1 },
      blockedByRule: {},
      approvalsWaiting: 1,
      mandates: [{ name: 'Grants', contractId: ASSET, state: null }],
    });
  });

  it("shows Bob only his own figures, and none of Alice's projects", async () => {
    const own = await overview(bob, bob.main.projectId);
    expect(own.json).toMatchObject({
      period: { timeZone: 'UTC' },
      paid: [usdcWire('555000000')],
      byStatus: { paid: 1, blocked: 1 },
      blockedByRule: { MANDATE_PAUSED: 1 },
      approvalsWaiting: 0,
    });
    for (const project of [alice.main.projectId, aliceGrants.projectId]) {
      const across = await overview(bob, project);
      expect(across.status).toBe(404);
      expect(codeOf(across)).toBe('NOT_FOUND');
    }
  });

  it('refuses an API key of the project, whatever it holds', async () => {
    const created = await request('POST', '/v1/api-keys', {
      cookie: alice.cookie,
      project: alice.main.projectId,
      body: { name: 'Platform', scopes: ['payouts:read', 'mandates:read'] },
    });
    expect(created.status).toBe(201);
    const byKey = await request('GET', '/v1/stats/overview', {
      key: String(created.json?.['secret']),
    });
    expect(byKey.status).toBe(403);
    expect(codeOf(byKey)).toBe('FORBIDDEN');
  });
});
