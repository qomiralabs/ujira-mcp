// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// /v1/mcp exactly as the web role composes it, over the MCP protocol, on a
// test database logged in as the app and the Stellar adapter on the fake RPC:
// a person signs in, adds a recipient and makes API keys, and an agent pays
// with the key. A retried tool call makes one payout row, a read only key can
// quote and read but not request, and another principal's key sees nothing.

import { randomBytes, randomUUID } from 'node:crypto';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { afterEach, beforeEach, describe, expect, inject, it } from 'vitest';

import { createV1App, type V1App } from '../src/api/app.js';
import { StellarChainAdapter } from '../src/chain/stellar/adapter.js';
import { StellarAgentAccounts } from '../src/chain/stellar/agent-accounts.js';
import { TESTNET_USDC_ISSUER } from '../src/chain/stellar/testnet.js';
import {
  agentKeys,
  entryPoints,
  mandates,
  payouts,
  receipts,
  type Database,
  type ProjectContext,
} from '../src/db/index.js';
import {
  createTestDatabase,
  databaseAsServiceRoles,
  testContract,
  type TestDatabase,
} from '../src/db/testing/index.js';
import { createSealer } from '../src/keys/sealer.js';
import { RECIPIENT_DESTINATION_ASSET, v1Routes } from '../src/server/v1-routes.js';
import { requestFor, type Request } from './api-key-helpers.js';
import { FakeNetwork } from './fake-network.js';
import { ASSET, FakeMandateRpc, MANDATE, principal, UNIT } from './fake-rpc.js';
import { clientFor, ORIGIN, signInWith, wallet, type Call } from './sign-in-helpers.js';

const adminUrl = inject('dbAdminUrl');
const roleUrls = inject('dbRoleUrls');

const FACTORY = 'CB4AYBA5NVQPVPNOWUCSZQK6ZIGOF7KSCS6SF6UV6D2OKPDXLHEPD4V7';
const TESTNET = 'stellar:testnet';
const EMAIL = 'ada@example.com';
const LABEL = 'Ada Lovelace';

let database: TestDatabase;
let db: Database;
let network: FakeNetwork;
let adapter: StellarChainAdapter;
let app: V1App['app'];
let request: Request;
let call: Call;
const lines: string[] = [];
let databases = 0;

// A contract belongs to one mandate, and the fake RPC serves one contract, so
// every test that pays on it needs a database of its own. The log lines stay
// across tests, for the last one to read.
beforeEach(async () => {
  databases += 1;
  database = await createTestDatabase(adminUrl, `${import.meta.url}#${String(databases)}`);
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
    sealer: createSealer(randomBytes(32).toString('base64')),
    agentAccounts: new StellarAgentAccounts({
      network: TESTNET,
      chain: {
        friendbot: () => Promise.resolve(),
        accountFacts: () => Promise.resolve({ exists: true, trustlines: [], memoRequired: false }),
      },
    }),
  });
  ({ app } = createV1App({ routes: composed.routes, log: (line) => lines.push(line) }));
  request = requestFor(app);
  call = clientFor(app);
});

afterEach(async () => {
  await db.close();
  await database.drop();
});

interface Owner extends ProjectContext {
  readonly cookie: string;
  readonly mandateId: string;
  readonly recipientId: string;
}

/**
 * A principal whose owner is signed in, with a mandate and a recipient that
 * can be paid. The fake RPC serves one contract, so a second owner in the
 * same test takes a contract of its own, never reached on chain, and a
 * recipient with no wallet, which needs no allowlist call.
 */
async function owner(contractAddress: string = MANDATE): Promise<Owner> {
  const onChain = contractAddress === MANDATE;
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
  const address = wallet().publicKey();
  network.facts.set(address, {
    exists: true,
    trustlines: [RECIPIENT_DESTINATION_ASSET],
    memoRequired: false,
  });
  const recipient = await request('POST', '/v1/recipients', {
    cookie: token,
    project: context.projectId,
    body: onChain
      ? { mandateId, label: LABEL, address, email: EMAIL }
      : { mandateId, label: LABEL },
  });
  expect(recipient.status).toBe(201);
  const recipientId = (recipient.json?.['recipient'] as { id: string }).id;
  return { ...context, cookie: token, mandateId, recipientId };
}

async function keyFor(o: Owner, scopes: readonly string[]): Promise<string> {
  const created = await request('POST', '/v1/api-keys', {
    cookie: o.cookie,
    project: o.projectId,
    body: { name: `Agent ${randomUUID()}`, scopes },
  });
  expect(created.status).toBe(201);
  return String(created.json?.['secret']);
}

async function mcp(key: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(`${ORIGIN}/v1/mcp`), {
    fetch: async (url, init) => app.request(String(url), init),
    requestInit: { headers: { authorization: `Bearer ${key}` } },
  });
  const client = new Client({ name: 'agent', version: '0' });
  // The SDK's own types disagree under exactOptionalPropertyTypes.
  await client.connect(transport as Transport);
  return client;
}

async function tool(client: Client, name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args });
  const content = result.content as { type: string; text: string }[];
  const body = content[0]?.text ?? '';
  return {
    isError: result.isError === true,
    body,
    json: JSON.parse(body) as Record<string, unknown>,
  };
}

function args(o: Owner, taskId: string, amount = 5n * UNIT) {
  return {
    mandateId: o.mandateId,
    recipientId: o.recipientId,
    amount: { amount: amount.toString(), asset: 'USDC', network: TESTNET, scale: 7 },
    taskId,
  };
}

async function payoutsOf(o: Owner): Promise<{ id: string; taskId: string; status: string }[]> {
  const context = { principalId: o.principalId, projectId: o.projectId };
  const page = await db.tenant(context).transaction((tx) => payouts.list(tx, {}, { limit: 100 }));
  return page.items.map((p) => ({ id: p.id, taskId: p.taskId, status: p.status }));
}

function errorCode(out: { json: Record<string, unknown> }): unknown {
  return (out.json['error'] as { code?: unknown } | undefined)?.code;
}

describe('/v1/mcp as the web role serves it', () => {
  it('makes one payout for one task id, retried in turn or at once', async () => {
    const alice = await owner();
    const agent = await mcp(await keyFor(alice, ['payouts:read', 'payouts:write']));

    const first = await tool(agent, 'request_payout', args(alice, 'task-1'));
    expect(first.isError).toBe(false);
    const again = await tool(agent, 'request_payout', args(alice, 'task-1'));
    expect(again.json).toMatchObject({ replayed: true });
    const id = (first.json['payout'] as { id: string }).id;
    expect((again.json['payout'] as { id: string }).id).toBe(id);

    const racing = await Promise.all(
      [1, 2, 3].map(() => tool(agent, 'request_payout', args(alice, 'task-2'))),
    );
    expect(racing.map((r) => r.isError)).toEqual([false, false, false]);
    expect(new Set(racing.map((r) => (r.json['payout'] as { id: string }).id)).size).toBe(1);

    const rows = await payoutsOf(alice);
    expect(rows.map((r) => r.taskId).sort()).toEqual(['task-1', 'task-2']);

    // The same task with another amount is refused, not paid again.
    const changed = await tool(agent, 'request_payout', args(alice, 'task-1', 6n * UNIT));
    expect(changed.isError).toBe(true);
    expect(errorCode(changed)).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(await payoutsOf(alice)).toHaveLength(2);
  });

  it('lets a key without payouts:write quote and read, but not request', async () => {
    const alice = await owner();
    const writer = await mcp(await keyFor(alice, ['payouts:read', 'payouts:write']));
    const reader = await mcp(await keyFor(alice, ['payouts:read']));
    const made = await tool(writer, 'request_payout', args(alice, 'paid-by-writer'));
    const payoutId = (made.json['payout'] as { id: string }).id;

    const refused = await tool(reader, 'request_payout', args(alice, 'reader-task'));
    expect(errorCode(refused)).toBe('FORBIDDEN');
    expect((await payoutsOf(alice)).map((r) => r.taskId)).toEqual(['paid-by-writer']);

    const quote = await tool(reader, 'quote_payout', args(alice, 'reader-task'));
    expect(errorCode(quote)).not.toBe('FORBIDDEN');
    const status = await tool(reader, 'payout_status', {
      mandateId: alice.mandateId,
      taskId: 'paid-by-writer',
    });
    expect(status.isError).toBe(false);
    expect(status.json).toMatchObject({ payout: { id: payoutId, taskId: 'paid-by-writer' } });
    const listed = await tool(reader, 'list_receipts', {});
    expect(listed.json).toEqual({ items: [], nextCursor: null });
  });

  it('reads back a receipt once the payout is final, with no personal data', async () => {
    const alice = await owner();
    const agent = await mcp(await keyFor(alice, ['payouts:read', 'payouts:write']));
    const made = await tool(agent, 'request_payout', args(alice, 'to-finish'));
    const payout = made.json['payout'] as { id: string; status: string };
    // As the worker would: a queued payout that fails, then its receipt.
    const worker = { principalId: alice.principalId, projectId: alice.projectId };
    await db.withTenant('worker', { ...worker, scope: 'project' }, async (tx) => {
      if (payout.status === 'queued') {
        await payouts.transition(tx, payout.id, { from: 'queued', to: 'failed' });
      }
      await receipts.issue(tx, payout.id, null);
    });

    const status = await tool(agent, 'payout_status', {
      mandateId: alice.mandateId,
      taskId: 'to-finish',
    });
    expect(status.json).toMatchObject({
      payout: { id: payout.id },
      receipt: { payoutId: payout.id, taskId: 'to-finish', mandateId: alice.mandateId },
    });
    const listed = await tool(agent, 'list_receipts', { limit: 1 });
    expect(listed.json).toMatchObject({ items: [{ payoutId: payout.id }], nextCursor: null });

    for (const out of [made, status, listed]) {
      expect(out.body).not.toContain(LABEL);
      expect(out.body).not.toContain(EMAIL);
    }
  });

  it('shows another principal nothing and lets it pay nothing on the mandate', async () => {
    const alice = await owner();
    const bob = await owner(testContract());
    const alices = await mcp(await keyFor(alice, ['payouts:read', 'payouts:write']));
    await tool(alices, 'request_payout', args(alice, 'alice-task'));
    const bobs = await mcp(await keyFor(bob, ['payouts:read', 'payouts:write']));

    const status = await tool(bobs, 'payout_status', {
      mandateId: alice.mandateId,
      taskId: 'alice-task',
    });
    expect(status.json).toEqual({ payout: null, receipt: null });
    const onAlices = await tool(bobs, 'request_payout', args(alice, 'bob-task'));
    expect(errorCode(onAlices)).toBe('NOT_FOUND');
    const quote = await tool(bobs, 'quote_payout', args(alice, 'bob-task'));
    expect(errorCode(quote)).toBe('NOT_FOUND');
    expect(await payoutsOf(bob)).toEqual([]);
    expect((await payoutsOf(alice)).map((r) => r.taskId)).toEqual(['alice-task']);
  });

  it('refuses a request without a key, or with a session instead', async () => {
    const alice = await owner();
    const bare = await request('POST', '/v1/mcp', {
      body: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      origin: null,
      headers: { accept: 'application/json, text/event-stream' },
    });
    expect(bare.status).toBe(401);
    const bySession = await request('POST', '/v1/mcp', {
      cookie: alice.cookie,
      project: alice.projectId,
      body: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      headers: { accept: 'application/json, text/event-stream' },
    });
    expect(bySession.status).toBe(401);
  });

  it('never logs an API key or an email', () => {
    expect(lines.some((line) => line.includes('v1_mcp_tool'))).toBe(true);
    for (const line of lines) {
      expect(line).not.toMatch(/ujk_/);
      expect(line).not.toContain(EMAIL);
      expect(line).not.toContain(LABEL);
    }
  });
});
