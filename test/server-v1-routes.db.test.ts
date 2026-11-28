// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The /v1 routes exactly as the web role composes them, on a test database
// logged in as the app and the Stellar adapter on the fake RPC: a person signs
// in with a wallet, adds a recipient with the session, makes an API key, and a
// platform adds another recipient with that key. Another principal's key sees
// none of it.

import { randomBytes, randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { createV1App } from '../src/api/app.js';
import { StellarChainAdapter } from '../src/chain/stellar/adapter.js';
import { StellarAgentAccounts } from '../src/chain/stellar/agent-accounts.js';
import { TESTNET_USDC_ISSUER } from '../src/chain/stellar/testnet.js';
import {
  agentKeys,
  entryPoints,
  mandates,
  type Database,
  type ProjectContext,
} from '../src/db/index.js';
import {
  createTestDatabase,
  databaseAsServiceRoles,
  testContract,
  type TestDatabase,
} from '../src/db/testing/index.js';
import type { AgentKeyService } from '../src/keys/agent-keys.js';
import { createSealer } from '../src/keys/sealer.js';
import { RECIPIENT_DESTINATION_ASSET, v1Routes } from '../src/server/v1-routes.js';
import { codeOf, requestFor, type Request } from './api-key-helpers.js';
import { FakeNetwork } from './fake-network.js';
import { ASSET, FakeMandateRpc, MANDATE, principal } from './fake-rpc.js';
import { clientFor, ORIGIN, signInWith, wallet, type Call } from './sign-in-helpers.js';

const adminUrl = inject('dbAdminUrl');
const roleUrls = inject('dbRoleUrls');

const FACTORY = 'CB4AYBA5NVQPVPNOWUCSZQK6ZIGOF7KSCS6SF6UV6D2OKPDXLHEPD4V7';
const TESTNET = 'stellar:testnet';

let database: TestDatabase;
let db: Database;
let network: FakeNetwork;
let adapter: StellarChainAdapter;
let request: Request;
let call: Call;
let keyService: AgentKeyService;
const lines: string[] = [];
const kek = randomBytes(32).toString('base64');

beforeAll(async () => {
  database = await createTestDatabase(adminUrl, import.meta.url);
  db = databaseAsServiceRoles(roleUrls, database);
  network = new FakeNetwork();
  adapter = new StellarChainAdapter({
    gateway: new FakeMandateRpc(),
    chain: network,
    factory: FACTORY,
    asset: { code: 'USDC', issuer: TESTNET_USDC_ISSUER, contract: ASSET },
  });
  const composed = v1Routes({
    db,
    adapter,
    origin: ORIGIN,
    network: 'testnet',
    log: (line) => lines.push(line),
    sealer: createSealer(kek),
    // Friendbot always obliges here; funding failures are the key module's tests.
    agentAccounts: new StellarAgentAccounts({
      network: TESTNET,
      chain: {
        friendbot: () => Promise.resolve(),
        accountFacts: () => Promise.resolve({ exists: true, trustlines: [], memoRequired: false }),
      },
    }),
  });
  keyService = composed.agentKeys;
  const { app } = createV1App({ routes: composed.routes, log: (line) => lines.push(line) });
  request = requestFor(app);
  call = clientFor(app);
});

afterAll(async () => {
  await db.close();
  await database.drop();
});

interface Owner extends ProjectContext {
  readonly cookie: string;
  readonly mandateId: string;
}

/** A wallet the fake network says can take testnet USDC. */
function receivable(): string {
  const address = wallet().publicKey();
  network.facts.set(address, {
    exists: true,
    trustlines: [RECIPIENT_DESTINATION_ASSET],
    memoRequired: false,
  });
  return address;
}

/**
 * A principal whose owner is signed in, with a mandate. The fake RPC serves
 * only MANDATE, and a contract belongs to one mandate, so the default is for
 * the one owner in a database whose mandate goes on chain; any other owner
 * takes a contract of its own.
 */
async function owner(contractAddress: string = MANDATE): Promise<Owner> {
  const kp = wallet();
  const made = await db.unscoped((tx) =>
    entryPoints.createPrincipal(tx, {
      name: 'Acme',
      projectName: 'Main',
      ownerWallet: kp.publicKey(),
    }),
  );
  const context = { principalId: made.principalId, projectId: made.projectId };
  const mandateId = await db.tenant(context).transaction(async (tx) => {
    const key = await agentKeys.create(
      tx,
      {
        network: TESTNET,
        publicKey: wallet().publicKey(),
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
    return mandate.id;
  });
  const { token } = await signInWith(call, kp, { client: `client-${randomUUID()}` });
  if (token === undefined) throw new Error('sign in failed');
  return { ...context, cookie: token, mandateId };
}

async function keyFor(o: Owner, scopes: readonly string[]): Promise<string> {
  const created = await request('POST', '/v1/api-keys', {
    cookie: o.cookie,
    project: o.projectId,
    body: { name: 'Platform', scopes },
  });
  expect(created.status).toBe(201);
  return String(created.json?.['secret']);
}

describe('recipients as the web role serves them', () => {
  it('uses the testnet USDC asset the adapter pays', () => {
    expect(RECIPIENT_DESTINATION_ASSET).toBe(`USDC:${TESTNET_USDC_ISSUER}`);
  });

  it('creates a recipient with a session, then another with an API key', async () => {
    const alice = await owner();
    const bySession = await request('POST', '/v1/recipients', {
      cookie: alice.cookie,
      project: alice.projectId,
      body: { mandateId: alice.mandateId, label: 'Ada', address: receivable() },
    });
    expect(bySession.status).toBe(201);
    expect(bySession.json?.['recipient']).toMatchObject({ status: 'active', payable: true });
    expect(bySession.json?.['signingRequest']).toMatchObject({
      action: 'allow_recipients',
      signer: principal.publicKey,
    });

    const key = await keyFor(alice, ['recipients:read', 'recipients:write']);
    const byKey = await request('POST', '/v1/recipients', {
      key,
      body: {
        mandateId: alice.mandateId,
        label: 'Grace',
        address: receivable(),
        email: 'grace@example.com',
      },
    });
    expect(byKey.status).toBe(201);
    const id = (byKey.json?.['recipient'] as { id: string }).id;

    // The email was sealed under the key encryption key and opens again.
    const detail = await request('GET', `/v1/recipients/${id}`, { key });
    expect(detail.json?.['recipient']).toMatchObject({
      label: 'Grace',
      email: 'grace@example.com',
    });
    const listed = await request('GET', '/v1/recipients', { key });
    expect((listed.json?.['items'] as { label: string }[]).map((r) => r.label).sort()).toEqual([
      'Ada',
      'Grace',
    ]);
  });

  it('answers FORBIDDEN to a key that may only read, and NOT_FOUND across principals', async () => {
    // Nothing here reaches the chain: the refused request stops at its scope,
    // and a recipient without an address needs no allowlist call.
    const alice = await owner(testContract());
    const bob = await owner(testContract());
    const reader = await keyFor(alice, ['recipients:read']);
    const refused = await request('POST', '/v1/recipients', {
      key: reader,
      body: { mandateId: alice.mandateId, label: 'Nope', address: receivable() },
    });
    expect(refused.status).toBe(403);
    expect(codeOf(refused)).toBe('FORBIDDEN');

    const made = await request('POST', '/v1/recipients', {
      cookie: alice.cookie,
      project: alice.projectId,
      body: { mandateId: alice.mandateId, label: 'Linus' },
    });
    expect(made.status).toBe(201);
    const id = (made.json?.['recipient'] as { id: string }).id;
    const bobsKey = await keyFor(bob, ['recipients:read', 'recipients:write']);
    const across = await request('GET', `/v1/recipients/${id}`, { key: bobsKey });
    expect(across.status).toBe(404);
    // Bob's key cannot add to Alice's mandate either.
    const onAlices = await request('POST', '/v1/recipients', {
      key: bobsKey,
      body: { mandateId: alice.mandateId, label: 'Mallory' },
    });
    expect(onAlices.status).toBe(404);
  });

  it('gives a principal made through the routes a funded agent key for its first project', async () => {
    const kp = wallet();
    const { token } = await signInWith(call, kp, { client: `client-${randomUUID()}` });
    if (token === undefined) throw new Error('sign in failed');
    const made = await request('POST', '/v1/principals', {
      cookie: token,
      body: { name: 'Keyed' },
    });
    expect(made.status).toBe(201);
    const project = made.json?.['project'] as { id: string; principalId: string };
    const context = { principalId: project.principalId, projectId: project.id };
    const key = await keyService.active(context);
    expect(key?.network).toBe(TESTNET);
    expect(key?.funding.status).toBe('funded');
    expect((await keyService.activeSigner(context)).publicKey).toBe(key?.publicKey);

    const second = await request('POST', '/v1/projects', {
      cookie: token,
      body: { principalId: context.principalId, name: 'Second' },
    });
    expect(second.status).toBe(201);
    const next = second.json?.['project'] as { id: string };
    const other = await keyService.active({ principalId: context.principalId, projectId: next.id });
    expect(other?.publicKey).toBeDefined();
    expect(other?.publicKey).not.toBe(key?.publicKey);
    await expect(keyService.signer(context, other?.id ?? randomUUID())).rejects.toMatchObject({
      code: 'KEY_NOT_FOUND',
    });
  });

  it('serves the mandate routes and the signed submit only when it knows the UJIRA executor', () => {
    const paths = (executor?: string) =>
      v1Routes({
        db,
        adapter,
        origin: ORIGIN,
        network: 'testnet',
        ...(executor === undefined ? {} : { executor }),
        log: () => undefined,
        sealer: createSealer(kek),
        agentAccounts: new StellarAgentAccounts({
          network: TESTNET,
          chain: {
            friendbot: () => Promise.resolve(),
            accountFacts: () =>
              Promise.resolve({ exists: true, trustlines: [], memoRequired: false }),
          },
        }),
      }).routes.map((r) => `${r.method} ${r.path}`);
    const mandateRoutes = [
      'post /v1/mandates/prepare',
      'post /v1/mandates/import',
      'get /v1/mandates',
      'get /v1/mandates/{id}',
      'post /v1/mandates/{id}/actions',
      'post /v1/signing/submit',
    ];
    expect(paths(wallet().publicKey())).toEqual(expect.arrayContaining(mandateRoutes));
    expect(paths().filter((p) => mandateRoutes.includes(p))).toEqual([]);
  });

  it('never logs the key encryption key, an API key or an email', () => {
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).not.toContain(kek);
      expect(line).not.toMatch(/ujk_/);
      expect(line).not.toContain('grace@example.com');
    }
  });
});

describe('payout reads as the web role serves them', () => {
  // Nothing here reaches the chain, so each owner takes a contract of its own.
  it('serves the list and the detail to a session and a key holding payouts:read', async () => {
    const alice = await owner(testContract());
    const bySession = await request('GET', '/v1/payouts', {
      cookie: alice.cookie,
      project: alice.projectId,
    });
    expect(bySession.status).toBe(200);
    expect(bySession.json).toEqual({ items: [], nextCursor: null });

    const reader = await keyFor(alice, ['payouts:read']);
    const byKey = await request('GET', '/v1/payouts?status=queued,paid', { key: reader });
    expect(byKey.status).toBe(200);
    const missing = await request('GET', `/v1/payouts/${randomUUID()}`, { key: reader });
    expect(missing.status).toBe(404);

    const other = await keyFor(alice, ['recipients:read']);
    const refused = await request('GET', '/v1/payouts', { key: other });
    expect(refused.status).toBe(403);
    expect(codeOf(refused)).toBe('FORBIDDEN');
  });

  it('serves the approvals queue to a session only', async () => {
    const alice = await owner(testContract());
    const bySession = await request('GET', '/v1/approvals', {
      cookie: alice.cookie,
      project: alice.projectId,
    });
    expect(bySession.status).toBe(200);
    expect(bySession.json).toEqual({ items: [], nextCursor: null });
    const key = await keyFor(alice, ['payouts:read']);
    const byKey = await request('GET', '/v1/approvals', { key });
    expect(byKey.status).toBe(403);
    expect(codeOf(byKey)).toBe('FORBIDDEN');
  });
});
