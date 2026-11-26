// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The /v1 building blocks on their own: error codes and details, cursors,
// route definitions that must be refused at start, and the app without the
// Node server in front of it.

import { HTTPException } from 'hono/http-exception';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createV1App } from '../src/api/app.js';
import { isJsonMediaType, readBodyText } from '../src/api/body.js';
import { decodeCursor, encodeCursor, MAX_CURSOR_LENGTH } from '../src/api/cursor.js';
import {
  API_ERROR_CODES,
  API_ERROR_STATUS,
  ApiError,
  envelope,
  errorEnvelopeSchema,
  validationDetails,
} from '../src/api/errors.js';
import { buildOpenApi } from '../src/api/openapi.js';
import { defineRoute, honoPath, pathParams } from '../src/api/route.js';

const ok = z.object({ ok: z.boolean() }).strict();

describe('error codes', () => {
  it('maps every code in the API design to its one status', () => {
    expect(API_ERROR_STATUS).toEqual({
      INVALID_REQUEST: 400,
      IDEMPOTENCY_KEY_REQUIRED: 400,
      IDEMPOTENCY_KEY_INVALID: 400,
      TOKEN_MALFORMED: 401,
      TOKEN_INVALID: 401,
      SESSION_INVALID: 401,
      FORBIDDEN: 403,
      ORIGIN_NOT_ALLOWED: 403,
      NOT_FOUND: 404,
      IDEMPOTENCY_IN_PROGRESS: 409,
      TASK_ID_REUSED: 409,
      PAYLOAD_TOO_LARGE: 413,
      UNSUPPORTED_MEDIA_TYPE: 415,
      IDEMPOTENCY_KEY_REUSED: 422,
      RATE_LIMITED: 429,
      INTERNAL: 500,
      CHAIN_UNAVAILABLE: 503,
      DB_UNAVAILABLE: 503,
    });
    expect(API_ERROR_CODES).toHaveLength(18);
    expect(new ApiError('RATE_LIMITED', 'slow down').status).toBe(429);
  });

  it('builds the envelope, leaving out empty details', () => {
    expect(envelope('NOT_FOUND', 'gone', 'r1')).toEqual({
      error: { code: 'NOT_FOUND', message: 'gone', requestId: 'r1' },
    });
    expect(envelope('NOT_FOUND', 'gone', 'r1', [])).toEqual({
      error: { code: 'NOT_FOUND', message: 'gone', requestId: 'r1' },
    });
    const withDetails = envelope('INVALID_REQUEST', 'bad', 'r2', [{ path: 'a', issue: 'b' }]);
    expect(errorEnvelopeSchema.parse(withDetails)).toEqual(withDetails);
  });

  it('keeps details to paths and issue codes, bounded in count and length', () => {
    const schema = z.object({ items: z.array(z.object({ n: z.number() })) }).strict();
    const parsed = schema.safeParse({
      items: Array.from({ length: 30 }, () => ({ n: 'SECRETVALUE' })),
      ['k'.repeat(200)]: 1,
    });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    const details = validationDetails(parsed.error, 'body');
    expect(details).toHaveLength(20);
    expect(details[0]).toEqual({ path: 'body.items.0.n', issue: 'invalid_type' });
    expect(JSON.stringify(details)).not.toContain('SECRETVALUE');
    const root = validationDetails(z.string().safeParse(1).error as z.ZodError, '');
    expect(root).toEqual([{ path: '', issue: 'invalid_type' }]);
    const long = validationDetails(
      z
        .object({})
        .strict()
        .safeParse({ ['k'.repeat(200)]: 1 }).error as z.ZodError,
      'body',
    );
    expect(long[0]?.path).toBe(`body.${'k'.repeat(64)}...`);
  });
});

describe('cursors', () => {
  const schema = z.object({ createdAt: z.iso.datetime(), id: z.uuid() }).strict();
  const value = {
    createdAt: '2026-11-26T10:00:00.000Z',
    id: '0b8f6f2e-6f1a-4c2b-9d3e-1a2b3c4d5e6f',
  };

  it('round trips through an opaque url safe string', () => {
    const cursor = encodeCursor(value);
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeCursor(cursor, schema)).toEqual(value);
  });

  it('refuses anything it did not issue as INVALID_REQUEST at query.cursor', () => {
    const bad = [
      '',
      'not base64!',
      'x'.repeat(MAX_CURSOR_LENGTH + 1),
      Buffer.from('not json').toString('base64url'),
      encodeCursor({ createdAt: 'yesterday', id: value.id }),
    ];
    for (const raw of bad) {
      let caught: unknown;
      try {
        decodeCursor(raw, schema);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ApiError);
      expect((caught as ApiError).code).toBe('INVALID_REQUEST');
      expect((caught as ApiError).details?.[0]?.path).toMatch(/^query\.cursor/);
    }
  });

  it('will not issue a cursor past the limit', () => {
    expect(() => encodeCursor({ big: 'x'.repeat(MAX_CURSOR_LENGTH) })).toThrow(/limit/);
  });
});

describe('bodies', () => {
  it('knows JSON media types', () => {
    expect(isJsonMediaType('application/json')).toBe(true);
    expect(isJsonMediaType('Application/JSON; charset=utf-8')).toBe(true);
    expect(isJsonMediaType('application/json-patch+json')).toBe(false);
    expect(isJsonMediaType('text/plain')).toBe(false);
    expect(isJsonMediaType(undefined)).toBe(false);
    expect(isJsonMediaType(null)).toBe(false);
  });

  it('reads an absent body as empty', async () => {
    expect(await readBodyText(new Request('http://x/'))).toBe('');
  });
});

describe('route definitions', () => {
  const base = {
    method: 'get' as const,
    summary: 's',
    response: ok,
    handler: () => ({ ok: true }),
  };

  it('converts paths and finds their params', () => {
    expect(honoPath('/v1/mandates/{id}/actions/{actionId}')).toBe(
      '/v1/mandates/:id/actions/:actionId',
    );
    expect(pathParams('/v1/mandates/{id}/actions/{actionId}')).toEqual(['id', 'actionId']);
  });

  it('refuses a route that is wrong by construction', () => {
    expect(() => defineRoute({ ...base, path: '/v1/x', operationId: 'Bad' })).toThrow(/camel/);
    expect(() => defineRoute({ ...base, path: '/api/x', operationId: 'a' })).toThrow(/path/);
    expect(() => defineRoute({ ...base, path: '/v1', operationId: 'a' })).toThrow(/path/);
    expect(() => defineRoute({ ...base, path: '/v1/Upper', operationId: 'a' })).toThrow(/path/);
    expect(() => defineRoute({ ...base, path: '/v1/x/{id}', operationId: 'a' })).toThrow(/params/);
    expect(() =>
      defineRoute({
        ...base,
        path: '/v1/x',
        operationId: 'a',
        params: z.object({ id: z.string() }),
      }),
    ).toThrow(/params/);
    expect(() =>
      defineRoute({ ...base, path: '/v1/x', operationId: 'a', body: z.object({}) }),
    ).toThrow(/GET takes no body/);
  });

  it('refuses two routes on one operation or one operation id', () => {
    const a = defineRoute({ ...base, path: '/v1/x', operationId: 'a' });
    const b = defineRoute({ ...base, path: '/v1/x', operationId: 'b' });
    const c = defineRoute({ ...base, path: '/v1/y', operationId: 'a' });
    const info = { title: 't', version: '1' };
    expect(() => buildOpenApi([a, b], info)).toThrow(/two routes answer GET \/v1\/x/);
    expect(() => buildOpenApi([a, c], info)).toThrow(/share the operationId a/);
    expect(() => createV1App({ routes: [a, a] })).toThrow();
  });

  it('refuses at start a schema JSON Schema cannot express', () => {
    const big = defineRoute({
      ...base,
      path: '/v1/big',
      operationId: 'big',
      response: z.object({ n: z.bigint() }),
      handler: () => ({ n: 1n }),
    });
    expect(() => createV1App({ routes: [big] })).toThrow();
  });
});

describe('the app on its own', () => {
  it('makes its own request id when the server did not pass one', async () => {
    const { app } = createV1App();
    const res = await app.request('/v1/ping');
    expect(res.status).toBe(200);
    expect(res.headers.get('ujira-request-id')).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('uses the id the server passed', async () => {
    const { app } = createV1App();
    const res = await app.request('/v1/nowhere', {}, { requestId: 'from-server', client: 'c' });
    expect(res.headers.get('ujira-request-id')).toBe('from-server');
    expect(await res.json()).toEqual({
      error: { code: 'NOT_FOUND', message: 'No such route', requestId: 'from-server' },
    });
  });

  it('maps framework exceptions onto the envelope and carries ApiError headers', async () => {
    const statuses: [number, string, number][] = [
      [400, 'INVALID_REQUEST', 400],
      [404, 'NOT_FOUND', 404],
      [413, 'PAYLOAD_TOO_LARGE', 413],
      [415, 'UNSUPPORTED_MEDIA_TYPE', 415],
      [418, 'INTERNAL', 500],
    ];
    const routes = statuses.map(([status]) =>
      defineRoute({
        ...base(),
        path: `/v1/http-${status}`,
        operationId: `http${status}`,
        handler: () => {
          throw new HTTPException(status as 400, { message: 'framework text' });
        },
      }),
    );
    const limited = defineRoute({
      ...base(),
      path: '/v1/limited',
      operationId: 'limited',
      handler: () => {
        throw new ApiError('RATE_LIMITED', 'Too many requests', {
          headers: { 'retry-after': '3' },
        });
      },
    });
    const { app } = createV1App({ routes: [...routes, limited] });
    for (const [status, code, answered] of statuses) {
      const res = await app.request(`/v1/http-${status}`);
      expect(res.status).toBe(answered);
      const text = await res.text();
      expect(text).not.toContain('framework text');
      expect(JSON.parse(text)).toMatchObject({ error: { code } });
    }
    const res = await app.request('/v1/limited');
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('3');
    expect(await res.json()).toMatchObject({ error: { code: 'RATE_LIMITED' } });

    function base() {
      return { method: 'get' as const, summary: 's', response: ok };
    }
  });

  it('refuses a Content-Length that is not a number', async () => {
    const { app } = createV1App();
    const res = await app.request('/v1/ping', {
      method: 'POST',
      headers: { 'content-length': 'abc', 'content-type': 'application/json' },
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: 'INVALID_REQUEST' } });
  });
});
