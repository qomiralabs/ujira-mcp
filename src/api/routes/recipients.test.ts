// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The recipient routes in front of a service held in memory: what each route
// accepts, what it answers, which scope it asks for, and how each refusal
// reads on the wire. The service against a real database and the fake chain
// is in recipients.db.test.ts.

import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { DatabaseUnavailableError, type ProjectContext } from '../../db/index.js';
import type { PayoutMethod, Recipient, StoredSigningRequest } from '../../db/index.js';
import {
  RecipientError,
  type CreatedRecipient,
  type NewRecipientInput,
  type RecipientDetail,
  type RecipientListQuery,
  type RecipientService,
} from '../../payouts/recipients.js';
import { createV1App } from '../app.js';
import { encodeCursor } from '../cursor.js';
import { ApiError, errorEnvelopeSchema } from '../errors.js';
import { recipientApiError, recipientRoutes, type RecipientAccess } from './recipients.js';

const TENANT: ProjectContext = { principalId: randomUUID(), projectId: randomUUID() };
const MANDATE = randomUUID();
const WALLET = 'GBT7ITQKEX3Z2YWIYLPRQ5W3JLA2TJ3JTABB765ZYNG7VLX5YYUPI3DT';
const CREATED = new Date('2026-11-27T09:00:00.000Z');

function recipient(over: Partial<Recipient> = {}): Recipient {
  return {
    id: randomUUID(),
    projectId: TENANT.projectId,
    mandateId: MANDATE,
    label: 'Ada',
    recipientRef: 'a'.repeat(64),
    status: 'active',
    createdAt: CREATED,
    ...over,
  };
}

function method(recipientId: string, over: Partial<PayoutMethod> = {}): PayoutMethod {
  return {
    id: randomUUID(),
    projectId: TENANT.projectId,
    recipientId,
    method: 'stellar_wallet',
    destination: WALLET,
    verifiedAt: null,
    destinationStatus: 'receivable',
    checkedAt: CREATED,
    createdAt: CREATED,
    ...over,
  };
}

function signing(): StoredSigningRequest {
  return {
    id: randomUUID(),
    projectId: TENANT.projectId,
    mandateId: MANDATE,
    action: 'allow_recipients',
    network: 'stellar:testnet',
    signer: WALLET,
    envelope: 'AAAAAgAAAAB=',
    summary: 'Allow a wallet to be paid',
    expiresAt: new Date('2026-11-27T09:10:00.000Z'),
    mandateName: null,
    agentKeyId: null,
    submittedTxHash: null,
    submittedAt: null,
    createdAt: CREATED,
  };
}

interface Calls {
  readonly access: RecipientAccess[];
  readonly creates: NewRecipientInput[];
  readonly lists: RecipientListQuery[];
  readonly gets: string[];
  readonly contexts: ProjectContext[];
  readonly correlation: string[];
}

function harness(
  over: Partial<RecipientService> = {},
  authenticate?: (access: RecipientAccess) => Promise<ProjectContext>,
) {
  const calls: Calls = {
    access: [],
    creates: [],
    lists: [],
    gets: [],
    contexts: [],
    correlation: [],
  };
  const stored = recipient();
  const service: RecipientService = {
    create: (context, input, correlationId): Promise<CreatedRecipient> => {
      calls.contexts.push(context);
      calls.creates.push(input);
      calls.correlation.push(correlationId);
      const created = recipient({ label: input.label });
      const wallet = input.address === undefined ? null : method(created.id);
      return Promise.resolve({
        view: { recipient: created, method: wallet, email: input.email ?? null },
        signingRequest: wallet === null ? null : signing(),
      });
    },
    get: (context, id, correlationId): Promise<RecipientDetail> => {
      calls.contexts.push(context);
      calls.gets.push(id);
      calls.correlation.push(correlationId);
      return Promise.resolve({
        recipient: { ...stored, id },
        method: method(id),
        email: 'ada@example.org',
      });
    },
    list: (context, query) => {
      calls.contexts.push(context);
      calls.lists.push(query);
      const first = recipient({ label: 'One' });
      const second = recipient({ label: 'Two' });
      return Promise.resolve({
        items: [
          { recipient: first, method: method(first.id, { destinationStatus: 'no_trustline' }) },
          { recipient: second, method: null },
        ],
        next: second.id,
      });
    },
    ...over,
  };
  const routes = recipientRoutes({
    service,
    authenticate: async (_c, access) => {
      calls.access.push(access);
      return authenticate === undefined ? TENANT : authenticate(access);
    },
  });
  const { app, document } = createV1App({ routes });
  const send = async (path: string, init: RequestInit = {}) => {
    const response = await app.request(path, init);
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
  const post = (body: unknown) =>
    send('/v1/recipients', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  return { calls, send, post, document };
}

function codeOf(body: Record<string, unknown>): string {
  return errorEnvelopeSchema.parse(body).error.code;
}

describe('POST /v1/recipients', () => {
  it('creates a recipient with a wallet and answers the allow_recipients request', async () => {
    const h = harness();
    const answer = await h.post({ mandateId: MANDATE, label: '  Ada  ', address: WALLET });
    expect(answer.status).toBe(201);
    expect(h.calls.access).toEqual([{ scope: 'recipients:write', write: true }]);
    expect(h.calls.contexts).toEqual([TENANT]);
    // Labels are trimmed before the service sees them.
    expect(h.calls.creates).toEqual([{ mandateId: MANDATE, label: 'Ada', address: WALLET }]);
    const body = answer.body as {
      recipient: Record<string, unknown>;
      signingRequest: Record<string, unknown>;
    };
    expect(body.recipient).toMatchObject({
      mandateId: MANDATE,
      label: 'Ada',
      address: 'GBT7...I3DT',
      status: 'active',
      payable: true,
      createdAt: CREATED.toISOString(),
    });
    expect(body.signingRequest).toMatchObject({
      action: 'allow_recipients',
      network: 'stellar:testnet',
      xdr: 'AAAAAgAAAAB=',
      signer: WALLET,
      expiresAt: '2026-11-27T09:10:00.000Z',
    });
  });

  it('answers a null signing request for a recipient with no wallet yet', async () => {
    const h = harness();
    const answer = await h.post({ mandateId: MANDATE, label: 'Ada' });
    expect(answer.status).toBe(201);
    expect(answer.body).toMatchObject({
      recipient: { address: null, status: 'needs_wallet', payable: false },
      signingRequest: null,
    });
  });

  it('never answers the email to a create', async () => {
    const h = harness();
    const answer = await h.post({ mandateId: MANDATE, label: 'Ada', email: 'ada@example.org' });
    expect(answer.status).toBe(201);
    expect(h.calls.creates[0]?.email).toBe('ada@example.org');
    expect(JSON.stringify(answer.body)).not.toContain('ada@example.org');
  });

  it.each([
    ['no mandate', { label: 'Ada' }, 'body.mandateId'],
    ['a mandate that is not an id', { mandateId: 'm1', label: 'Ada' }, 'body.mandateId'],
    ['an empty label', { mandateId: MANDATE, label: '   ' }, 'body.label'],
    ['a label over 100 characters', { mandateId: MANDATE, label: 'a'.repeat(101) }, 'body.label'],
    ['a control character in the label', { mandateId: MANDATE, label: 'A\u0007da' }, 'body.label'],
    ['an email that is not one', { mandateId: MANDATE, label: 'Ada', email: 'ada' }, 'body.email'],
    ['an empty address', { mandateId: MANDATE, label: 'Ada', address: '' }, 'body.address'],
    ['an unknown field', { mandateId: MANDATE, label: 'Ada', memo: 'x' }, 'body.memo'],
  ])('refuses %s before asking anyone', async (_, body, path) => {
    const h = harness();
    const answer = await h.post(body);
    expect(answer.status).toBe(400);
    const parsed = errorEnvelopeSchema.parse(answer.body);
    expect(parsed.error.code).toBe('INVALID_REQUEST');
    expect(parsed.error.details?.map((d) => d.path)).toContain(path);
    expect(h.calls.creates).toEqual([]);
  });

  it.each([
    ['MANDATE_NOT_FOUND', 404, 'NOT_FOUND'],
    ['LABEL_TAKEN', 409, 'RECIPIENT_LABEL_TAKEN'],
    ['ADDRESS_INVALID', 400, 'INVALID_REQUEST'],
    ['DESTINATION_NEEDS_MEMO', 400, 'INVALID_REQUEST'],
    ['MANDATE_REFUSED', 409, 'MANDATE_REFUSED'],
    ['CHAIN_UNAVAILABLE', 503, 'CHAIN_UNAVAILABLE'],
  ] as const)('answers the service refusal %s as %i %s', async (refusal, status, code) => {
    const h = harness({
      create: () => Promise.reject(new RecipientError(refusal, 'internal words')),
    });
    const answer = await h.post({ mandateId: MANDATE, label: 'Ada', address: WALLET });
    expect(answer.status).toBe(status);
    expect(codeOf(answer.body)).toBe(code);
    expect(JSON.stringify(answer.body)).not.toContain('internal words');
    expect(JSON.stringify(answer.body)).not.toContain(WALLET);
  });

  it('answers a database outage as 503 DB_UNAVAILABLE', async () => {
    const h = harness({
      create: () => Promise.reject(new DatabaseUnavailableError('down')),
    });
    const answer = await h.post({ mandateId: MANDATE, label: 'Ada' });
    expect(answer.status).toBe(503);
    expect(codeOf(answer.body)).toBe('DB_UNAVAILABLE');
  });

  it('answers what authenticate refuses, and never reaches the service', async () => {
    const h = harness({}, () => Promise.reject(new ApiError('FORBIDDEN', 'Missing a scope')));
    const answer = await h.post({ mandateId: MANDATE, label: 'Ada' });
    expect(answer.status).toBe(403);
    expect(codeOf(answer.body)).toBe('FORBIDDEN');
    expect(h.calls.creates).toEqual([]);
  });

  it('passes the request id on as the correlation id', async () => {
    const h = harness();
    await h.post({ mandateId: MANDATE, label: 'Ada' });
    expect(h.calls.correlation[0]).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('GET /v1/recipients', () => {
  it('lists with masked addresses, why each cannot be paid, and no email', async () => {
    const h = harness();
    const answer = await h.send('/v1/recipients');
    expect(answer.status).toBe(200);
    expect(h.calls.access).toEqual([{ scope: 'recipients:read', write: false }]);
    expect(h.calls.lists).toEqual([{ mandateId: undefined, after: undefined, limit: 50 }]);
    const body = answer.body as { items: Record<string, unknown>[]; nextCursor: string };
    expect(body.items.map((item) => [item['status'], item['payable'], item['address']])).toEqual([
      ['no_trustline', false, 'GBT7...I3DT'],
      ['needs_wallet', false, null],
    ]);
    expect(body.items.every((item) => !('email' in item))).toBe(true);
    expect(typeof body.nextCursor).toBe('string');
  });

  it('passes the mandate, the limit and the cursor it issued back to the service', async () => {
    const h = harness();
    const after = randomUUID();
    const cursor = encodeCursor({ after });
    const answer = await h.send(`/v1/recipients?mandateId=${MANDATE}&limit=7&cursor=${cursor}`);
    expect(answer.status).toBe(200);
    expect(h.calls.lists).toEqual([{ mandateId: MANDATE, after, limit: 7 }]);
  });

  it.each([
    ['a limit of 0', 'limit=0'],
    ['a limit over 100', 'limit=101'],
    ['a limit that is not a number', 'limit=ten'],
    ['a mandate that is not an id', 'mandateId=abc'],
    ['a cursor it did not issue', `cursor=${encodeCursor({ after: 'not-an-id' })}`],
    ['a cursor that is not one', 'cursor=%25%25'],
    ['an unknown parameter', 'status=active'],
  ])('refuses %s', async (_, query) => {
    const h = harness();
    const answer = await h.send(`/v1/recipients?${query}`);
    expect(answer.status).toBe(400);
    expect(codeOf(answer.body)).toBe('INVALID_REQUEST');
    expect(h.calls.lists).toEqual([]);
  });

  it('answers the last page with a null cursor', async () => {
    const h = harness({ list: () => Promise.resolve({ items: [], next: null }) });
    const answer = await h.send('/v1/recipients');
    expect(answer.body).toEqual({ items: [], nextCursor: null });
  });
});

describe('GET /v1/recipients/{id}', () => {
  it('answers one recipient, wrapped, with its email', async () => {
    const h = harness();
    const id = randomUUID();
    const answer = await h.send(`/v1/recipients/${id}`);
    expect(answer.status).toBe(200);
    expect(h.calls.access).toEqual([{ scope: 'recipients:read', write: false }]);
    expect(h.calls.gets).toEqual([id]);
    expect(answer.body).toEqual({
      recipient: {
        id,
        mandateId: MANDATE,
        label: 'Ada',
        address: 'GBT7...I3DT',
        status: 'active',
        payable: true,
        createdAt: CREATED.toISOString(),
        email: 'ada@example.org',
      },
    });
  });

  it('answers 404 for a recipient the service does not find', async () => {
    const h = harness({
      get: () => Promise.reject(new RecipientError('RECIPIENT_NOT_FOUND', 'gone')),
    });
    const answer = await h.send(`/v1/recipients/${randomUUID()}`);
    expect(answer.status).toBe(404);
    expect(codeOf(answer.body)).toBe('NOT_FOUND');
  });

  it('refuses an id that is not one', async () => {
    const h = harness();
    const answer = await h.send('/v1/recipients/abc');
    expect(answer.status).toBe(400);
    expect(h.calls.gets).toEqual([]);
  });

  it('shows a suspended recipient as not payable whatever its wallet', async () => {
    const h = harness({
      get: (_c, id) =>
        Promise.resolve({
          recipient: recipient({ id, status: 'suspended' }),
          method: method(id),
          email: null,
        }),
    });
    const answer = await h.send(`/v1/recipients/${randomUUID()}`);
    expect(answer.body).toMatchObject({
      recipient: { status: 'suspended', payable: false, email: null },
    });
  });
});

describe('the OpenAPI document', () => {
  it('lists the three routes with the codes they can answer', () => {
    const { document } = harness();
    const paths = document.paths as Record<string, Record<string, { responses: object }>>;
    expect(Object.keys(paths['/v1/recipients'] ?? {}).sort()).toEqual(['get', 'post']);
    expect(Object.keys(paths['/v1/recipients/{id}'] ?? {})).toEqual(['get']);
    const created = paths['/v1/recipients']?.['post']?.responses as Record<string, unknown>;
    expect(Object.keys(created)).toEqual(
      expect.arrayContaining(['201', '400', '401', '403', '404', '409', '503']),
    );
  });
});

describe('recipientApiError', () => {
  it('leaves anything it does not know as it is, to surface as INTERNAL', () => {
    const other = new Error('boom');
    expect(recipientApiError(other)).toBe(other);
  });

  it('names the spec error of a refusal in the details, and a plain refusal without one', () => {
    const named = recipientApiError(
      new RecipientError('MANDATE_REFUSED', 'x', { specError: 'MANDATE_REVOKED' }),
    ) as ApiError;
    expect(named.details).toEqual([{ path: 'mandate', issue: 'mandate_revoked' }]);
    const plain = recipientApiError(new RecipientError('MANDATE_REFUSED', 'x')) as ApiError;
    expect(plain.details).toEqual([{ path: 'mandate', issue: 'refused' }]);
  });
});
