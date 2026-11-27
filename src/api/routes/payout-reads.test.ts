// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The payout read routes in front of a service held in memory: what each
// route accepts and refuses, what it asks to be authenticated as, and that
// what it answers is the shape the console was built against. The service on
// a real database is in payout-reads.db.test.ts.

import { randomUUID } from 'node:crypto';

import { Validator } from '@seriousme/openapi-schema-validator';
import { describe, expect, it } from 'vitest';

import { IDS, RECORDED } from '../../../console/src/test/v1Recorded.js';
import { paidView, TENANT, TX, usdc, viewOf, WALLET } from '../../../test/payout-view-helpers.js';
import type { Access, Authenticate, KeyCaller } from '../authenticate.js';
import {
  DatabaseUnavailableError,
  PageRequestError,
  type Page,
  type PayoutView,
  type ProjectContext,
} from '../../db/index.js';
import {
  PayoutReadError,
  type ApprovalView,
  type PayoutListQuery,
  type PayoutReadService,
} from '../../payouts/payout-reads.js';
import { createV1App } from '../app.js';
import { encodeCursor } from '../cursor.js';
import { I128_MAX } from '../../money/index.js';
import { ApiError, errorEnvelopeSchema } from '../errors.js';
import { payoutReadRoutes } from './payout-reads.js';

const CALLER: KeyCaller = {
  kind: 'key',
  ...TENANT,
  tokenId: randomUUID(),
  scopes: ['payouts:read'],
};

interface Calls {
  readonly access: Access[];
  readonly lists: { context: ProjectContext; query: PayoutListQuery }[];
  readonly gets: { context: ProjectContext; id: string }[];
  readonly approvals: {
    context: ProjectContext;
    page: { after?: string | undefined; limit: number };
    correlationId: string;
  }[];
}

const page = <T>(items: readonly T[], next: string | null = null): Page<T> => ({ items, next });

function harness(
  over: Partial<PayoutReadService> = {},
  refuse?: (access: Access) => ApiError | undefined,
) {
  const calls: Calls = { access: [], lists: [], gets: [], approvals: [] };
  const service: PayoutReadService = {
    list: (context, query) => {
      calls.lists.push({ context, query });
      return Promise.resolve(page([paidView()]));
    },
    get: (context, id) => {
      calls.gets.push({ context, id });
      return Promise.resolve(paidView({ payout: { id } }));
    },
    byTask: () => Promise.resolve(undefined),
    approvals: (context, request, correlationId) => {
      calls.approvals.push({ context, page: request, correlationId });
      return Promise.resolve(page<ApprovalView>([]));
    },
    ...over,
  };
  // Builds the check when the routes are made and records it when a request
  // runs it, as the real authenticate does.
  const authenticate = ((access: Access) => () => {
    calls.access.push(access);
    const refusal = refuse?.(access);
    return refusal === undefined ? Promise.resolve(CALLER) : Promise.reject(refusal);
  }) as Authenticate;
  const routes = payoutReadRoutes({ service, authenticate });
  const { app } = createV1App({ routes });
  const send = async (path: string) => {
    const response = await app.request(path);
    const body = (await response.json()) as Record<string, unknown>;
    return { status: response.status, headers: response.headers, body };
  };
  return { send, calls, routes };
}

function codeOf(body: Record<string, unknown>): string {
  return errorEnvelopeSchema.parse(body).error.code;
}

function detailsOf(body: Record<string, unknown>): readonly { path: string; issue: string }[] {
  return errorEnvelopeSchema.parse(body).error.details ?? [];
}

// The recorded payout, as the repository would hold it.
function recordedView(): PayoutView {
  return paidView({ payout: { id: IDS.payout }, mandateId: IDS.mandate });
}

describe('the shape the console was built against', () => {
  // Leg statuses are the leg's own (planned, submitted, settled, failed,
  // cancelled). The recording borrowed the payout's word for a paid leg.
  const recordedLeg = { ...RECORDED['GET /v1/payouts/{id}'].payout.legs[0], status: 'settled' };

  it('lists payouts as the recording does, but for the leg status', async () => {
    const { send } = harness({ list: () => Promise.resolve(page([recordedView()])) });
    const answer = await send('/v1/payouts');
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({
      items: [{ ...RECORDED['GET /v1/payouts/{id}'].payout, legs: [recordedLeg] }],
      nextCursor: null,
    });
  });

  it('adds a timeline to the detail, and nothing else', async () => {
    const { send } = harness({ get: () => Promise.resolve(recordedView()) });
    const answer = await send(`/v1/payouts/${IDS.payout}`);
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({
      payout: {
        ...RECORDED['GET /v1/payouts/{id}'].payout,
        legs: [recordedLeg],
        timeline: [
          { event: 'created', at: '2026-11-25T12:00:00.000Z', legIndex: null, txHash: null },
          { event: 'requested', at: null, legIndex: null, txHash: IDS.tx },
          { event: 'leg_settled', at: '2026-11-25T12:00:09.000Z', legIndex: 0, txHash: IDS.tx },
          { event: 'paid', at: '2026-11-25T12:00:09.000Z', legIndex: null, txHash: null },
        ],
      },
    });
  });

  it('adds what the budget has left to each waiting payout, and nothing else', async () => {
    const recorded = RECORDED['GET /v1/approvals'].items[0];
    // The recording's amount is past i128, which no Soroban amount can be, so
    // the largest one that can is used in its place.
    const largest = usdc(I128_MAX);
    const view = viewOf({
      mandateId: IDS.mandate,
      payout: {
        id: recorded.id,
        taskId: recorded.taskId,
        status: 'pending_approval',
        amount: largest,
        requestTxHash: TX,
        updatedAt: new Date(recorded.updatedAt),
      },
      legs: [{ amount: largest }],
    });
    const { send } = harness({
      approvals: () => Promise.resolve(page([{ ...view, budgetLeft: usdc(45_800_000_000n) }])),
    });
    const answer = await send('/v1/approvals');
    expect(answer.status).toBe(200);
    const amount = { ...recorded.amount, amount: I128_MAX.toString() };
    expect(answer.body).toEqual({
      items: [
        {
          ...recorded,
          amount,
          legs: [{ ...recorded.legs[0], amount, status: 'planned' }],
          budgetLeft: {
            amount: '45800000000',
            asset: 'USDC',
            network: 'stellar:testnet',
            scale: 7,
          },
        },
      ],
      nextCursor: null,
    });
  });
});

describe('GET /v1/payouts', () => {
  it('reads with payouts:read and passes every filter, combined', async () => {
    const { send, calls } = harness();
    const mandateId = randomUUID();
    const recipientId = randomUUID();
    const answer = await send(
      `/v1/payouts?status=queued,submitting,approved,settling,queued&mandateId=${mandateId}` +
        `&recipientId=${recipientId}&createdFrom=2026-11-01T00:00:00.000Z` +
        `&createdTo=2026-11-02T00:00:00%2B01:00&limit=20`,
    );
    expect(answer.status).toBe(200);
    expect(calls.access).toEqual([{ scope: 'payouts:read' }]);
    expect(calls.lists).toEqual([
      {
        context: TENANT,
        query: {
          statuses: ['queued', 'submitting', 'approved', 'settling'],
          mandateId,
          recipientId,
          createdFrom: new Date('2026-11-01T00:00:00.000Z'),
          createdTo: new Date('2026-11-01T23:00:00.000Z'),
          after: undefined,
          limit: 20,
        },
      },
    ]);
  });

  it('pages 50 at a time by default, and at most a full page when asked for 200', async () => {
    const { send, calls } = harness();
    await send('/v1/payouts');
    await send('/v1/payouts?limit=200');
    expect(calls.lists.map((call) => call.query.limit)).toEqual([50, 100]);
  });

  it('hands out a cursor that leads to the next page', async () => {
    const { send, calls } = harness({
      list: (context, query) => {
        calls.lists.push({ context, query });
        return Promise.resolve(page([paidView()], '2026-11-25T12:00:00.000000Z|' + IDS.payout));
      },
    });
    const first = await send('/v1/payouts?limit=1');
    const cursor = first.body['nextCursor'];
    expect(typeof cursor).toBe('string');
    await send(`/v1/payouts?limit=1&cursor=${String(cursor)}`);
    expect(calls.lists[1]?.query.after).toBe(`2026-11-25T12:00:00.000000Z|${IDS.payout}`);
  });

  it('masks every destination and never sends metadata back', async () => {
    const { send } = harness();
    const answer = await send('/v1/payouts');
    const text = JSON.stringify(answer.body);
    expect(text).not.toContain(WALLET);
    expect(text).toContain(`${WALLET.slice(0, 4)}...${WALLET.slice(-4)}`);
    expect(text).not.toContain('week-48');
  });

  it.each([
    ['an unknown status', 'status=sent', 'query.status'],
    ['an empty status in the list', 'status=paid,', 'query.status'],
    ['an empty status', 'status=', 'query.status'],
    ['a status in another case', 'status=PAID', 'query.status'],
    ['a filter it does not know', 'mandate=x', 'query.mandate'],
    ['a mandate that is not an id', 'mandateId=12', 'query.mandateId'],
    ['a recipient that is not an id', 'recipientId=ada', 'query.recipientId'],
    ['a date without a time', 'createdFrom=2026-11-01', 'query.createdFrom'],
    ['a limit of zero', 'limit=0', 'query.limit'],
    ['a limit past 200', 'limit=201', 'query.limit'],
    ['a cursor it never issued', 'cursor=bm90IGpzb24', 'query.cursor'],
    [
      'a cursor of the approvals queue',
      `cursor=${encodeCursor({ list: 'approvals', after: 'k' })}`,
      'query.cursor.list',
    ],
    ['a repeated filter', 'status=paid&status=queued', 'query.status'],
  ])('answers 400 to %s, before the service', async (_name, query, path) => {
    const { send, calls } = harness();
    const answer = await send(`/v1/payouts?${query}`);
    expect(answer.status).toBe(400);
    expect(codeOf(answer.body)).toBe('INVALID_REQUEST');
    expect(detailsOf(answer.body).map((detail) => detail.path)).toContain(path);
    expect(calls.lists).toEqual([]);
  });

  it('answers 400 to a range that ends where it starts or before', async () => {
    const { send, calls } = harness();
    for (const to of ['2026-11-01T00:00:00.000Z', '2026-10-31T00:00:00.000Z']) {
      const answer = await send(`/v1/payouts?createdFrom=2026-11-01T00:00:00.000Z&createdTo=${to}`);
      expect(answer.status).toBe(400);
      expect(detailsOf(answer.body)).toEqual([{ path: 'query.createdTo', issue: 'too_small' }]);
    }
    expect(calls.lists).toEqual([]);
  });

  it('answers 400 to a cursor whose key the list cannot read', async () => {
    const { send } = harness({
      list: () => Promise.reject(new PageRequestError('after is not a key this list returned')),
    });
    const answer = await send(
      `/v1/payouts?cursor=${encodeCursor({ list: 'payouts', after: 'x' })}`,
    );
    expect(answer.status).toBe(400);
    expect(detailsOf(answer.body)).toEqual([{ path: 'query.cursor', issue: 'invalid_format' }]);
  });

  it('answers 503 with Retry-After when the database is down', async () => {
    const { send } = harness({
      list: () => Promise.reject(new DatabaseUnavailableError('connection_refused')),
    });
    const answer = await send('/v1/payouts');
    expect(answer.status).toBe(503);
    expect(codeOf(answer.body)).toBe('DB_UNAVAILABLE');
    expect(answer.headers.get('retry-after')).not.toBeNull();
  });

  it('asks the service nothing when the caller is refused', async () => {
    const { send, calls } = harness({}, () => new ApiError('FORBIDDEN', 'no scope'));
    const answer = await send('/v1/payouts');
    expect(answer.status).toBe(403);
    expect(calls.lists).toEqual([]);
  });
});

describe('GET /v1/payouts/{id}', () => {
  it('reads with payouts:read, in the lower case the database writes ids in', async () => {
    const { send, calls } = harness();
    const id = randomUUID();
    const answer = await send(`/v1/payouts/${id.toUpperCase()}`);
    expect(answer.status).toBe(200);
    expect(calls.access).toEqual([{ scope: 'payouts:read' }]);
    expect(calls.gets).toEqual([{ context: TENANT, id }]);
    expect(JSON.stringify(answer.body)).not.toContain(WALLET);
  });

  it('answers 404 for a payout the project does not have', async () => {
    const { send } = harness({
      get: () => Promise.reject(new PayoutReadError('PAYOUT_NOT_FOUND', 'none')),
    });
    const answer = await send(`/v1/payouts/${randomUUID()}`);
    expect(answer.status).toBe(404);
    expect(codeOf(answer.body)).toBe('NOT_FOUND');
  });

  it('answers 400 for an id that is not one', async () => {
    const { send, calls } = harness();
    const answer = await send('/v1/payouts/42');
    expect(answer.status).toBe(400);
    expect(calls.gets).toEqual([]);
  });
});

describe('GET /v1/approvals', () => {
  it('takes a session with read access, and the request id for the chain reads', async () => {
    const { send, calls } = harness();
    const answer = await send('/v1/approvals?limit=200');
    expect(answer.status).toBe(200);
    expect(calls.access).toEqual([{ via: 'session', permission: 'read' }]);
    expect(calls.approvals).toEqual([
      {
        context: TENANT,
        page: { after: undefined, limit: 100 },
        correlationId: answer.headers.get('ujira-request-id'),
      },
    ]);
  });

  it('answers null for a budget the chain did not give', async () => {
    const view = { ...viewOf({ payout: { status: 'pending_approval' } }), budgetLeft: null };
    const { send } = harness({ approvals: () => Promise.resolve(page([view], 'k')) });
    const answer = await send('/v1/approvals');
    const body = answer.body as { items: { budgetLeft: unknown }[]; nextCursor: string };
    expect(body.items[0]?.budgetLeft).toBeNull();
    expect(body.nextCursor).toBe(encodeCursor({ list: 'approvals', after: 'k' }));
  });

  it('follows its own cursor and refuses the payout list one', async () => {
    const { send, calls } = harness();
    await send(`/v1/approvals?cursor=${encodeCursor({ list: 'approvals', after: 'k' })}`);
    expect(calls.approvals[0]?.page.after).toBe('k');
    const wrong = await send(
      `/v1/approvals?cursor=${encodeCursor({ list: 'payouts', after: 'k' })}`,
    );
    expect(wrong.status).toBe(400);
    expect(calls.approvals).toHaveLength(1);
  });

  it('refuses an API key, as the authenticate it asks for does', async () => {
    const { send, calls } = harness({}, (access) =>
      'via' in access && access.via === 'session'
        ? new ApiError('FORBIDDEN', 'This takes a dashboard session, not an API key')
        : undefined,
    );
    const answer = await send('/v1/approvals');
    expect(answer.status).toBe(403);
    expect(calls.approvals).toEqual([]);
  });

  it('answers 400 to a filter the queue does not take', async () => {
    const { send } = harness();
    const answer = await send('/v1/approvals?status=paid');
    expect(answer.status).toBe(400);
  });
});

describe('the OpenAPI document', () => {
  it('documents the three routes in a valid OpenAPI 3.1 document', async () => {
    const { send, routes } = harness();
    expect(routes.map((route) => `${route.method} ${route.path}`)).toEqual([
      'get /v1/payouts',
      'get /v1/payouts/{id}',
      'get /v1/approvals',
    ]);
    const doc = await send('/v1/openapi.json');
    const result = await new Validator().validate(doc.body);
    expect(result.errors).toBeUndefined();
    const paths = doc.body['paths'] as Record<string, Record<string, unknown>>;
    expect(Object.keys(paths['/v1/payouts'] ?? {})).toEqual(['get']);
    expect(Object.keys(paths['/v1/payouts/{id}'] ?? {})).toEqual(['get']);
    expect(Object.keys(paths['/v1/approvals'] ?? {})).toEqual(['get']);
  });
});
