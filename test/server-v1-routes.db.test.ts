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
  type TestDatabase,
} from '../src/db/testing/index.js';
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
    env: { UJIRA_KEY_ENCRYPTION_KEY: kek },
    log: (line) => lines.push(line),
  });
  expect(composed.recipients).toBe('on');
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

/** A principal whose owner is signed in, with a mandate the fake RPC serves. */
async function owner(): Promise<Owner> {
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
        contractAddress: MANDATE,
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
    const alice = await owner();
    const bob = await owner();
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

  it('leaves the recipient routes out without a key encryption key, and serves the rest', () => {
    const offLines: string[] = [];
    const composed = v1Routes({
      db,
      adapter,
      origin: ORIGIN,
      network: 'testnet',
      env: {},
      log: (line) => offLines.push(line),
    });
    expect(composed.recipients).toBe('off');
    expect(composed.routes.some((r) => r.path.startsWith('/v1/recipients'))).toBe(false);
    expect(composed.routes.some((r) => r.path === '/v1/api-keys')).toBe(true);
    expect(offLines).toEqual(['event=recipients_off level=warn reason=key_encryption_key_missing']);
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
