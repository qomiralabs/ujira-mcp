// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The product MCP at /v1/mcp over the MCP protocol, through the /v1 app, with
// the payout service and the reads held in memory: which tools it offers,
// which scope each needs, how a retried request lands on one payout, and that
// no answer names a person. The same route on a real database is in
// v1-mcp.db.test.ts.

import { randomUUID } from 'node:crypto';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { describe, expect, it } from 'vitest';

import { createV1App } from '../src/api/app.js';
import type { Access, Authenticate, KeyCaller } from '../src/api/authenticate.js';
import { ApiError } from '../src/api/errors.js';
import type { ApiScope } from '../src/auth/scopes.js';
import {
  PageRequestError,
  PayoutConflictError,
  type PageRequest,
  type ProjectContext,
  type Receipt,
} from '../src/db/index.js';
import { TOOL_NAMES } from '../src/mcp/server.js';
import { taskIdempotencyKey, V1_MCP_INSTRUCTIONS, v1McpRoutes } from '../src/mcp/v1.js';
import type { McpReads, TaskPayout } from '../src/mcp/v1-reads.js';
import { tokenAmount } from '../src/money/index.js';
import {
  PayoutServiceError,
  type CreatePayoutInput,
  type PayoutQuote,
  type PayoutRecord,
  type PayoutService,
  type QuoteInput,
} from '../src/payouts/payout-service.js';

const TENANT: ProjectContext = { principalId: randomUUID(), projectId: randomUUID() };
const MANDATE_ID = randomUUID();
const RECIPIENT_ID = randomUUID();
const CONTRACT = 'CDEEDQ64YS6XHBTWC3QLS5JWOLI3LSO46VDDZE66FW6CZGHZNRDV4GZW';
const WALLET = 'GBT7ITQKEX3Z2YWIYLPRQ5W3JLA2TJ3JTABB765ZYNG7VLX5YYUPI3DT';
const CREATED = new Date('2026-11-27T09:00:00.000Z');
const NET = 'stellar:testnet';
const LABEL = 'Ada Lovelace';
const KEY = 'ujk_test_pretendsecretvalue';
const BOTH: readonly ApiScope[] = ['payouts:read', 'payouts:write'];

function usdc(amount: string) {
  return { amount, asset: 'USDC', network: NET, scale: 7 };
}

function record(
  input: { taskId: string; idempotencyKey: string; amount: { amount: string } },
  created = true,
): PayoutRecord {
  const amount = tokenAmount(input.amount.amount, 'USDC', 'stellar');
  const zero = tokenAmount(0n, 'USDC', 'stellar');
  const id = randomUUID();
  return {
    created,
    principalId: TENANT.principalId,
    payout: {
      id,
      projectId: TENANT.projectId,
      mandateId: MANDATE_ID,
      recipientId: RECIPIENT_ID,
      taskId: input.taskId,
      idempotencyKey: input.idempotencyKey,
      network: NET,
      amount,
      fee: zero,
      status: 'queued',
      blockedBy: null,
      onchainPayoutId: 'f'.repeat(64),
      requestTxHash: null,
      metadata: { batch: 'w48' },
      createdAt: CREATED,
      updatedAt: CREATED,
      settledAt: null,
    },
    legs: [
      {
        id: randomUUID(),
        payoutId: id,
        index: 0,
        payoutMethodId: randomUUID(),
        method: 'stellar_wallet',
        destination: WALLET,
        amount,
        fee: zero,
        legKey: 'a'.repeat(64),
        txHash: null,
        status: 'planned',
        createdAt: CREATED,
        updatedAt: CREATED,
      },
    ],
    mandate: {
      id: MANDATE_ID,
      projectId: TENANT.projectId,
      name: 'Payroll',
      network: NET,
      contractAddress: CONTRACT,
      asset: 'USDC',
      scale: 7,
      agentKeyId: null,
      agentAddress: WALLET,
      principalWallet: WALLET,
      createdTxHash: null,
      createdAt: CREATED,
    },
    recipient: {
      id: RECIPIENT_ID,
      projectId: TENANT.projectId,
      mandateId: MANDATE_ID,
      label: LABEL,
      recipientRef: 'c'.repeat(64),
      status: 'active',
      createdAt: CREATED,
    },
  };
}

function receiptOf(r: PayoutRecord): Receipt {
  return {
    id: randomUUID(),
    projectId: TENANT.projectId,
    payoutId: r.payout.id,
    status: 'paid',
    blockedBy: null,
    network: NET,
    amount: r.payout.amount,
    fee: r.payout.fee,
    chainReceiptRef: `ujira:tx:v1:stellar:testnet:${'b'.repeat(64)}:0`,
    requestTxHash: 'd'.repeat(64),
    settledAt: CREATED,
    createdAt: CREATED,
  };
}

interface Behaviour {
  create?: (input: CreatePayoutInput) => Promise<PayoutRecord>;
  quote?: (input: QuoteInput) => Promise<PayoutQuote>;
  byTask?: (mandateId: string, taskId: string) => Promise<TaskPayout | undefined>;
  receipts?: (page: PageRequest) => ReturnType<McpReads['receipts']>;
  // Refuses the key as authenticate would, for the HTTP level tests.
  refuse?: ApiError;
}

function harness(scopes: readonly ApiScope[] = BOTH, behaviour: Behaviour = {}) {
  const creates: CreatePayoutInput[] = [];
  const quotes: QuoteInput[] = [];
  const pages: PageRequest[] = [];
  const contexts: ProjectContext[] = [];
  const accesses: Access[] = [];
  const lines: string[] = [];
  // Keyed as the payout row's unique key is, so a retry finds the first payout.
  const byKey = new Map<string, PayoutRecord>();
  const service: PayoutService = {
    async create(context, input) {
      contexts.push(context);
      creates.push(input);
      if (behaviour.create !== undefined) return behaviour.create(input);
      const first = byKey.get(input.idempotencyKey);
      if (first !== undefined) return Promise.resolve({ ...first, created: false });
      const made = record(input);
      byKey.set(input.idempotencyKey, made);
      return Promise.resolve(made);
    },
    async quote(context, input) {
      contexts.push(context);
      quotes.push(input);
      if (behaviour.quote !== undefined) return behaviour.quote(input);
      return Promise.resolve({
        decision: 'approval_required',
        blockedBy: null,
        amount: tokenAmount(input.amount.amount, 'USDC', 'stellar'),
        network: NET,
      });
    },
  };
  const reads: McpReads = {
    payoutByTask: (context, mandateId, task) => {
      contexts.push(context);
      return (behaviour.byTask ?? (() => Promise.resolve(undefined)))(mandateId, task);
    },
    receipts: (context, page) => {
      contexts.push(context);
      pages.push(page);
      return (behaviour.receipts ?? (() => Promise.resolve({ items: [], next: null })))(page);
    },
  };
  const authenticate = ((access: Access) =>
    (c: { req: { header(n: string): string | undefined } }) => {
      accesses.push(access);
      if (behaviour.refuse !== undefined) return Promise.reject(behaviour.refuse);
      if (c.req.header('authorization') !== `Bearer ${KEY}`) {
        return Promise.reject(new ApiError('TOKEN_INVALID', 'The API key is not valid'));
      }
      return Promise.resolve<KeyCaller>({ kind: 'key', ...TENANT, tokenId: randomUUID(), scopes });
    }) as unknown as Authenticate;
  const { app, document } = createV1App({
    routes: v1McpRoutes({
      payouts: service,
      reads,
      authenticate,
      log: (line) => lines.push(line),
    }),
  });
  const fetch = async (url: string | URL, init?: RequestInit) => app.request(String(url), init);

  async function connect(key: string | null = KEY): Promise<Client> {
    const transport = new StreamableHTTPClientTransport(new URL('http://ujira.test/v1/mcp'), {
      fetch,
      requestInit: { headers: key === null ? {} : { authorization: `Bearer ${key}` } },
    });
    const client = new Client({ name: 'test', version: '0' });
    // The SDK's own types disagree under exactOptionalPropertyTypes.
    await client.connect(transport as Transport);
    return client;
  }

  return { app, document, creates, quotes, pages, contexts, accesses, lines, byKey, connect };
}

async function call(client: Client, name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args });
  const content = result.content as { type: string; text: string }[];
  const body = content[0]?.text ?? '';
  return {
    isError: result.isError === true,
    body,
    json: () => JSON.parse(body) as Record<string, unknown>,
  };
}

function codeOf(out: { json: () => Record<string, unknown> }): string {
  return (out.json()['error'] as { code: string }).code;
}

function payoutArgs(over: Record<string, unknown> = {}) {
  return {
    mandateId: MANDATE_ID,
    recipientId: RECIPIENT_ID,
    amount: usdc('25000000'),
    taskId: 'task-42',
    ...over,
  };
}

function rpc(body: unknown, headers: Record<string, string> = {}) {
  return {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...headers,
    },
    body: JSON.stringify(body),
  };
}

describe('the tools /v1/mcp offers', () => {
  it('are the demo tool names, with strict inputs that take no key', async () => {
    const client = await harness().connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());
    for (const tool of tools) {
      const props = Object.keys(tool.inputSchema.properties ?? {});
      expect(props.some((p) => /secret|key|seed/i.test(p))).toBe(false);
      expect(tool.inputSchema['additionalProperties']).toBe(false);
    }
    const request = tools.find((t) => t.name === 'request_payout');
    expect(request?.inputSchema.required).toEqual(
      expect.arrayContaining(['mandateId', 'recipientId', 'amount', 'taskId']),
    );
    expect(request?.annotations).toMatchObject({ readOnlyHint: false, idempotentHint: true });
    const quote = tools.find((t) => t.name === 'quote_payout');
    expect(quote?.annotations).toMatchObject({ readOnlyHint: true });
  });

  it('say the mandate limits come from the chain and approvals happen in the dashboard', async () => {
    const client = await harness().connect();
    const { tools } = await client.listTools();
    for (const tool of tools) expect(tool.description).toMatch(/on chain/);
    for (const name of ['quote_payout', 'request_payout', 'payout_status']) {
      expect(tools.find((t) => t.name === name)?.description).toMatch(/UJIRA dashboard/);
    }
    expect(tools.find((t) => t.name === 'request_payout')?.description).toMatch(
      /task id is the idempotency key/,
    );
    expect(client.getInstructions()).toBe(V1_MCP_INSTRUCTIONS);
    expect(V1_MCP_INSTRUCTIONS).toMatch(/on chain/);
    expect(V1_MCP_INSTRUCTIONS).toMatch(/UJIRA dashboard/);
  });

  it('answers an unknown tool with a protocol error', async () => {
    const client = await harness().connect();
    await expect(client.callTool({ name: 'approve_payout', arguments: {} })).rejects.toThrow(
      /no such tool/,
    );
  });
});

describe('request_payout', () => {
  it('makes one payout for one task id, however often it is called', async () => {
    const h = harness();
    const client = await h.connect();
    const first = await call(client, 'request_payout', payoutArgs());
    const again = await call(client, 'request_payout', payoutArgs());
    expect(first.isError).toBe(false);
    const a = first.json() as { payout: { id: string; status: string }; replayed: boolean };
    const b = again.json() as { payout: { id: string }; replayed: boolean };
    expect(a.replayed).toBe(false);
    expect(b.replayed).toBe(true);
    expect(b.payout.id).toBe(a.payout.id);
    expect(h.byKey.size).toBe(1);
    // Both calls asked under the one key the task id makes.
    const key = taskIdempotencyKey(MANDATE_ID, 'task-42');
    expect(h.creates.map((c) => c.idempotencyKey)).toEqual([key, key]);
    expect(h.contexts).toEqual([expect.objectContaining(TENANT), expect.objectContaining(TENANT)]);
  });

  it('passes the request on as POST /v1/payouts takes it', async () => {
    const h = harness();
    const client = await h.connect();
    await call(
      client,
      'request_payout',
      payoutArgs({ mandateId: MANDATE_ID.toUpperCase(), metadata: { batch: 'w48' } }),
    );
    expect(h.creates).toEqual([
      {
        mandateId: MANDATE_ID,
        recipientId: RECIPIENT_ID,
        amount: usdc('25000000'),
        taskId: 'task-42',
        metadata: { batch: 'w48' },
        idempotencyKey: taskIdempotencyKey(MANDATE_ID, 'task-42'),
      },
    ]);
  });

  it('answers a task sent again with another amount with the conflict, not a second payout', async () => {
    const client = await harness(BOTH, {
      create: () => Promise.reject(new PayoutConflictError('IDEMPOTENCY_KEY_REUSED')),
    }).connect();
    const out = await call(client, 'request_payout', payoutArgs());
    expect(out.isError).toBe(true);
    expect(codeOf(out)).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('is refused to a key without payouts:write, which can still quote and read', async () => {
    const h = harness(['payouts:read']);
    const client = await h.connect();
    const refused = await call(client, 'request_payout', payoutArgs());
    expect(refused.isError).toBe(true);
    expect(codeOf(refused)).toBe('FORBIDDEN');
    expect(refused.body).toContain('payouts:write');
    expect(h.creates).toEqual([]);

    const quote = await call(client, 'quote_payout', payoutArgs());
    expect(quote.isError).toBe(false);
    expect(quote.json()).toEqual({
      quote: { decision: 'approval_required', blockedBy: null, amount: usdc('25000000') },
    });
    const status = await call(client, 'payout_status', { mandateId: MANDATE_ID, taskId: 'x' });
    expect(status.json()).toEqual({ payout: null, receipt: null });
    const listed = await call(client, 'list_receipts', {});
    expect(listed.json()).toEqual({ items: [], nextCursor: null });
  });

  it('never names the recipient or shows a whole wallet address', async () => {
    const client = await harness().connect();
    const out = await call(client, 'request_payout', payoutArgs());
    expect(out.body).not.toContain(LABEL);
    expect(out.body).not.toContain(WALLET);
    const payout = out.json()['payout'] as {
      recipient: unknown;
      legs: { destination: string }[];
    };
    expect(payout.recipient).toEqual({ id: RECIPIENT_ID });
    expect(payout.legs[0]?.destination).toBe('GBT7...I3DT');
    expect(out.body).not.toContain('w48');
  });
});

describe('the idempotency key a task makes', () => {
  it('is the same for the same task on the same mandate, in any case', () => {
    expect(taskIdempotencyKey(MANDATE_ID.toUpperCase(), 't')).toBe(
      taskIdempotencyKey(MANDATE_ID, 't'),
    );
    expect(taskIdempotencyKey(MANDATE_ID, 't')).not.toBe(taskIdempotencyKey(MANDATE_ID, 'u'));
    expect(taskIdempotencyKey(MANDATE_ID, 't')).not.toBe(taskIdempotencyKey(randomUUID(), 't'));
  });

  it('fits the key format even for a task id the format would refuse', () => {
    const key = taskIdempotencyKey(MANDATE_ID, 'run/7@host#3');
    expect(key).toMatch(/^[A-Za-z0-9_.:-]{1,255}$/);
    expect(key.startsWith('mcp.')).toBe(true);
  });
});

describe('payout_status and list_receipts', () => {
  it('report a task payout and its receipt', async () => {
    const paid = record({
      taskId: 'done',
      idempotencyKey: 'k',
      amount: { amount: '10000000' },
    });
    const receipt = receiptOf(paid);
    const h = harness(BOTH, {
      byTask: (mandateId, task) =>
        Promise.resolve(
          mandateId === MANDATE_ID && task === 'done' ? { record: paid, receipt } : undefined,
        ),
    });
    const client = await h.connect();
    const out = await call(client, 'payout_status', { mandateId: MANDATE_ID, taskId: 'done' });
    expect(out.isError).toBe(false);
    expect(out.json()).toMatchObject({
      payout: { id: paid.payout.id, taskId: 'done', receiptId: receipt.id, status: 'queued' },
      receipt: {
        id: receipt.id,
        payoutId: paid.payout.id,
        mandateId: MANDATE_ID,
        taskId: 'done',
        status: 'paid',
        amount: usdc('10000000'),
        chainReceiptRef: receipt.chainReceiptRef,
        settledAt: CREATED.toISOString(),
      },
    });
    expect(out.body).not.toContain(LABEL);
  });

  it('pages receipts newest first with a cursor it issued', async () => {
    const one = record({ taskId: 'one', idempotencyKey: 'k1', amount: { amount: '1' } });
    const h = harness(BOTH, {
      receipts: (page) =>
        Promise.resolve(
          page.after === undefined
            ? { items: [{ receipt: receiptOf(one), payout: one.payout }], next: 'page-key' }
            : { items: [], next: null },
        ),
    });
    const client = await h.connect();
    const first = await call(client, 'list_receipts', { limit: 1 });
    const body = first.json() as { items: { taskId: string }[]; nextCursor: string };
    expect(body.items.map((r) => r.taskId)).toEqual(['one']);
    expect(body.nextCursor).toMatch(/^[A-Za-z0-9_-]+$/);
    const second = await call(client, 'list_receipts', { cursor: body.nextCursor });
    expect(second.json()).toEqual({ items: [], nextCursor: null });
    expect(h.pages).toEqual([{ limit: 1 }, { limit: 20, after: 'page-key' }]);
  });

  it('refuses a cursor it did not issue', async () => {
    const h = harness(BOTH, {
      receipts: () => Promise.reject(new PageRequestError('after is not a key this list returned')),
    });
    const client = await h.connect();
    const forged = await call(client, 'list_receipts', { cursor: '!!' });
    expect(codeOf(forged)).toBe('INVALID_REQUEST');
    const tampered = await call(client, 'list_receipts', {
      cursor: Buffer.from(JSON.stringify({ after: 'x' })).toString('base64url'),
    });
    expect(codeOf(tampered)).toBe('INVALID_REQUEST');
    expect(tampered.json()['error']).toMatchObject({
      details: [{ path: 'cursor', issue: 'invalid_format' }],
    });
  });
});

describe('refusals', () => {
  it('names a bad field without echoing its value', async () => {
    const client = await harness().connect();
    const out = await call(client, 'request_payout', {
      ...payoutArgs(),
      agent_secret: 'SPRETENDSECRETVALUE',
    });
    expect(out.isError).toBe(true);
    expect(codeOf(out)).toBe('INVALID_REQUEST');
    expect(out.body).toContain('agent_secret');
    expect(out.body).not.toContain('SPRETENDSECRETVALUE');
    const float = await call(client, 'quote_payout', payoutArgs({ amount: 1.5 }));
    expect(float.json()['error']).toMatchObject({ details: [{ path: 'amount' }] });
  });

  it('answers service refusals with the /v1 codes', async () => {
    const client = await harness(BOTH, {
      quote: () => Promise.reject(new PayoutServiceError('MANDATE_NOT_FOUND', 'no such mandate')),
      create: () =>
        Promise.reject(
          new PayoutServiceError('AMOUNT_MISMATCH', 'the asset is wrong', { field: 'asset' }),
        ),
    }).connect();
    const quote = await call(client, 'quote_payout', payoutArgs());
    expect(codeOf(quote)).toBe('NOT_FOUND');
    const create = await call(client, 'request_payout', payoutArgs());
    expect(create.json()['error']).toMatchObject({
      code: 'INVALID_REQUEST',
      details: [{ path: 'amount.asset', issue: 'mismatch' }],
    });
  });

  it('hides an internal failure behind a fixed answer and logs only its class', async () => {
    const h = harness(BOTH, {
      byTask: () => Promise.reject(new TypeError('socket detail that should stay inside')),
    });
    const client = await h.connect();
    const out = await call(client, 'payout_status', { mandateId: MANDATE_ID, taskId: 'z' });
    expect(out.isError).toBe(true);
    expect(codeOf(out)).toBe('INTERNAL');
    expect(out.body).not.toContain('socket detail');
    const failed = h.lines.find((l) => l.includes('v1_mcp_tool_failed'));
    expect(failed).toContain('TypeError');
    expect(failed).not.toContain('socket detail');
  });

  it('logs each call with its tenant and outcome, never its input', async () => {
    const h = harness(['payouts:read']);
    const client = await h.connect();
    await call(client, 'quote_payout', payoutArgs({ taskId: 'secret-task-name' }));
    await call(client, 'request_payout', payoutArgs());
    const tools = h.lines.filter((l) => l.includes('v1_mcp_tool'));
    expect(tools).toHaveLength(2);
    for (const line of tools) {
      expect(line).toContain(TENANT.principalId);
      expect(line).toContain(TENANT.projectId);
      expect(line).not.toContain('secret-task-name');
      expect(line).not.toContain(RECIPIENT_ID);
    }
    expect(tools[1]).toContain('FORBIDDEN');
  });
});

describe('POST /v1/mcp over HTTP', () => {
  it('takes only a project API key, asking for payouts:read', async () => {
    const h = harness();
    const response = await h.app.request(
      '/v1/mcp',
      rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { authorization: 'Bearer nope' }),
    );
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toBe('Bearer realm="ujira"');
    expect(response.headers.get('ujira-request-id')).toBeTruthy();
    expect(await response.json()).toMatchObject({ error: { code: 'TOKEN_INVALID' } });
    expect(h.accesses).toEqual([{ scope: 'payouts:read', via: 'key' }]);
    await expect(h.connect(null)).rejects.toThrow();
  });

  it('passes a FORBIDDEN from authenticate through as 403', async () => {
    const h = harness(BOTH, { refuse: new ApiError('FORBIDDEN', 'missing scope') });
    const response = await h.app.request(
      '/v1/mcp',
      rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    );
    expect(response.status).toBe(403);
    expect(response.headers.get('www-authenticate')).toBeNull();
  });

  it('answers 405 to GET and DELETE, before asking for a key', async () => {
    const h = harness();
    for (const method of ['GET', 'DELETE']) {
      const response = await h.app.request('/v1/mcp', { method });
      expect(response.status).toBe(405);
      expect(response.headers.get('allow')).toBe('POST');
      expect(await response.json()).toMatchObject({ jsonrpc: '2.0', error: { code: -32000 } });
    }
    expect(h.accesses).toEqual([]);
  });

  it('answers a body that is not JSON with a parse error', async () => {
    const h = harness();
    const response = await h.app.request('/v1/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${KEY}`,
      },
      body: '{not json',
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: -32700 } });
  });

  it('is documented as one POST in the OpenAPI document', () => {
    const { document } = harness();
    const paths = document['paths'] as Record<string, Record<string, unknown>>;
    expect(Object.keys(paths['/v1/mcp'] ?? {})).toEqual(['post']);
  });
});
