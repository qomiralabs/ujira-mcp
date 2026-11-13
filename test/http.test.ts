// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { afterEach, describe, expect, it } from 'vitest';

import { createHttpServer } from '../src/mcp/http.js';
import { DEFAULT_MAX_AMOUNT, type HttpSettings, type PublicLimits } from '../src/mcp/public.js';
import { MANDATE, UNIT } from './fake-rpc.js';
import { alice, bob, setup } from './helpers.js';

const usdc = (n: bigint) => (n * UNIT).toString();

function settings(
  limits: Partial<PublicLimits> = {},
  over: Partial<HttpSettings> = {},
): HttpSettings {
  return {
    port: 0,
    host: '127.0.0.1',
    maxBodyBytes: 16 * 1024,
    requestTimeoutMs: 10_000,
    allowedOrigins: ['https://claude.ai', 'https://claude.com'],
    clientIp: { trustProxy: true },
    ...over,
    limits: {
      maxAmount: DEFAULT_MAX_AMOUNT,
      payoutsPerHour: 5,
      toolCallsPerMinute: 120,
      ...limits,
    },
  };
}

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

async function start(s: HttpSettings = settings(), world = setup()) {
  const lines: string[] = [];
  const server = createHttpServer({
    engine: world.engine,
    settings: s,
    assetCode: 'USDC',
    recipients: [alice, bob],
    log: (line) => lines.push(line),
  });
  open.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, lines, ...world };
}

async function connect(base: string, headers: Record<string, string> = {}) {
  const client = new Client({ name: 'test', version: '0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    requestInit: { headers },
  });
  // The SDK's own types disagree under exactOptionalPropertyTypes.
  await client.connect(transport as Transport);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args });
  const content = result.content as { type: string; text: string }[];
  const body = content[0]?.text ?? '';
  return { isError: result.isError === true, body, json: () => JSON.parse(body) as unknown };
}

const initialize = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'raw', version: '0' },
  },
});

function post(base: string, body: string, headers: Record<string, string> = {}) {
  return fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...headers,
    },
    body,
  });
}

describe('HTTP server', () => {
  it('answers /healthz and nothing else outside /mcp', async () => {
    const { base } = await start();
    const health = await fetch(`${base}/healthz`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: 'ok' });
    expect((await fetch(`${base}/healthz`, { method: 'POST' })).status).toBe(405);
    expect((await fetch(`${base}/nowhere`)).status).toBe(404);
  });

  it('initializes, lists the four tools and says the demo is shared', async () => {
    const { base } = await start();
    const client = await connect(base);
    expect(client.getServerVersion()).toMatchObject({ name: 'ujira', version: '0.2.0' });
    expect(client.getInstructions()).toContain('shared public demo on Stellar testnet');
    expect(client.getInstructions()).toContain(alice);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'list_receipts',
      'payout_status',
      'quote_payout',
      'request_payout',
    ]);
    const describe = (name: string) => tools.find((t) => t.name === name)?.description ?? '';
    expect(describe('list_receipts')).toContain('shared public demo');
    expect(describe('request_payout')).toContain('shared public demo');
    expect(describe('quote_payout')).toContain('public_demo_limit');
  });

  it('quotes and pays below the public cap', async () => {
    const { base } = await start();
    const client = await connect(base);
    const quote = await call(client, 'quote_payout', { recipient: alice, amount: usdc(5n) });
    expect(quote.json()).toMatchObject({ decision: 'allowed', amount: usdc(5n) });
    const paid = await call(client, 'request_payout', {
      task_id: 'h1',
      recipient: alice,
      amount: usdc(5n),
    });
    expect(paid.json()).toMatchObject({ outcome: 'paid', task_id: 'h1' });
  });

  it('blocks amounts above the public cap before the mandate sees them', async () => {
    const { base, rpc, receipts } = await start();
    const client = await connect(base);
    // 15 USDC is under the mandate's cap but over the demo's 10.
    const quote = await call(client, 'quote_payout', { recipient: alice, amount: usdc(15n) });
    expect(quote).toMatchObject({ isError: false });
    expect(quote.json()).toMatchObject({
      decision: 'blocked',
      reason: 'public_demo_limit',
      max_amount: usdc(10n),
    });
    // 25 USDC would need an approval; the cap keeps visitors away from it.
    const request = await call(client, 'request_payout', {
      task_id: 'big',
      recipient: alice,
      amount: usdc(25n),
    });
    expect(request.json()).toMatchObject({
      task_id: 'big',
      outcome: 'blocked',
      reason: 'public_demo_limit',
    });
    expect(rpc.calls.filter((c) => !c.startsWith('read:'))).toEqual([]);
    expect(rpc.payouts.size).toBe(0);
    expect(await receipts.list(MANDATE)).toEqual([]);
    // Exactly the cap is allowed.
    const edge = await call(client, 'quote_payout', { recipient: alice, amount: usdc(10n) });
    expect(edge.json()).toMatchObject({ decision: 'allowed' });
  });

  it('limits payout requests per address, from the proxy header', async () => {
    const { base, lines } = await start(settings({ payoutsPerHour: 2 }));
    const first = await connect(base, { 'x-forwarded-for': '198.51.100.9, 203.0.113.7' });
    const pay = (client: Client, id: string) =>
      call(client, 'request_payout', { task_id: id, recipient: alice, amount: usdc(1n) });
    expect((await pay(first, 'r1')).json()).toMatchObject({ outcome: 'paid' });
    expect((await pay(first, 'r2')).json()).toMatchObject({ outcome: 'paid' });
    const third = await pay(first, 'r3');
    expect(third).toMatchObject({ isError: true });
    expect(third.body).toMatch(/^rate_limited: .*2 payout requests an hour/);
    // A spoofed leftmost entry does not buy a fresh allowance.
    const spoofed = await connect(base, { 'x-forwarded-for': '192.0.2.1, 203.0.113.7' });
    expect((await pay(spoofed, 'r4')).isError).toBe(true);
    // Quotes are not payouts and still work.
    const quote = await call(first, 'quote_payout', { recipient: alice, amount: usdc(1n) });
    expect(quote.isError).toBe(false);
    const other = await connect(base, { 'x-forwarded-for': '203.0.113.8' });
    expect((await pay(other, 'r5')).json()).toMatchObject({ outcome: 'paid' });
    expect(lines.join('\n')).not.toContain('203.0.113');
  });

  it('limits all tool calls together', async () => {
    const { base } = await start(settings({ toolCallsPerMinute: 2 }));
    const a = await connect(base, { 'x-real-ip': '203.0.113.1' });
    const b = await connect(base, { 'x-real-ip': '203.0.113.2' });
    await call(a, 'payout_status', { task_id: 'x' });
    await call(b, 'payout_status', { task_id: 'x' });
    const third = await call(a, 'list_receipts', {});
    expect(third).toMatchObject({ isError: true });
    expect(third.body).toMatch(/^rate_limited: /);
  });

  it('refuses a browser origin it does not know, and lets Claude and originless clients in', async () => {
    const { base } = await start();
    const bad = await post(base, initialize, { origin: 'https://evil.example' });
    expect(bad.status).toBe(403);
    expect(await bad.json()).toMatchObject({ error: { code: -32000 } });
    for (const origin of ['https://claude.ai', 'https://claude.com']) {
      expect((await post(base, initialize, { origin })).status).toBe(200);
    }
    const none = await post(base, initialize);
    expect(none.status).toBe(200);
    expect(await none.json()).toMatchObject({ result: { serverInfo: { name: 'ujira' } } });
  });

  it('refuses a body over the limit', async () => {
    const { base } = await start();
    const padding = 'x'.repeat(20 * 1024);
    const res = await post(
      base,
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', padding }),
    );
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ error: { message: 'The request body is too large' } });
  });

  it('refuses bad JSON and methods other than POST on /mcp', async () => {
    const { base } = await start();
    const res = await post(base, '{not json');
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: -32700 } });
    const get = await fetch(`${base}/mcp`, { headers: { accept: 'text/event-stream' } });
    expect(get.status).toBe(405);
    expect(get.headers.get('allow')).toBe('POST');
  });

  it('times out a request that takes too long', async () => {
    const world = setup();
    world.rpc.read = () => new Promise(() => undefined);
    const { base } = await start(settings({}, { requestTimeoutMs: 200 }), world);
    const res = await post(
      base,
      JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'payout_status', arguments: { task_id: 'slow' } },
      }),
    );
    expect(res.status).toBe(504);
    expect(await res.json()).toMatchObject({ error: { message: 'The request took too long' } });
  });

  it('says SDP is not available here, and hides internal errors', async () => {
    const world = setup();
    const { base, lines } = await start(settings(), world);
    const client = await connect(base);
    const sdp = await call(client, 'quote_payout', { recipient: alice, amount: '1', rail: 'sdp' });
    expect(sdp).toMatchObject({ isError: true });
    expect(sdp.body).toBe('rail_unavailable: the sdp rail is not available on this server');
    world.rpc.read = () => Promise.reject(new TypeError('socket detail that should stay inside'));
    const broken = await call(client, 'payout_status', { task_id: 'z' });
    expect(broken).toMatchObject({
      isError: true,
      body: 'Something went wrong in the payout server',
    });
    expect(lines).toContain('internal error (TypeError)');
    expect(lines.join('\n')).not.toContain('socket detail');
  });
});
