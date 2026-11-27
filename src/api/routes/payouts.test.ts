// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The payout routes in front of a service held in memory: what each route
// accepts, which scope it asks for, how a retry is answered, and how each
// refusal reads on the wire. The routes on a real database and the fake
// chain are in payouts.db.test.ts.

import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { DatabaseUnavailableError, PayoutConflictError } from '../../db/index.js';
import type { ProjectContext } from '../../db/index.js';
import { tokenAmount } from '../../money/index.js';
import {
  PayoutServiceError,
  type CreatePayoutInput,
  type PayoutQuote,
  type PayoutRecord,
  type PayoutService,
  type QuoteInput,
} from '../../payouts/payout-service.js';
import { createV1App } from '../app.js';
import type { Access, Authenticate, Caller } from '../authenticate.js';
import { ApiError, errorEnvelopeSchema } from '../errors.js';
import { memoryIdempotencyStore } from '../idempotency.js';
import { payoutApiError, payoutRoutes } from './payouts.js';

const TENANT: ProjectContext = { principalId: randomUUID(), projectId: randomUUID() };
const MANDATE_ID = randomUUID();
const RECIPIENT_ID = randomUUID();
const CONTRACT = 'CDEEDQ64YS6XHBTWC3QLS5JWOLI3LSO46VDDZE66FW6CZGHZNRDV4GZW';
const WALLET = 'GBT7ITQKEX3Z2YWIYLPRQ5W3JLA2TJ3JTABB765ZYNG7VLX5YYUPI3DT';
const CREATED = new Date('2026-11-27T09:00:00.000Z');
const NET = 'stellar:testnet';

function usdc(amount: string) {
  return { amount, asset: 'USDC', network: NET, scale: 7 };
}

function record(input: CreatePayoutInput, blockedBy: string | null = null): PayoutRecord {
  const amount = tokenAmount(input.amount.amount, 'USDC', 'stellar');
  const zero = tokenAmount(0n, 'USDC', 'stellar');
  const id = randomUUID();
  return {
    created: true,
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
      status: blockedBy === null ? 'queued' : 'blocked',
      blockedBy,
      onchainPayoutId: 'f'.repeat(64),
      requestTxHash: null,
      metadata: input.metadata ?? {},
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
        status: blockedBy === null ? 'planned' : 'cancelled',
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
      label: 'Ada',
      recipientRef: 'c'.repeat(64),
      status: 'active',
      createdAt: CREATED,
    },
  };
}

interface Harness {
  readonly service: PayoutService & {
    creates: CreatePayoutInput[];
    quotes: QuoteInput[];
    callers: ProjectContext[];
  };
  readonly scopes: string[];
  send(path: string, body: unknown, headers?: Record<string, string>): Promise<Answer>;
}

interface Answer {
  readonly status: number;
  readonly headers: Headers;
  readonly body: Record<string, unknown>;
}

function harness(
  behaviour: {
    create?: (input: CreatePayoutInput) => Promise<PayoutRecord>;
    quote?: (input: QuoteInput) => Promise<PayoutQuote>;
    authenticate?: (access: Access) => Promise<Caller>;
  } = {},
): Harness {
  const creates: CreatePayoutInput[] = [];
  const quotes: QuoteInput[] = [];
  const callers: ProjectContext[] = [];
  const service = {
    creates,
    quotes,
    callers,
    async create(context: ProjectContext, input: CreatePayoutInput) {
      callers.push(context);
      creates.push(input);
      return (behaviour.create ?? ((i) => Promise.resolve(record(i))))(input);
    },
    async quote(context: ProjectContext, input: QuoteInput) {
      callers.push(context);
      quotes.push(input);
      return (
        behaviour.quote ??
        (() =>
          Promise.resolve<PayoutQuote>({
            decision: 'allowed',
            blockedBy: null,
            amount: tokenAmount(input.amount.amount, 'USDC', 'stellar'),
            network: NET,
          }))
      )(input);
    },
  };
  const scopes: string[] = [];
  const authenticate = ((access: Access) => async () => {
    scopes.push('scope' in access ? access.scope : access.permission);
    if (behaviour.authenticate !== undefined) return behaviour.authenticate(access);
    return { kind: 'key', ...TENANT, tokenId: randomUUID(), scopes: [] } satisfies Caller;
  }) as Authenticate;
  const { app } = createV1App({
    routes: payoutRoutes({
      service,
      authenticate,
      idempotency: { store: memoryIdempotencyStore(), log: () => undefined },
    }),
  });
  return {
    service,
    scopes,
    async send(path, body, headers = {}) {
      const response = await app.request(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
      });
      return {
        status: response.status,
        headers: response.headers,
        body: (await response.json()) as Record<string, unknown>,
      };
    },
  };
}

function body(over: Record<string, unknown> = {}) {
  return {
    mandateId: MANDATE_ID,
    recipientId: RECIPIENT_ID,
    amount: usdc('25000000'),
    taskId: 'task-42',
    metadata: { batch: 'week-48' },
    ...over,
  };
}

function errorOf(answer: Answer) {
  return errorEnvelopeSchema.parse(answer.body).error;
}

describe('POST /v1/payouts', () => {
  it('answers 202 with the payout, masked, after asking for payouts:write', async () => {
    const h = harness();
    const answer = await h.send('/v1/payouts', body(), { 'idempotency-key': 'run-42' });
    expect(answer.status).toBe(202);
    expect(h.scopes).toEqual(['payouts:write']);
    expect(answer.body['payout']).toMatchObject({
      principalId: TENANT.principalId,
      projectId: TENANT.projectId,
      mandate: { id: MANDATE_ID, contractId: CONTRACT },
      recipient: { id: RECIPIENT_ID, label: 'Ada' },
      taskId: 'task-42',
      amount: usdc('25000000'),
      fee: usdc('0'),
      status: 'queued',
      blockedBy: null,
      legs: [
        {
          index: 0,
          method: 'stellar.wallet',
          destination: 'GBT7...I3DT',
          amount: usdc('25000000'),
          status: 'planned',
          txHash: null,
        },
      ],
      onChainPayoutId: 'f'.repeat(64),
      requestTxHash: null,
      receiptId: null,
      createdAt: CREATED.toISOString(),
      settledAt: null,
    });
    // The wire never carries the full destination or the metadata.
    expect(JSON.stringify(answer.body)).not.toContain(WALLET);
    expect(JSON.stringify(answer.body)).not.toContain('week-48');
    expect(h.service.creates[0]).toMatchObject({
      idempotencyKey: 'run-42',
      taskId: 'task-42',
      metadata: { batch: 'week-48' },
    });
    expect(h.service.callers[0]).toMatchObject(TENANT);
  });

  it('answers a blocked payout 202 with its spec error', async () => {
    const h = harness({ create: (i) => Promise.resolve(record(i, 'RECIPIENT_NOT_ALLOWED')) });
    const answer = await h.send('/v1/payouts', body(), { 'idempotency-key': 'k1' });
    expect(answer.status).toBe(202);
    expect(answer.body['payout']).toMatchObject({
      status: 'blocked',
      blockedBy: 'RECIPIENT_NOT_ALLOWED',
    });
  });

  it('replays the first answer for the same key and body, and runs once', async () => {
    const h = harness();
    const first = await h.send('/v1/payouts', body(), { 'idempotency-key': 'same' });
    const second = await h.send('/v1/payouts', body(), { 'idempotency-key': 'same' });
    expect(second.status).toBe(202);
    expect(second.headers.get('idempotent-replayed')).toBe('true');
    expect(second.body).toEqual(first.body);
    expect(h.service.creates).toHaveLength(1);
  });

  it('runs 20 identical requests at once into one payout', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = harness({
      create: async (i) => {
        await gate;
        return record(i);
      },
    });
    const all = Array.from({ length: 20 }, () =>
      h.send('/v1/payouts', body(), { 'idempotency-key': 'burst' }),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    release();
    const answers = await Promise.all(all);
    expect(h.service.creates).toHaveLength(1);
    const ok = answers.filter((a) => a.status === 202);
    const busy = answers.filter((a) => a.status === 409);
    expect(ok.length + busy.length).toBe(20);
    expect(ok.length).toBeGreaterThanOrEqual(1);
    for (const a of busy) expect(errorOf(a).code).toBe('IDEMPOTENCY_IN_PROGRESS');
    const ids = new Set(ok.map((a) => (a.body['payout'] as { id: string }).id));
    expect(ids.size).toBe(1);
  });

  it('refuses the same key with another body, before the service runs', async () => {
    const h = harness();
    await h.send('/v1/payouts', body(), { 'idempotency-key': 'k' });
    const other = await h.send('/v1/payouts', body({ taskId: 'task-43' }), {
      'idempotency-key': 'k',
    });
    expect(other.status).toBe(422);
    expect(errorOf(other).code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(h.service.creates).toHaveLength(1);
  });

  it('needs an Idempotency-Key', async () => {
    const answer = await harness().send('/v1/payouts', body());
    expect(answer.status).toBe(400);
    expect(errorOf(answer).code).toBe('IDEMPOTENCY_KEY_REQUIRED');
  });

  it('answers TASK_ID_REUSED for the same task under another key', async () => {
    const h = harness({ create: () => Promise.reject(new PayoutConflictError('TASK_ID_REUSED')) });
    const answer = await h.send('/v1/payouts', body(), { 'idempotency-key': 'other' });
    expect(answer.status).toBe(409);
    expect(errorOf(answer)).toMatchObject({
      code: 'TASK_ID_REUSED',
      details: [{ path: 'body.taskId', issue: 'reused' }],
    });
  });

  it.each([
    ['asset', { ...usdc('1'), asset: 'EURC' }],
    ['network', { ...usdc('1'), network: 'stellar:pubnet' }],
    ['scale', { ...usdc('1'), scale: 6 }],
  ] as const)(
    'answers 400 at body.amount.%s for an amount the mandate does not hold',
    async (field, amount) => {
      const h = harness({
        create: () =>
          Promise.reject(new PayoutServiceError('AMOUNT_MISMATCH', 'mismatch', { field })),
      });
      const answer = await h.send('/v1/payouts', body({ amount }), { 'idempotency-key': 'k' });
      expect(answer.status).toBe(400);
      expect(errorOf(answer)).toMatchObject({
        code: 'INVALID_REQUEST',
        details: [{ path: `body.amount.${field}`, issue: 'mismatch' }],
      });
    },
  );

  it.each([
    ['a zero amount', { amount: usdc('0') }, 'body.amount.amount'],
    ['a decimal amount', { amount: usdc('2.5') }, 'body.amount.amount'],
    ['a number amount', { amount: { ...usdc('1'), amount: 25 } }, 'body.amount.amount'],
    ['a fractional scale', { amount: { ...usdc('1'), scale: 7.5 } }, 'body.amount.scale'],
    [
      'an unknown amount field',
      { amount: { ...usdc('1'), currency: 'USD' } },
      'body.amount.currency',
    ],
    ['a bad task id', { taskId: 'no spaces' }, 'body.taskId'],
    ['a bad mandate id', { mandateId: 'nope' }, 'body.mandateId'],
    ['an unknown field', { fee: '1' }, 'body.fee'],
    ['a metadata value too long', { metadata: { a: 'x'.repeat(257) } }, 'body.metadata.a'],
    [
      'a reserved metadata key',
      { metadata: JSON.parse('{"__proto__":"x"}') as unknown },
      'body.metadata',
    ],
    [
      'too many metadata keys',
      {
        metadata: Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`k${String(i)}`, 'v'])),
      },
      'body.metadata',
    ],
  ])('refuses %s with its path and runs nothing', async (_name, over, path) => {
    const h = harness();
    const answer = await h.send('/v1/payouts', body(over), { 'idempotency-key': 'k' });
    expect(answer.status).toBe(400);
    const error = errorOf(answer);
    expect(error.code).toBe('INVALID_REQUEST');
    expect(error.details?.map((d) => d.path)).toContain(path);
    expect(h.service.creates).toHaveLength(0);
  });

  it('takes 16 metadata keys and lower cases the ids', async () => {
    const h = harness();
    const metadata = Object.fromEntries(
      Array.from({ length: 16 }, (_, i) => [`k${String(i)}`, 'v']),
    );
    const answer = await h.send(
      '/v1/payouts',
      body({ metadata, mandateId: MANDATE_ID.toUpperCase() }),
      { 'idempotency-key': 'k' },
    );
    expect(answer.status).toBe(202);
    expect(h.service.creates[0]?.mandateId).toBe(MANDATE_ID);
  });

  it('answers an authentication refusal before reading the body or the key', async () => {
    const h = harness({
      authenticate: () => Promise.reject(new ApiError('TOKEN_INVALID', 'The API key is not valid')),
    });
    const answer = await h.send('/v1/payouts', { nonsense: true });
    expect(answer.status).toBe(401);
    expect(errorOf(answer).code).toBe('TOKEN_INVALID');
    expect(h.service.creates).toHaveLength(0);
  });
});

describe('POST /v1/payouts/quote', () => {
  it('answers the decision after asking for payouts:read, and writes nothing', async () => {
    const h = harness({
      quote: (i) =>
        Promise.resolve({
          decision: 'blocked',
          blockedBy: 'INSUFFICIENT_FUNDS',
          amount: tokenAmount(i.amount.amount, 'USDC', 'stellar'),
          network: NET,
        }),
    });
    const answer = await h.send('/v1/payouts/quote', {
      mandateId: MANDATE_ID,
      recipientId: RECIPIENT_ID,
      amount: usdc('25000000'),
    });
    expect(answer.status).toBe(200);
    expect(h.scopes).toEqual(['payouts:read']);
    expect(answer.body).toEqual({
      quote: { decision: 'blocked', blockedBy: 'INSUFFICIENT_FUNDS', amount: usdc('25000000') },
    });
    expect(h.service.creates).toHaveLength(0);
    expect(h.service.quotes[0]?.taskId).toBeUndefined();
  });

  it('takes an optional task id and refuses metadata', async () => {
    const h = harness();
    const ok = await h.send('/v1/payouts/quote', {
      mandateId: MANDATE_ID,
      recipientId: RECIPIENT_ID,
      amount: usdc('1'),
      taskId: 'task-1',
    });
    expect(ok.body).toMatchObject({ quote: { decision: 'allowed', blockedBy: null } });
    expect(h.service.quotes[0]?.taskId).toBe('task-1');
    const refused = await h.send('/v1/payouts/quote', { ...body(), metadata: { a: 'b' } });
    expect(refused.status).toBe(400);
  });

  it('answers CHAIN_UNAVAILABLE when the chain does not answer', async () => {
    const h = harness({
      quote: () => Promise.reject(new PayoutServiceError('CHAIN_UNAVAILABLE', 'down')),
    });
    const answer = await h.send('/v1/payouts/quote', body({ metadata: undefined }));
    expect(answer.status).toBe(503);
    expect(errorOf(answer).code).toBe('CHAIN_UNAVAILABLE');
  });
});

describe('the OpenAPI document', () => {
  it('lists both routes, with the key header on creation only', () => {
    const { document } = createV1App({
      routes: payoutRoutes({
        service: harness().service,
        authenticate: (() => () => Promise.reject(new Error('unused'))) as Authenticate,
        idempotency: { store: memoryIdempotencyStore(), log: () => undefined },
      }),
    });
    const text = JSON.stringify(document);
    const paths = (document as unknown as { paths: Record<string, Record<string, unknown>> }).paths;
    expect(Object.keys(paths['/v1/payouts'] ?? {})).toEqual(['post']);
    expect(Object.keys(paths['/v1/payouts/quote'] ?? {})).toEqual(['post']);
    expect(JSON.stringify(paths['/v1/payouts'])).toContain('Idempotency-Key');
    expect(JSON.stringify(paths['/v1/payouts/quote'])).not.toContain('Idempotency-Key');
    expect(text).toContain('TASK_ID_REUSED');
  });
});

describe('payoutApiError', () => {
  const codeOf = (error: unknown) => (payoutApiError(error) as ApiError).code;

  it('maps every refusal to one code, and leaves anything else as it was', () => {
    expect(codeOf(new PayoutServiceError('MANDATE_NOT_FOUND', 'x'))).toBe('NOT_FOUND');
    expect(codeOf(new PayoutServiceError('RECIPIENT_NOT_FOUND', 'x'))).toBe('NOT_FOUND');
    expect(codeOf(new PayoutServiceError('MANDATE_NOT_SERVED', 'x'))).toBe('MANDATE_REFUSED');
    expect(codeOf(new PayoutConflictError('ONCHAIN_PAYOUT_ID_REUSED'))).toBe('TASK_ID_REUSED');
    expect(codeOf(new PayoutConflictError('IDEMPOTENCY_KEY_REUSED'))).toBe(
      'IDEMPOTENCY_KEY_REUSED',
    );
    const down = payoutApiError(new DatabaseUnavailableError('down')) as ApiError;
    expect(down.code).toBe('DB_UNAVAILABLE');
    expect(down.headers['retry-after']).toBe('5');
    const noWallet = payoutApiError(
      new PayoutServiceError('RECIPIENT_HAS_NO_METHOD', 'x'),
    ) as ApiError;
    expect(noWallet.details).toEqual([
      { path: 'body.recipientId', issue: 'recipient_has_no_method' },
    ]);
    const tooBig = payoutApiError(
      new PayoutServiceError('AMOUNT_MISMATCH', 'x', { field: 'amount' }),
    ) as ApiError;
    expect(tooBig.details).toEqual([{ path: 'body.amount.amount', issue: 'too_big' }]);
    const other = new Error('bug');
    expect(payoutApiError(other)).toBe(other);
  });
});
