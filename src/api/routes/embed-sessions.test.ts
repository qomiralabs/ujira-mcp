// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The embed session and origin routes in front of a service held in memory
// and the real authenticate over a key store stub: what each route accepts,
// what it answers, which scope it needs, and how each refusal reads. The
// service on a real database is in test/embed.db.test.ts.

import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { ApiScope } from '../../auth/scopes.js';
import type { TokenAuthenticator } from '../../auth/token-auth.js';
import type { EmbedSession, ProjectContext } from '../../db/index.js';
import {
  EmbedError,
  type EmbedSessionService,
  type NewSessionInput,
  type SessionListQuery,
} from '../../identity/embed.js';
import { createV1App } from '../app.js';
import { createAuthenticate } from '../authenticate.js';
import { decodeCursor, encodeCursor } from '../cursor.js';
import { errorEnvelopeSchema } from '../errors.js';
import { embedSessionApiError, embedSessionRoutes } from './embed-sessions.js';

const TENANT: ProjectContext = { principalId: randomUUID(), projectId: randomUUID() };
const KEY = 'Bearer ujk_test_stub';
const NOW = new Date('2026-11-27T12:00:00.000Z');

interface Calls {
  readonly creates: NewSessionInput[];
  readonly lists: SessionListQuery[];
  readonly revokes: string[];
  readonly origins: (readonly string[])[];
  readonly tenants: ProjectContext[];
}

function session(over: Partial<EmbedSession> = {}): EmbedSession {
  return {
    id: randomUUID(),
    projectId: TENANT.projectId,
    recipientId: randomUUID(),
    expiresAt: new Date(NOW.getTime() + 1_800_000),
    revokedAt: null,
    createdAt: NOW,
    ...over,
  };
}

function harness(
  over: Partial<EmbedSessionService> = {},
  scopes: readonly ApiScope[] = ['recipients:read', 'recipients:write'],
) {
  const calls: Calls = { creates: [], lists: [], revokes: [], origins: [], tenants: [] };
  let issued = 0;
  const service: EmbedSessionService = {
    create: (context, input) => {
      calls.tenants.push(context);
      calls.creates.push(input);
      issued += 1;
      return Promise.resolve({
        session: session({
          recipientId: input.recipientId,
          expiresAt: new Date(NOW.getTime() + input.expiresInSeconds * 1000),
        }),
        token: `ujes_test_${'a'.repeat(58)}${String(issued % 10)}`,
      });
    },
    list: (context, query) => {
      calls.tenants.push(context);
      calls.lists.push(query);
      return Promise.resolve({ items: [session(), session()], next: null });
    },
    revoke: (context, id) => {
      calls.tenants.push(context);
      calls.revokes.push(id);
      return Promise.resolve(session({ id, revokedAt: NOW }));
    },
    allowedOrigins: (context) => {
      calls.tenants.push(context);
      return Promise.resolve(['https://shop.example.com']);
    },
    setAllowedOrigins: (context, origins) => {
      calls.tenants.push(context);
      calls.origins.push(origins);
      return Promise.resolve([...new Set(origins)]);
    },
    ...over,
  };
  const tokens: TokenAuthenticator = {
    authenticate: () =>
      Promise.resolve({
        ok: true,
        tenant: { ...TENANT, tokenId: randomUUID(), prefix: 'ujk_test_stub', scopes: [...scopes] },
      }),
    forget: () => undefined,
  };
  const { app } = createV1App({
    routes: embedSessionRoutes({ service, authenticate: createAuthenticate({ tokens }) }),
  });
  const send = async (method: string, path: string, body?: unknown, auth = true) => {
    const response = await app.request(path, {
      method,
      headers: {
        ...(auth ? { authorization: KEY } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const json: unknown = await response.json();
    return { status: response.status, headers: response.headers, body: json };
  };
  return { calls, send };
}

function codeOf(body: unknown): string {
  return errorEnvelopeSchema.parse(body).error.code;
}

describe('POST /v1/embed/sessions', () => {
  it('makes a session for a recipient, 30 minutes by default, and hands the token over once', async () => {
    const { calls, send } = harness();
    const recipientId = randomUUID();
    const answer = await send('POST', '/v1/embed/sessions', { recipientId });
    expect(answer.status).toBe(201);
    expect(calls.creates).toEqual([{ recipientId, expiresInSeconds: 1800 }]);
    expect(calls.tenants).toEqual([TENANT]);
    expect(answer.body).toMatchObject({
      session: { recipientId, revokedAt: null, expiresAt: '2026-11-27T12:30:00.000Z' },
      token: expect.stringMatching(/^ujes_test_/) as unknown,
    });
  });

  it('takes a lifetime from 5 minutes to 7 days and nothing outside it', async () => {
    const { calls, send } = harness();
    const recipientId = randomUUID();
    for (const seconds of [300, 3600, 604_800]) {
      expect(
        (await send('POST', '/v1/embed/sessions', { recipientId, expiresInSeconds: seconds }))
          .status,
      ).toBe(201);
    }
    for (const seconds of [299, 604_801, 1.5, '3600']) {
      const answer = await send('POST', '/v1/embed/sessions', {
        recipientId,
        expiresInSeconds: seconds,
      });
      expect(answer.status).toBe(400);
      expect(codeOf(answer.body)).toBe('INVALID_REQUEST');
    }
    expect(calls.creates.map((c) => c.expiresInSeconds)).toEqual([300, 3600, 604_800]);
  });

  it('refuses a body with anything else in it, or no recipient', async () => {
    const { calls, send } = harness();
    for (const body of [{}, { recipientId: 'nope' }, { recipientId: randomUUID(), origin: 'x' }]) {
      expect((await send('POST', '/v1/embed/sessions', body)).status).toBe(400);
    }
    expect(calls.creates).toEqual([]);
  });

  it('is not replayed: the same request twice makes two sessions and two tokens', async () => {
    const { calls, send } = harness();
    const body = { recipientId: randomUUID() };
    const first = await send('POST', '/v1/embed/sessions', body);
    const second = await send('POST', '/v1/embed/sessions', body);
    expect(calls.creates).toHaveLength(2);
    expect((first.body as { token: string }).token).not.toBe(
      (second.body as { token: string }).token,
    );
    expect(first.headers.get('idempotent-replayed')).toBeNull();
  });

  it('needs the recipients write scope, and a caller', async () => {
    const reader = harness({}, ['recipients:read']);
    const refused = await reader.send('POST', '/v1/embed/sessions', { recipientId: randomUUID() });
    expect(refused.status).toBe(403);
    expect(codeOf(refused.body)).toBe('FORBIDDEN');
    expect(reader.calls.creates).toEqual([]);
    const nobody = harness();
    const anonymous = await nobody.send(
      'POST',
      '/v1/embed/sessions',
      { recipientId: randomUUID() },
      false,
    );
    expect(anonymous.status).toBe(401);
    expect(codeOf(anonymous.body)).toBe('SESSION_INVALID');
  });

  it('answers 404 for a recipient it cannot see and 403 for one on hold', async () => {
    const missing = harness({
      create: () => Promise.reject(new EmbedError('RECIPIENT_NOT_FOUND', 'x')),
    });
    const notFound = await missing.send('POST', '/v1/embed/sessions', {
      recipientId: randomUUID(),
    });
    expect([notFound.status, codeOf(notFound.body)]).toEqual([404, 'NOT_FOUND']);
    const held = harness({
      create: () => Promise.reject(new EmbedError('RECIPIENT_SUSPENDED', 'x')),
    });
    const forbidden = await held.send('POST', '/v1/embed/sessions', { recipientId: randomUUID() });
    expect([forbidden.status, codeOf(forbidden.body)]).toEqual([403, 'FORBIDDEN']);
  });
});

describe('GET /v1/embed/sessions', () => {
  it('lists newest first with the filters and page size passed on, and no token', async () => {
    const { calls, send } = harness({
      list: (_context, query) => {
        calls.lists.push(query);
        return Promise.resolve({
          items: [session()],
          next: '2026-11-27T12:00:00.123456Z|0b8f2a3c-1d2e-4f50-8a6b-7c8d9e0f1a2b',
        });
      },
    });
    const recipientId = randomUUID();
    const answer = await send('GET', `/v1/embed/sessions?recipientId=${recipientId}&limit=100`);
    expect(answer.status).toBe(200);
    const body = answer.body as { items: Record<string, unknown>[]; nextCursor: string };
    expect(Object.keys(body.items[0] ?? {}).sort()).toEqual([
      'createdAt',
      'expiresAt',
      'id',
      'recipientId',
      'revokedAt',
    ]);
    expect(calls.lists).toEqual([{ recipientId, after: undefined, limit: 100 }]);
    const next = await send('GET', `/v1/embed/sessions?cursor=${body.nextCursor}`);
    expect(next.status).toBe(200);
    expect(calls.lists[1]).toEqual({
      recipientId: undefined,
      after: '2026-11-27T12:00:00.123456Z|0b8f2a3c-1d2e-4f50-8a6b-7c8d9e0f1a2b',
      limit: 50,
    });
    expect(decodeCursor(body.nextCursor, z.object({ after: z.string() })).after).toContain('|');
  });

  it('refuses a cursor it did not issue and a limit past 100', async () => {
    const { calls, send } = harness();
    for (const query of [
      `cursor=${encodeCursor({ after: 'drop table' })}`,
      'cursor=***',
      'limit=101',
      'limit=0',
      'recipientId=nope',
    ]) {
      expect((await send('GET', `/v1/embed/sessions?${query}`)).status).toBe(400);
    }
    expect(calls.lists).toEqual([]);
  });
});

describe('DELETE /v1/embed/sessions/{id}', () => {
  it('revokes and answers the session, and a repeat answers the same', async () => {
    const { calls, send } = harness();
    const id = randomUUID();
    const answer = await send('DELETE', `/v1/embed/sessions/${id}`);
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ session: { id, revokedAt: NOW.toISOString() } });
    expect((await send('DELETE', `/v1/embed/sessions/${id}`)).status).toBe(200);
    expect(calls.revokes).toEqual([id, id]);
  });

  it('answers 404 for a session it cannot see', async () => {
    const { send } = harness({
      revoke: () => Promise.reject(new EmbedError('SESSION_NOT_FOUND', 'x')),
    });
    const answer = await send('DELETE', `/v1/embed/sessions/${randomUUID()}`);
    expect([answer.status, codeOf(answer.body)]).toEqual([404, 'NOT_FOUND']);
  });
});

describe('/v1/embed/origins', () => {
  it('reads and replaces the project list', async () => {
    const { calls, send } = harness();
    expect((await send('GET', '/v1/embed/origins')).body).toEqual({
      origins: ['https://shop.example.com'],
    });
    const origins = [
      'https://shop.example.com',
      'https://pay.example.com:8443',
      'http://localhost:5173',
    ];
    const answer = await send('PUT', '/v1/embed/origins', { origins });
    expect(answer.status).toBe(200);
    expect(calls.origins).toEqual([origins]);
    expect((await send('PUT', '/v1/embed/origins', { origins: [] })).status).toBe(200);
  });

  it('takes only an origin exactly as a browser sends it, and at most 10', async () => {
    const { calls, send } = harness();
    for (const bad of [
      'http://shop.example.com',
      'https://shop.example.com/',
      'https://shop.example.com/pay',
      'https://Shop.example.com',
      'https://shop.example.com:443',
      'https://user@shop.example.com',
      'https://[::1]',
      'shop.example.com',
      'javascript:alert(1)',
      '*',
    ]) {
      const answer = await send('PUT', '/v1/embed/origins', { origins: [bad] });
      expect(answer.status, bad).toBe(400);
    }
    const eleven = Array.from({ length: 11 }, (_, i) => `https://s${String(i)}.example.com`);
    expect((await send('PUT', '/v1/embed/origins', { origins: eleven })).status).toBe(400);
    expect(calls.origins).toEqual([]);
  });

  it('needs the write scope to change the list', async () => {
    const { calls, send } = harness({}, ['recipients:read']);
    expect((await send('GET', '/v1/embed/origins')).status).toBe(200);
    expect((await send('PUT', '/v1/embed/origins', { origins: [] })).status).toBe(403);
    expect(calls.origins).toEqual([]);
  });
});

describe('embedSessionApiError', () => {
  it('passes anything that is not the service refusing through as it is', () => {
    const other = new Error('boom');
    expect(embedSessionApiError(other)).toBe(other);
    const chain = new EmbedError('CHAIN_UNAVAILABLE', 'x');
    expect(embedSessionApiError(chain)).toBe(chain);
  });
});
