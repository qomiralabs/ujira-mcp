// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';

import { createMcpServer } from '../src/mcp/server.js';
import { UNIT } from './fake-rpc.js';
import { alice, mallory, setup } from './helpers.js';

async function connect(engine = setup().engine, onInternalError?: (name: string) => void) {
  const server = createMcpServer(engine, onInternalError === undefined ? {} : { onInternalError });
  const [ours, theirs] = InMemoryTransport.createLinkedPair();
  await server.connect(theirs);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(ours);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args });
  const content = result.content as { type: string; text: string }[];
  const body = content[0]?.text ?? '';
  return { isError: result.isError === true, body, json: () => JSON.parse(body) as unknown };
}

const usdc = (n: bigint) => (n * UNIT).toString();

describe('MCP server', () => {
  it('offers exactly the four payout tools, none of which takes a key', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'list_receipts',
      'payout_status',
      'quote_payout',
      'request_payout',
    ]);
    for (const tool of tools) {
      const props = Object.keys(tool.inputSchema.properties ?? {});
      expect(props.some((p) => /secret|key|seed/i.test(p))).toBe(false);
      expect(tool.inputSchema['additionalProperties']).toBe(false);
    }
    const request = tools.find((t) => t.name === 'request_payout');
    expect(request?.inputSchema.required).toEqual(
      expect.arrayContaining(['task_id', 'recipient', 'amount']),
    );
  });

  it('quote_payout predicts without spending', async () => {
    const client = await connect();
    const out = await call(client, 'quote_payout', { recipient: alice, amount: usdc(60n) });
    expect(out.isError).toBe(false);
    expect(out.json()).toMatchObject({ decision: 'blocked', reason: 'payment_cap_exceeded' });
  });

  it('request_payout pays, waits for approval, or blocks, and says so', async () => {
    const client = await connect();
    const paid = await call(client, 'request_payout', {
      task_id: 'm1',
      recipient: alice,
      amount: usdc(5n),
    });
    expect(paid.json()).toMatchObject({
      outcome: 'paid',
      amount: usdc(5n),
      amount_display: '5 USDC',
    });
    const waiting = await call(client, 'request_payout', {
      task_id: 'm2',
      recipient: alice,
      amount: usdc(25n),
    });
    expect(waiting.json()).toMatchObject({ outcome: 'approval_required' });
    const blocked = await call(client, 'request_payout', {
      task_id: 'm3',
      recipient: mallory,
      amount: usdc(1n),
    });
    expect(blocked.json()).toMatchObject({ outcome: 'blocked', reason: 'recipient_not_allowed' });
  });

  it('payout_status and list_receipts report what happened', async () => {
    const client = await connect();
    await call(client, 'request_payout', { task_id: 's1', recipient: alice, amount: usdc(2n) });
    const status = await call(client, 'payout_status', { task_id: 's1' });
    expect(status.json()).toMatchObject({
      onchain_status: 'executed',
      receipt: { outcome: 'paid' },
    });
    const list = await call(client, 'list_receipts', { verify: true });
    expect(list.json()).toMatchObject({
      receipts: [{ task_id: 's1' }],
      verification: [{ task_id: 's1', ok: true }],
    });
  });

  it('refuses a key or any other unknown field, without echoing it', async () => {
    const client = await connect();
    const out = await call(client, 'request_payout', {
      task_id: 'x',
      recipient: alice,
      amount: usdc(1n),
      agent_secret: 'SPRETENDSECRETVALUE',
    });
    expect(out.isError).toBe(true);
    expect(out.body).toContain('agent_secret');
    expect(out.body).not.toContain('SPRETENDSECRETVALUE');
  });

  it('refuses a float amount by field name', async () => {
    const client = await connect();
    const out = await call(client, 'quote_payout', { recipient: alice, amount: 1.5 });
    expect(out).toMatchObject({ isError: true });
    expect(out.body).toContain('amount');
  });

  it('turns engine errors into tool errors and hides internal ones', async () => {
    const { engine, rpc } = setup();
    const seen: string[] = [];
    const client = await connect(engine, (name) => seen.push(name));
    const unknownRail = await call(client, 'quote_payout', {
      recipient: alice,
      amount: '1',
      rail: 'sdp',
    });
    expect(unknownRail.body).toContain('rail_unavailable');
    rpc.read = () => Promise.reject(new TypeError('socket detail that should stay inside'));
    const broken = await call(client, 'payout_status', { task_id: 'z' });
    expect(broken).toMatchObject({
      isError: true,
      body: 'Something went wrong in the payout server',
    });
    expect(seen).toEqual(['TypeError']);
  });

  it('answers an unknown tool with a protocol error', async () => {
    const client = await connect();
    await expect(client.callTool({ name: 'approve_payout', arguments: {} })).rejects.toThrow(
      /no such tool/,
    );
  });
});
