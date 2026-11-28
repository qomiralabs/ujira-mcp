// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The receipt routes in front of a service held in memory: the filters each
// route accepts, the scope it asks for, the shapes the console reads, the
// streamed CSV, and how each refusal reads on the wire.

import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { IDS, blockedReceipt, paidReceipt } from '../../../test/receipt-fixtures.js';
import { ChainError } from '../../chain/adapter.js';
import {
  DatabaseUnavailableError,
  PageRequestError,
  type Page,
  type ProjectContext,
  type ReceiptDetail,
  type ReceiptFilter,
} from '../../db/index.js';
import { ReceiptNetworkNotServedError, ReceiptNotFoundError } from '../../receipts/errors.js';
import { csvHeader, csvRow } from '../../receipts/export.js';
import type { ReceiptView } from '../../receipts/model.js';
import type { ReceiptQuery, ReceiptService } from '../../receipts/service.js';
import type { Verification } from '../../receipts/verify.js';
import { createV1App } from '../app.js';
import type { Access, Authenticate, Caller } from '../authenticate.js';
import { decodeCursor } from '../cursor.js';
import { ApiError, errorEnvelopeSchema } from '../errors.js';
import { receiptRoutes } from './receipts.js';
import { z } from 'zod';

const TENANT: ProjectContext = { principalId: IDS.principal, projectId: IDS.project };

interface Behaviour {
  list?: (query: ReceiptQuery) => Promise<Page<ReceiptView>>;
  get?: (id: string) => Promise<ReceiptView>;
  exportCsv?: (filter: ReceiptFilter) => AsyncIterable<string>;
  verify?: (id: string) => Promise<Verification>;
  authenticate?: () => Promise<Caller>;
}

// The chunks in order, then the error if there is one, as a page read would fail.
function chunks(list: readonly string[], error?: Error): AsyncIterable<string> {
  return {
    [Symbol.asyncIterator]() {
      let at = 0;
      return {
        next: (): Promise<IteratorResult<string>> => {
          const value = list[at];
          at += 1;
          if (value !== undefined) return Promise.resolve({ done: false, value });
          if (error !== undefined) return Promise.reject(error);
          return Promise.resolve({ done: true, value: undefined });
        },
      };
    },
  };
}

function harness(behaviour: Behaviour = {}) {
  const queries: ReceiptQuery[] = [];
  const filters: ReceiptFilter[] = [];
  const callers: ProjectContext[] = [];
  const scopes: string[] = [];
  const service: ReceiptService = {
    details: () => Promise.resolve<Page<ReceiptDetail>>({ items: [], next: null }),
    list: (context, query) => {
      callers.push(context);
      queries.push(query);
      return (behaviour.list ?? (() => Promise.resolve({ items: [paidReceipt()], next: null })))(
        query,
      );
    },
    get: (context, id) => {
      callers.push(context);
      return (behaviour.get ?? (() => Promise.resolve(paidReceipt())))(id);
    },
    exportCsv: (context, filter) => {
      callers.push(context);
      filters.push(filter);
      return (
        behaviour.exportCsv ??
        (() => chunks([csvHeader(), csvRow(paidReceipt()), csvRow(blockedReceipt())]))
      )(filter);
    },
    verify: (context, id) => {
      callers.push(context);
      return (
        behaviour.verify ??
        (() => Promise.resolve({ matched: true, field: null, txHash: paidReceipt().txHash }))
      )(id);
    },
  };
  const authenticate = ((access: Access) => async () => {
    scopes.push('scope' in access ? access.scope : access.permission);
    if (behaviour.authenticate !== undefined) return behaviour.authenticate();
    return { kind: 'key', ...TENANT, tokenId: randomUUID(), scopes: [] } satisfies Caller;
  }) as Authenticate;
  const { app } = createV1App({ routes: receiptRoutes({ service, authenticate }) });
  return {
    queries,
    filters,
    callers,
    scopes,
    get: (path: string) => app.request(path, { method: 'GET' }),
  };
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

describe('GET /v1/receipts', () => {
  it('lists with payouts:read, in the shape the console reads', async () => {
    const h = harness();
    const response = await h.get('/v1/receipts');
    expect(response.status).toBe(200);
    const body = await json(response);
    expect(body['nextCursor']).toBeNull();
    expect(body['items']).toEqual([
      expect.objectContaining({
        id: IDS.receipt,
        payoutId: IDS.payout,
        mandate: { id: IDS.mandate, contractId: paidReceipt().mandate.contractId },
        recipient: expect.objectContaining({ id: IDS.recipient, label: 'Ada' }) as unknown,
        outcome: 'paid',
        blockedBy: null,
        issuedAt: '2026-11-25T12:00:10.000Z',
      }),
    ]);
    expect(h.scopes).toEqual(['payouts:read']);
    expect(h.callers).toEqual([TENANT]);
    expect(h.queries).toEqual([{ limit: 50 }]);
  });

  it('reads every filter, with the times as the issue window', async () => {
    const h = harness();
    const mandate = randomUUID();
    const recipient = randomUUID();
    const response = await h.get(
      `/v1/receipts?status=paid,blocked&mandateId=${mandate}&recipientId=${recipient}&createdFrom=2026-11-01T00:00:00.000Z&createdTo=2026-12-01T00:00:00%2B01:00&limit=200`,
    );
    expect(response.status).toBe(200);
    expect(h.queries).toEqual([
      {
        statuses: ['paid', 'blocked'],
        mandateId: mandate,
        recipientId: recipient,
        issuedFrom: new Date('2026-11-01T00:00:00.000Z'),
        issuedTo: new Date('2026-11-30T23:00:00.000Z'),
        // The console asks for 200; a page holds at most 100.
        limit: 100,
      },
    ]);
  });

  it('refuses a status that is not final, a bad id and a limit past 200', async () => {
    const h = harness();
    for (const query of [
      'status=queued',
      'status=paid,,blocked',
      'mandateId=nope',
      'limit=201',
      'limit=0',
      'createdFrom=yesterday',
      'unknown=1',
    ]) {
      const response = await h.get(`/v1/receipts?${query}`);
      expect(response.status, query).toBe(400);
      expect(errorEnvelopeSchema.parse(await response.json()).error.code).toBe('INVALID_REQUEST');
    }
    expect(h.queries).toEqual([]);
  });

  it('pages with a cursor it issued, and refuses one it did not', async () => {
    const key = '2026-11-25T12:00:10.000000Z|3c2b1a0f-9e8d-4c7b-8a6f-5e4d3c2b1a0f';
    const h = harness({ list: () => Promise.resolve({ items: [paidReceipt()], next: key }) });
    const first = await json(await h.get('/v1/receipts'));
    const cursor = first['nextCursor'] as string;
    expect(decodeCursor(cursor, z.object({ after: z.string() }))).toEqual({ after: key });
    await h.get(`/v1/receipts?cursor=${cursor}`);
    expect(h.queries[1]).toEqual({ limit: 50, after: key });
    const forged = harness({
      list: () => Promise.reject(new PageRequestError('after is not a key this list returned')),
    });
    const refused = await forged.get(`/v1/receipts?cursor=${cursor}`);
    expect(refused.status).toBe(400);
  });

  it('answers 503 with Retry-After while the database is down', async () => {
    const h = harness({ list: () => Promise.reject(new DatabaseUnavailableError('down')) });
    const response = await h.get('/v1/receipts');
    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).toBe('5');
    expect(errorEnvelopeSchema.parse(await response.json()).error.code).toBe('DB_UNAVAILABLE');
  });

  it('answers what authenticate refuses, before reading anything', async () => {
    const h = harness({
      authenticate: () => Promise.reject(new ApiError('FORBIDDEN', 'no scope')),
    });
    const response = await h.get('/v1/receipts');
    expect(response.status).toBe(403);
    expect(h.queries).toEqual([]);
  });
});

describe('GET /v1/receipts/{id}', () => {
  it('answers one receipt, wrapped', async () => {
    const h = harness({ get: () => Promise.resolve(blockedReceipt()) });
    const response = await h.get(`/v1/receipts/${IDS.receipt.toUpperCase()}`);
    expect(response.status).toBe(200);
    const body = (await json(response))['receipt'] as Record<string, unknown>;
    expect(body).toMatchObject({
      outcome: 'blocked',
      blockedBy: 'PER_PAYMENT_CAP_EXCEEDED',
      txHash: null,
      ref: null,
    });
  });

  it('is not found for another tenant receipt, as for none', async () => {
    const h = harness({ get: () => Promise.reject(new ReceiptNotFoundError()) });
    const response = await h.get(`/v1/receipts/${randomUUID()}`);
    expect(response.status).toBe(404);
    expect(errorEnvelopeSchema.parse(await response.json()).error.code).toBe('NOT_FOUND');
  });
});

describe('GET /v1/receipts/export.csv', () => {
  it('streams the filtered set as CSV, not read as a receipt id', async () => {
    const h = harness();
    const response = await h.get('/v1/receipts/export.csv?status=paid');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/^text\/csv\b/);
    expect(response.headers.get('content-disposition')).toBe('attachment; filename="receipts.csv"');
    const text = await response.text();
    expect(text).toBe(csvHeader() + csvRow(paidReceipt()) + csvRow(blockedReceipt()));
    expect(h.filters).toEqual([{ statuses: ['paid'] }]);
    expect(h.scopes).toEqual(['payouts:read']);
  });

  it('answers an error envelope when the first page fails', async () => {
    const h = harness({
      exportCsv: () => chunks([], new DatabaseUnavailableError('down')),
    });
    const response = await h.get('/v1/receipts/export.csv');
    expect(response.status).toBe(503);
    expect(errorEnvelopeSchema.parse(await response.json()).error.code).toBe('DB_UNAVAILABLE');
  });

  it('cuts the download short when a later page fails, never ending it cleanly', async () => {
    const h = harness({
      exportCsv: () => chunks([csvHeader()], new DatabaseUnavailableError('down')),
    });
    const response = await h.get('/v1/receipts/export.csv');
    expect(response.status).toBe(200);
    await expect(response.text()).rejects.toThrow();
  });

  it('refuses a filter it does not know', async () => {
    const h = harness();
    expect((await h.get('/v1/receipts/export.csv?limit=5')).status).toBe(400);
    expect(h.filters).toEqual([]);
  });
});

describe('GET /v1/receipts/{id}/verify', () => {
  it('answers matched, field and txHash', async () => {
    const h = harness({
      verify: () => Promise.resolve({ matched: false, field: 'amount', txHash: 'a'.repeat(64) }),
    });
    const response = await h.get(`/v1/receipts/${IDS.receipt}/verify`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      matched: false,
      field: 'amount',
      txHash: 'a'.repeat(64),
    });
  });

  it('answers 503 when the chain cannot be read, never a mismatch', async () => {
    for (const error of [
      new ChainError('TIMEOUT', 'slow'),
      new ChainError('UNAVAILABLE', 'down'),
      new ReceiptNetworkNotServedError(),
    ]) {
      const h = harness({ verify: () => Promise.reject(error) });
      const response = await h.get(`/v1/receipts/${IDS.receipt}/verify`);
      expect(response.status).toBe(503);
      expect(errorEnvelopeSchema.parse(await response.json()).error.code).toBe('CHAIN_UNAVAILABLE');
    }
  });
});
