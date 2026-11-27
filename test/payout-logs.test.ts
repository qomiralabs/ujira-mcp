// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// A full payout through the HTTP server, with every line it writes passed
// through the same JSON sink the server runs with: one paid at once, one
// that waits for an approver and is then paid, one the mandate blocks, then
// its status and its verified receipts. The output is scanned for keys,
// signatures, session tokens, API keys, emails and recipient addresses, and
// must still tie each payout's lines to its payout id and its request id.

import { createHash, randomBytes } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { Keypair } from '@stellar/stellar-sdk';
import { afterEach, describe, expect, it } from 'vitest';

import { createV1App } from '../src/api/app.js';
import { nodeHandler } from '../src/api/node.js';
import { publicMcp } from '../src/demo/public-mcp.js';
import { payoutIdFor } from '../src/ids.js';
import { jsonLog } from '../src/log.js';
import { createHttpServer } from '../src/mcp/http.js';
import type { HttpSettings } from '../src/mcp/public.js';
import { MANDATE, UNIT, approver } from './fake-rpc.js';
import { alice, bob, setup } from './helpers.js';

const open: Server[] = [];

afterEach(async () => {
  await Promise.all(
    open.splice(0).map(
      (s) =>
        new Promise<void>((resolve) => {
          s.closeAllConnections();
          s.close(() => {
            resolve();
          });
        }),
    ),
  );
});

function settings(): HttpSettings {
  return {
    port: 0,
    host: '127.0.0.1',
    maxBodyBytes: 16 * 1024,
    requestTimeoutMs: 10_000,
    allowedOrigins: [],
    clientIp: { trustProxy: true },
    limits: { maxAmount: 100n * UNIT, payoutsPerHour: 50, toolCallsPerMinute: 500 },
  };
}

// The test signers' keys, rebuilt from the seeds fake-rpc.ts derives them from.
const SEEDS = ['principal', 'agent', 'approver', 'executor', 'alice', 'bob'].map((name) =>
  Keypair.fromRawEd25519Seed(createHash('sha256').update(name).digest()).secret(),
);

const EMAIL = 'ada.lovelace@example.com';
// Fake credentials are made at run time, so no key shaped literal sits in the repository.
const API_KEY = `ujk_test_${randomBytes(16).toString('hex')}`;
const SESSION = `${randomBytes(32).toString('base64url')}Aa1`;

async function start() {
  const out: string[] = [];
  const log = jsonLog({ service: 'ujira-mcp-http', write: (json) => out.push(json) });
  const world = setup({ log });
  const http = settings();
  const server = createHttpServer({
    settings: http,
    publicMcp: publicMcp({ engine: world.engine, http, assetCode: 'USDC', recipients: [alice] }),
    v1: nodeHandler(createV1App({ log }).app),
    log,
  });
  open.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  return { base, out, ...world };
}

const headers = {
  authorization: `Bearer ${API_KEY}`,
  cookie: `ujira_session=${SESSION}`,
  'x-contact': EMAIL,
  'x-forwarded-for': '203.0.113.9',
};

async function connect(base: string) {
  const client = new Client({ name: 'log-test', version: '0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    requestInit: { headers },
  });
  await client.connect(transport as Transport);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args });
  const content = result.content as { type: string; text: string }[];
  return JSON.parse(content[0]?.text ?? '{}') as Record<string, unknown>;
}

const usdc = (n: bigint) => (n * UNIT).toString();

describe('the log output of a full payout', () => {
  it('carries no secret, signature, token, email or address, and ties each payout together', async () => {
    const { base, out, mandate } = await start();
    const client = await connect(base);

    expect(
      await call(client, 'request_payout', {
        task_id: 'log-paid',
        recipient: alice,
        amount: usdc(5n),
      }),
    ).toMatchObject({ outcome: 'paid' });

    expect(
      await call(client, 'request_payout', {
        task_id: 'log-approval',
        recipient: alice,
        amount: usdc(25n),
      }),
    ).toMatchObject({ outcome: 'approval_required' });
    await mandate.approve(approver, payoutIdFor(MANDATE, 'log-approval'));
    expect(
      await call(client, 'request_payout', {
        task_id: 'log-approval',
        recipient: alice,
        amount: usdc(25n),
      }),
    ).toMatchObject({ outcome: 'approved_then_paid' });

    // Over the per payment cap: the mandate refuses it, and that is recorded.
    expect(
      await call(client, 'request_payout', {
        task_id: 'log-blocked',
        recipient: alice,
        amount: usdc(60n),
      }),
    ).toMatchObject({ outcome: 'blocked' });

    await call(client, 'payout_status', { task_id: 'log-approval' });
    await call(client, 'list_receipts', { verify: true });
    await client.close();

    const ping = await fetch(`${base}/v1/ping?email=${encodeURIComponent(EMAIL)}`, { headers });
    expect(ping.status).toBe(200);
    // The answer has gone out; its log line follows when the socket closes.
    await new Promise((resolve) => setTimeout(resolve, 50));

    const text = out.join('\n');
    const records = out.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(records.length).toBeGreaterThan(10);

    for (const seed of SEEDS) expect(text).not.toContain(seed);
    for (const value of [API_KEY, SESSION, EMAIL, '203.0.113.9', alice, bob]) {
      expect(text, value).not.toContain(value);
    }
    expect(text).not.toMatch(/\bS[A-Z2-7]{55}\b/);
    expect(text).not.toMatch(/\bG[A-Z2-7]{55}\b/);
    expect(text).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}/);
    expect(text).not.toMatch(/bearer/i);
    // No signature or envelope: no long run of mixed case base64.
    for (const run of text.match(/[A-Za-z0-9+/_-]{44,}/g) ?? []) {
      expect(/[a-z]/.test(run) && /[A-Z]/.test(run), run).toBe(false);
    }

    // Each payout's lines carry its payout id and the request that carried it.
    const requests = records.filter((r) => r['event'] === 'http_request');
    for (const task of ['log-paid', 'log-approval', 'log-blocked']) {
      const id = payoutIdFor(MANDATE, task);
      const lines = records.filter((r) => r['payoutId'] === id);
      expect(
        lines.map((r) => r['event']),
        task,
      ).toContain('payout_requested');
      expect(
        lines.map((r) => r['event']),
        task,
      ).toContain('payout_recorded');
      for (const line of lines) {
        expect(line['mandate']).toBe(MANDATE);
        expect(
          requests.some((r) => r['requestId'] === line['requestId']),
          task,
        ).toBe(true);
      }
    }
    const outcomes = records
      .filter((r) => r['event'] === 'payout_recorded')
      .map((r) => r['outcome']);
    expect(outcomes).toEqual(['paid', 'approval_required', 'approved_then_paid', 'blocked']);
    const paid = records.find((r) => r['event'] === 'payout_recorded' && r['outcome'] === 'paid');
    expect(paid?.['tx']).toMatch(/^[0-9a-f]{64}$/);

    const v1 = requests.find((r) => r['route'] === '/v1');
    expect(v1?.['requestId']).toBe(ping.headers.get('ujira-request-id'));
    for (const r of records) {
      expect(['debug', 'info', 'warn', 'error']).toContain(r['level']);
      expect(r['service']).toBe('ujira-mcp-http');
    }
  });
});
