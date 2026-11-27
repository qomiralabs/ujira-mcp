// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// /v1 mounted in the real node:http server: the request id, the error
// envelope, body limits, media types, the OpenAPI document, and the routes
// that were there before /v1 still answering exactly as they did.

import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';

import { Validator } from '@seriousme/openapi-schema-validator';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createV1App } from '../src/api/app.js';
import { MAX_BODY_BYTES } from '../src/api/body.js';
import { errorEnvelopeSchema } from '../src/api/errors.js';
import { nodeHandler } from '../src/api/node.js';
import { defineRoute, type Route } from '../src/api/route.js';
import { createHttpServer, type ExtraRoutes } from '../src/mcp/http.js';
import { DEFAULT_MAX_AMOUNT, type HttpSettings } from '../src/mcp/public.js';
import { publicMcp } from '../src/demo/public-mcp.js';
import { setup } from './helpers.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function settings(over: Partial<HttpSettings> = {}): HttpSettings {
  return {
    port: 0,
    host: '127.0.0.1',
    maxBodyBytes: 16 * 1024,
    requestTimeoutMs: 10_000,
    allowedOrigins: ['https://claude.ai'],
    clientIp: { trustProxy: true },
    limits: { maxAmount: DEFAULT_MAX_AMOUNT, payoutsPerHour: 5, toolCallsPerMinute: 120 },
    ...over,
  };
}

/** Routes that exist only here, to drive the shell through bodies, queries, params and failures. */
const echo = defineRoute({
  method: 'post',
  path: '/v1/test/echo',
  operationId: 'testEcho',
  summary: 'Echo a validated body',
  body: z
    .object({
      label: z.string().max(40),
      amount: z.string().regex(/^\d+$/),
      note: z.string().optional(),
    })
    .strict(),
  status: 202,
  response: z.object({ label: z.string(), amount: z.string() }).strict(),
  errors: ['IDEMPOTENCY_KEY_REQUIRED'],
  handler: ({ body }) => ({ label: body.label, amount: body.amount }),
});

const item = defineRoute({
  method: 'get',
  path: '/v1/test/items/{id}',
  operationId: 'testItem',
  summary: 'Read params and a query',
  params: z.object({ id: z.uuid() }).strict(),
  query: z.object({ limit: z.coerce.number().int().min(1).max(100).optional() }).strict(),
  response: z.object({ id: z.string(), limit: z.number() }).strict(),
  errors: ['NOT_FOUND'],
  handler: ({ params, query }) => ({ id: params.id, limit: query.limit ?? 10 }),
});

const boom = defineRoute({
  method: 'get',
  path: '/v1/test/boom',
  operationId: 'testBoom',
  summary: 'Fails with a secret in the message',
  response: z.object({}).strict(),
  handler: () => {
    throw new TypeError('SBSECRETSEEDTHATMUSTNOTLEAK');
  },
});

const leaky = defineRoute({
  method: 'get',
  path: '/v1/test/leaky',
  operationId: 'testLeaky',
  summary: 'Returns a field its schema does not declare',
  response: z.object({ ok: z.boolean() }).strict(),
  handler: () => ({ ok: true, secret: 'x' }) as { ok: boolean },
});

const slow = defineRoute({
  method: 'get',
  path: '/v1/test/slow',
  operationId: 'testSlow',
  summary: 'Never answers until the caller goes away',
  response: z.object({}).strict(),
  handler: (_input, c) =>
    new Promise<Record<string, never>>((resolve) => {
      c.req.raw.signal.addEventListener('abort', () => {
        resolve({});
      });
    }),
});

const TEST_ROUTES: readonly Route[] = [echo, item, boom, leaky, slow];

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

interface Seen {
  readonly paths: string[];
  readonly mandates: string[];
}

/** Stands in for the console: records what reached it and answers with a marker. */
function recordingExtra(): ExtraRoutes & Seen {
  const paths: string[] = [];
  const mandates: string[] = [];
  return {
    paths,
    mandates,
    mandateMcp(id) {
      mandates.push(id);
      return undefined;
    },
    handle(_req: IncomingMessage, res: ServerResponse, path: string) {
      if (!path.startsWith('/api/') && !path.startsWith('/app') && path !== '/') {
        return Promise.resolve(false);
      }
      paths.push(path);
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('extra');
      return Promise.resolve(true);
    },
  };
}

async function start(
  options: { v1?: boolean; routes?: readonly Route[]; httpSettings?: HttpSettings } = {},
) {
  const lines: string[] = [];
  const log = (line: string) => lines.push(line);
  const extra = recordingExtra();
  const v1App = createV1App({ routes: options.routes ?? TEST_ROUTES, log });
  const http = options.httpSettings ?? settings();
  const server = createHttpServer({
    settings: http,
    // The public demo MCP stays mounted, so /mcp is checked next to /v1.
    publicMcp: publicMcp({ engine: setup().engine, http, assetCode: 'USDC', recipients: [] }),
    log,
    extra,
    ...(options.v1 === false ? {} : { v1: nodeHandler(v1App.app) }),
  });
  open.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, port, lines, extra, document: v1App.document };
}

async function errorOf(res: Response) {
  const body = errorEnvelopeSchema.parse(await res.json());
  expect(body.error.requestId).toBe(res.headers.get('ujira-request-id'));
  return body.error;
}

/** A raw request, for bodies fetch will not send as written: chunked, or with a lying length. */
function rawPost(
  port: number,
  path: string,
  headers: Record<string, string>,
  chunks: readonly string[],
): Promise<{ status: number; headers: Record<string, unknown>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port, path, method: 'POST', headers, agent: false, timeout: 5_000 },
      (res) => {
        const parts: Buffer[] = [];
        res.on('data', (c: Buffer) => parts.push(c));
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(parts).toString('utf8'),
          });
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('timed out')));
    // The server may answer and close before the last chunk is written.
    req.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code !== 'EPIPE' && error.code !== 'ECONNRESET') reject(error);
    });
    for (const chunk of chunks) req.write(chunk);
    req.end();
  });
}

const json = { 'content-type': 'application/json' };

describe('/v1 request ids', () => {
  it('names every answer with a fresh id, success or failure, and logs it', async () => {
    const { base, lines } = await start();
    const a = await fetch(`${base}/v1/ping`);
    expect(a.status).toBe(200);
    expect(await a.json()).toEqual({ status: 'ok' });
    const idA = a.headers.get('ujira-request-id') ?? '';
    expect(idA).toMatch(UUID);
    expect(a.headers.get('cache-control')).toBe('no-store');
    expect(a.headers.get('x-content-type-options')).toBe('nosniff');

    const b = await fetch(`${base}/v1/ping`);
    const idB = b.headers.get('ujira-request-id') ?? '';
    expect(idB).toMatch(UUID);
    expect(idB).not.toBe(idA);

    const missing = await fetch(`${base}/v1/nowhere`);
    expect(missing.status).toBe(404);
    expect(await errorOf(missing)).toMatchObject({ code: 'NOT_FOUND' });
    const root = await fetch(`${base}/v1`);
    expect(root.status).toBe(404);
    expect(await errorOf(root)).toMatchObject({ code: 'NOT_FOUND' });

    const ok = `event=http_request requestId=${idA} method=GET route=/v1 status=200 ms=`;
    expect(lines.some((l) => l.startsWith(ok) && /^\d+$/.test(l.slice(ok.length)))).toBe(true);
    expect(lines.some((l) => / method=GET route=\/v1 status=404 /.test(l))).toBe(true);
  });

  it('ignores an id the caller sends, so logs cannot be seeded from outside', async () => {
    const { base } = await start();
    const res = await fetch(`${base}/v1/ping`, {
      headers: { 'ujira-request-id': 'chosen-by-caller' },
    });
    expect(res.headers.get('ujira-request-id')).toMatch(UUID);
  });

  it('answers HEAD on a GET route with headers and no body', async () => {
    const { base } = await start();
    const res = await fetch(`${base}/v1/ping`, { method: 'HEAD' });
    expect(res.status).toBe(200);
    expect(res.headers.get('ujira-request-id')).toMatch(UUID);
    expect(await res.text()).toBe('');
  });

  it('answers a wrong method with the envelope, not a framework page', async () => {
    const { base } = await start();
    const res = await fetch(`${base}/v1/ping`, { method: 'DELETE' });
    expect(res.status).toBe(404);
    expect(await errorOf(res)).toMatchObject({ code: 'NOT_FOUND', message: 'No such route' });
  });
});

describe('/v1 bodies', () => {
  it('accepts a valid JSON body and answers with the route status', async () => {
    const { base } = await start();
    const res = await fetch(`${base}/v1/test/echo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ label: 'week 48', amount: '25000000' }),
    });
    expect(res.status).toBe(202);
    expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(await res.json()).toEqual({ label: 'week 48', amount: '25000000' });
  });

  it('refuses a body over 64 KB by its declared length with 413', async () => {
    const { base } = await start();
    const body = JSON.stringify({ label: 'x', amount: '1', note: 'y'.repeat(MAX_BODY_BYTES) });
    const res = await fetch(`${base}/v1/test/echo`, { method: 'POST', headers: json, body });
    expect(res.status).toBe(413);
    expect(await errorOf(res)).toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
  });

  it('accepts a body of exactly 64 KB', async () => {
    const { base } = await start();
    const shell = JSON.stringify({ label: 'x', amount: '1', note: '' });
    const body = JSON.stringify({
      label: 'x',
      amount: '1',
      note: 'y'.repeat(MAX_BODY_BYTES - shell.length),
    });
    expect(Buffer.byteLength(body)).toBe(MAX_BODY_BYTES);
    const res = await fetch(`${base}/v1/test/echo`, { method: 'POST', headers: json, body });
    expect(res.status).toBe(202);
  });

  it('refuses a chunked body once it passes 64 KB, without a declared length', async () => {
    const { port } = await start();
    const chunk = 'y'.repeat(16 * 1024);
    const res = await rawPost(
      port,
      '/v1/test/echo',
      { 'content-type': 'application/json', 'transfer-encoding': 'chunked' },
      ['{"label":"x","amount":"1","note":"', chunk, chunk, chunk, chunk, chunk, '"}'],
    );
    expect(res.status).toBe(413);
    const body = errorEnvelopeSchema.parse(JSON.parse(res.body));
    expect(body.error.code).toBe('PAYLOAD_TOO_LARGE');
    expect(body.error.requestId).toBe(res.headers['ujira-request-id']);
  });

  it('refuses an oversized body even on a route that takes none', async () => {
    const { base } = await start();
    const res = await fetch(`${base}/v1/ping`, {
      method: 'POST',
      headers: json,
      body: 'x'.repeat(MAX_BODY_BYTES + 1),
    });
    expect(res.status).toBe(413);
    expect(await errorOf(res)).toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
  });

  it('answers 415 for a body that is not JSON, and for one with no type', async () => {
    const { base, port } = await start();
    for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'application/jsonx']) {
      const res = await fetch(`${base}/v1/test/echo`, {
        method: 'POST',
        headers: { 'content-type': type },
        body: 'label=x',
      });
      expect(res.status).toBe(415);
      expect(await errorOf(res)).toMatchObject({ code: 'UNSUPPORTED_MEDIA_TYPE' });
    }
    const untyped = await rawPost(port, '/v1/test/echo', { 'content-length': '2' }, ['{}']);
    expect(untyped.status).toBe(415);
  });

  it('answers 400 for broken JSON, a missing body and a body off the schema, naming paths only', async () => {
    const { base, port } = await start();
    const broken = await fetch(`${base}/v1/test/echo`, {
      method: 'POST',
      headers: json,
      body: '{"label":',
    });
    expect(broken.status).toBe(400);
    expect(await errorOf(broken)).toMatchObject({
      code: 'INVALID_REQUEST',
      details: [{ path: 'body', issue: 'invalid_json' }],
    });

    const empty = await rawPost(port, '/v1/test/echo', { 'content-type': 'application/json' }, []);
    expect(empty.status).toBe(400);
    expect(JSON.parse(empty.body)).toMatchObject({
      error: { code: 'INVALID_REQUEST', details: [{ path: 'body', issue: 'required' }] },
    });

    const secret = 'SBSECRETVALUEFROMTHECALLER';
    const off = await fetch(`${base}/v1/test/echo`, {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ label: 7, amount: secret, extra: secret }),
    });
    expect(off.status).toBe(400);
    const text = await off.text();
    expect(text).not.toContain(secret);
    const error = errorEnvelopeSchema.parse(JSON.parse(text)).error;
    expect(error.code).toBe('INVALID_REQUEST');
    expect(error.details).toEqual(
      expect.arrayContaining([
        { path: 'body.label', issue: 'invalid_type' },
        { path: 'body.amount', issue: 'invalid_format' },
        { path: 'body.extra', issue: 'unrecognized_keys' },
      ]),
    );
  });

  it('lets a GET without a body through the guard', async () => {
    const { base } = await start();
    expect((await fetch(`${base}/v1/ping`)).status).toBe(200);
  });
});

describe('/v1 params and queries', () => {
  const id = '0b8f6f2e-6f1a-4c2b-9d3e-1a2b3c4d5e6f';

  it('passes validated params and queries to the handler', async () => {
    const { base } = await start();
    const res = await fetch(`${base}/v1/test/items/${id}?limit=5`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id, limit: 5 });
    expect(await (await fetch(`${base}/v1/test/items/${id}`)).json()).toEqual({ id, limit: 10 });
  });

  it('refuses a bad param, a bad query, an unknown query key and a repeated one', async () => {
    const { base } = await start();
    const cases: [string, string][] = [
      ['/v1/test/items/not-a-uuid', 'params.id'],
      [`/v1/test/items/${id}?limit=0`, 'query.limit'],
      [`/v1/test/items/${id}?other=1`, 'query.other'],
      [`/v1/test/items/${id}?limit=1&limit=2`, 'query.limit'],
    ];
    for (const [path, where] of cases) {
      const res = await fetch(`${base}${path}`);
      expect(res.status, path).toBe(400);
      const error = await errorOf(res);
      expect(error.code).toBe('INVALID_REQUEST');
      expect(error.details?.map((d) => d.path)).toContain(where);
    }
  });
});

describe('/v1 failures', () => {
  it('hides an internal error behind INTERNAL and logs only its class and the request id', async () => {
    const { base, lines } = await start();
    const res = await fetch(`${base}/v1/test/boom`);
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toContain('SBSECRET');
    const error = errorEnvelopeSchema.parse(JSON.parse(text)).error;
    expect(error).toMatchObject({ code: 'INTERNAL', message: 'Internal error' });
    expect(lines).toContain(
      `event=v1_internal_error requestId=${error.requestId} route=/v1/test/boom error=TypeError`,
    );
    expect(lines.join('\n')).not.toContain('SBSECRET');
  });

  it('never sends a field the response schema does not declare', async () => {
    const { base, lines } = await start();
    const res = await fetch(`${base}/v1/test/leaky`);
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain('secret');
    expect(lines.some((l) => l.includes('error=ResponseSchemaError'))).toBe(true);
  });

  it('times out a slow request in the envelope, with its id', async () => {
    const { base } = await start({ httpSettings: settings({ requestTimeoutMs: 200 }) });
    const res = await fetch(`${base}/v1/test/slow`);
    expect(res.status).toBe(504);
    expect(await errorOf(res)).toMatchObject({
      code: 'INTERNAL',
      message: 'The request took too long',
    });
  });
});

describe('/v1 OpenAPI', () => {
  it('serves a valid OpenAPI 3.1 document listing every registered route', async () => {
    const { base, document } = await start();
    const res = await fetch(`${base}/v1/openapi.json`);
    expect(res.status).toBe(200);
    const served = (await res.json()) as Record<string, unknown>;
    expect(served).toEqual(JSON.parse(JSON.stringify(document)));
    expect(served['openapi']).toBe('3.1.0');

    const validator = new Validator();
    const result = await validator.validate(served);
    expect(result.errors).toBeUndefined();
    expect(result.valid).toBe(true);
    expect(validator.version).toBe('3.1');

    const paths = served['paths'] as Record<string, Record<string, { operationId: string }>>;
    const operations = Object.entries(paths).flatMap(([path, item]) =>
      Object.entries(item).map(
        ([method, op]) => `${method.toUpperCase()} ${path} ${op.operationId}`,
      ),
    );
    expect(operations.sort()).toEqual(
      [
        'GET /v1/ping ping',
        'GET /v1/openapi.json getOpenApi',
        'POST /v1/test/echo testEcho',
        'GET /v1/test/items/{id} testItem',
        'GET /v1/test/boom testBoom',
        'GET /v1/test/leaky testLeaky',
        'GET /v1/test/slow testSlow',
      ].sort(),
    );
  });

  it('documents each route from its schemas, with the errors it can answer', async () => {
    const { document } = await start();
    const echoOp = document.paths['/v1/test/echo']?.['post'] as Record<string, unknown>;
    expect(echoOp).toMatchObject({
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['label', 'amount'],
              additionalProperties: false,
            },
          },
        },
      },
    });
    const responses = echoOp['responses'] as Record<string, { description: string }>;
    expect(Object.keys(responses).sort()).toEqual(['202', '400', '413', '415', '500']);
    expect(responses['400']?.description).toBe('IDEMPOTENCY_KEY_REQUIRED, INVALID_REQUEST');

    const itemOp = document.paths['/v1/test/items/{id}']?.['get'] as Record<string, unknown>;
    expect(itemOp['parameters']).toMatchObject([
      { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
      { name: 'limit', in: 'query', required: false, schema: { type: 'integer' } },
    ]);
    expect(itemOp['parameters']).toHaveLength(2);

    const ping = document.paths['/v1/ping']?.['get'] as Record<string, unknown>;
    expect(Object.keys(ping['responses'] as object).sort()).toEqual(['200', '500']);
  });
});

describe('routes outside /v1', () => {
  it('keep answering exactly as before when /v1 is mounted', async () => {
    const { base, extra } = await start();
    const health = await fetch(`${base}/healthz`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: 'ok' });
    expect(health.headers.get('ujira-request-id')).toBeNull();

    for (const path of ['/', '/app', '/app/mandates', '/api/settings']) {
      const res = await fetch(`${base}${path}`);
      expect(await res.text(), path).toBe('extra');
      expect(res.headers.get('ujira-request-id')).toBeNull();
    }
    expect(extra.paths).toEqual(['/', '/app', '/app/mandates', '/api/settings']);

    const mandate = `C${'A'.repeat(55)}`;
    const mcp = await fetch(`${base}/m/${mandate}/mcp`, {
      method: 'POST',
      headers: json,
      body: '{}',
    });
    expect(mcp.status).toBe(404);
    expect(await mcp.json()).toMatchObject({ jsonrpc: '2.0', error: { code: -32000 } });
    expect(extra.mandates).toEqual([mandate]);

    const demo = await fetch(`${base}/mcp`, { method: 'POST', headers: json, body: '{not json' });
    expect(demo.status).toBe(400);
    expect(await demo.json()).toMatchObject({ error: { code: -32700 } });

    // Paths that only look like /v1 are not /v1.
    for (const path of ['/v1x', '/v10/ping', '/api/v1/ping']) {
      const res = await fetch(`${base}${path}`);
      expect(res.headers.get('ujira-request-id'), path).toBeNull();
    }
  });

  it('leaves /v1 a plain 404 when no /v1 app is mounted', async () => {
    const { base } = await start({ v1: false });
    const res = await fetch(`${base}/v1/ping`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not found' });
    expect(res.headers.get('ujira-request-id')).toBeNull();
  });
});
