// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// Idempotency through the whole /v1 pipeline, with the in-memory store for the
// rules. What stops a duplicate across instances is the database's unique
// constraint, which src/api/idempotency.db.test.ts shows against a real one.

import { randomUUID } from 'node:crypto';

import { Validator } from '@seriousme/openapi-schema-validator';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createV1App } from '../src/api/app.js';
import { ApiError, errorEnvelopeSchema } from '../src/api/errors.js';
import {
  IDEMPOTENCY_KEY_PATTERN,
  IDEMPOTENCY_LEASE_SECONDS,
  IDEMPOTENCY_REPLAY_SECONDS,
  isFinalStatus,
  memoryIdempotencyStore,
  requestFingerprint,
  type IdempotencyStore,
} from '../src/api/idempotency.js';
import { databaseIdempotencyStore } from '../src/api/idempotency-store.js';
import { defineIdempotentRoute, defineRoute, type IdempotentCall } from '../src/api/route.js';
import { DatabaseUnavailableError, type Database, type ProjectContext } from '../src/db/index.js';

interface Caller extends ProjectContext {
  readonly memberId: string;
}

const TENANT: Caller = { principalId: randomUUID(), projectId: randomUUID(), memberId: 'm-1' };
// Another project of the same principal, and another principal altogether.
const SIBLING: Caller = { ...TENANT, projectId: randomUUID() };
const STRANGER: Caller = { principalId: randomUUID(), projectId: randomUUID(), memberId: 'm-2' };

const Thing = z.object({ id: z.string(), runs: z.number() }).strict();

const BEHAVIOURS = ['ok', 'refuse', 'outage', 'bug', 'hang', 'slow'] as const;
type Behaviour = (typeof BEHAVIOURS)[number];

interface Handler {
  runs: number;
  calls: IdempotentCall<Caller>[];
  release: () => void;
}

function handlerState(): Handler {
  return { runs: 0, calls: [], release: () => undefined };
}

interface Deps {
  readonly store: IdempotencyStore;
  readonly authenticate: () => Promise<Caller>;
  readonly log: (line: string) => void;
}

function thingRoutes(state: Handler, deps: Deps) {
  const idempotency = { store: deps.store, authenticate: deps.authenticate, log: deps.log };
  return [
    defineIdempotentRoute({
      method: 'post',
      path: '/v1/things',
      operationId: 'createThing',
      summary: 'Create a thing',
      body: z.object({ name: z.string(), behaviour: z.enum(BEHAVIOURS).optional() }).strict(),
      status: 202,
      response: Thing,
      errors: ['TASK_ID_REUSED', 'CHAIN_UNAVAILABLE'],
      idempotency,
      handler: async ({ body, idempotent }) => {
        state.runs += 1;
        state.calls.push(idempotent);
        const behaviour: Behaviour = body.behaviour ?? 'ok';
        switch (behaviour) {
          case 'ok':
            return { id: body.name, runs: state.runs };
          case 'refuse':
            throw new ApiError('TASK_ID_REUSED', 'That task was already paid under another key');
          case 'outage':
            throw new ApiError('CHAIN_UNAVAILABLE', 'The network is not answering');
          case 'bug':
            throw new Error('boom');
          case 'hang':
            await new Promise<void>((resolve) => {
              state.release = resolve;
            });
            return { id: body.name, runs: state.runs };
          case 'slow':
            await new Promise((resolve) => setTimeout(resolve, 30));
            return { id: body.name, runs: state.runs };
        }
      },
    }),
    defineIdempotentRoute({
      method: 'delete',
      path: '/v1/things/{id}',
      operationId: 'deleteThing',
      summary: 'Delete a thing',
      params: z.object({ id: z.string() }).strict(),
      response: Thing,
      idempotency,
      handler: ({ params }) => {
        state.runs += 1;
        return { id: params.id, runs: state.runs };
      },
    }),
    defineRoute({
      method: 'get',
      path: '/v1/things/{id}',
      operationId: 'getThing',
      summary: 'Read a thing',
      params: z.object({ id: z.string() }).strict(),
      response: Thing,
      handler: ({ params }) => ({ id: params.id, runs: 0 }),
    }),
  ];
}

function served(over: Partial<Deps> = {}, state: Handler = handlerState()) {
  const lines: string[] = [];
  const deps: Deps = {
    store: memoryIdempotencyStore(),
    authenticate: () => Promise.resolve(TENANT),
    log: (line) => {
      lines.push(line);
    },
    ...over,
  };
  const { app, document } = createV1App({
    routes: thingRoutes(state, deps),
    log: deps.log,
  });
  let requests = 0;
  const post = (
    key: string | null,
    body: unknown = { name: 'Ada' },
    headers: Record<string, string> = {},
  ): Promise<Response> => {
    requests += 1;
    return Promise.resolve(
      app.request(
        '/v1/things',
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(key === null ? {} : { 'idempotency-key': key }),
            ...headers,
          },
          body: JSON.stringify(body),
        },
        { requestId: `req-${String(requests)}` },
      ),
    );
  };
  return { app, document, lines, state, post };
}

async function codeOf(response: Response): Promise<string> {
  return errorEnvelopeSchema.parse(await response.json()).error.code;
}

async function waitFor(check: () => boolean | Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('the condition never held');
}

describe('a replay', () => {
  it('with the same key and body returns the stored status and body', async () => {
    const { post, state } = served();
    const key = randomUUID();
    const first = await post(key);
    const second = await post(key);
    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect(await second.text()).toBe(await first.text());
    expect(state.runs).toBe(1);
  });

  it('is marked Idempotent-Replayed: true, and the first answer is not', async () => {
    const { post } = served();
    const key = randomUUID();
    const first = await post(key);
    expect(first.headers.get('idempotent-replayed')).toBeNull();
    const second = await post(key);
    expect(second.headers.get('idempotent-replayed')).toBe('true');
    expect(second.headers.get('content-type')).toBe(first.headers.get('content-type'));
  });

  it('carries its own request id, and logs the one it repeats without the key', async () => {
    const { post, lines } = served();
    const key = randomUUID();
    await post(key);
    const second = await post(key);
    expect(second.headers.get('ujira-request-id')).toBe('req-2');
    const replay = lines.find((l) => l.startsWith('event=idempotent_replay'));
    expect(replay).toContain('requestId=req-2');
    expect(replay).toContain('originalRequestId=req-1');
    expect(replay).toContain(`principalId=${TENANT.principalId}`);
    expect(replay).toContain(`projectId=${TENANT.projectId}`);
    expect(lines.join('\n')).not.toContain(key);
  });

  it('of a refusal gets the same refusal, byte for byte, without running again', async () => {
    const { post, state } = served();
    const key = randomUUID();
    const body = { name: 'Ada', behaviour: 'refuse' };
    const first = await post(key, body);
    const second = await post(key, body);
    expect(first.status).toBe(409);
    expect(second.status).toBe(409);
    const original = await first.text();
    expect(await second.text()).toBe(original);
    expect(second.headers.get('idempotent-replayed')).toBe('true');
    expect(errorEnvelopeSchema.parse(JSON.parse(original)).error).toMatchObject({
      code: 'TASK_ID_REUSED',
      requestId: 'req-1',
    });
    expect(state.runs).toBe(1);
  });

  it.each([
    ['an outage', 'outage', 503],
    ['a bug', 'bug', 500],
  ] as const)('after %s runs again, since that answer says to try again', async (_n, b, status) => {
    const { post, state } = served();
    const key = randomUUID();
    const first = await post(key, { name: 'Ada', behaviour: b });
    expect(first.status).toBe(status);
    const second = await post(key, { name: 'Ada', behaviour: b });
    expect(second.status).toBe(status);
    expect(second.headers.get('idempotent-replayed')).toBeNull();
    expect(state.runs).toBe(2);
  });

  it('hands the handler the key and the caller, for a unique constraint of its own', async () => {
    const { post, state } = served();
    const key = randomUUID();
    await post(key);
    expect(state.calls).toEqual([{ key, caller: TENANT }]);
  });
});

describe('a reused key', () => {
  it('with another body answers 422 IDEMPOTENCY_KEY_REUSED', async () => {
    const { post, state } = served();
    const key = randomUUID();
    await post(key, { name: 'Ada' });
    const response = await post(key, { name: 'Grace' });
    expect(response.status).toBe(422);
    expect(await codeOf(response)).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(state.runs).toBe(1);
  });

  it('with the same JSON written differently is another request', async () => {
    const { app, post } = served();
    const key = randomUUID();
    await post(key, { name: 'Ada' });
    const response = await app.request('/v1/things', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': key },
      body: '{ "name": "Ada" }',
    });
    expect(await codeOf(response)).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('on another route, or another path of the same route, answers 422 too', async () => {
    const { app, post } = served();
    const key = randomUUID();
    const remove = (path: string, k: string) =>
      app.request(path, { method: 'DELETE', headers: { 'idempotency-key': k } });
    await post(key);
    expect(await codeOf(await remove('/v1/things/x', key))).toBe('IDEMPOTENCY_KEY_REUSED');
    const other = randomUUID();
    expect((await remove('/v1/things/x', other)).status).toBe(200);
    expect(await codeOf(await remove('/v1/things/y', other))).toBe('IDEMPOTENCY_KEY_REUSED');
  });
});

describe('keys are per project', () => {
  it.each([
    ['another project of the same principal', SIBLING],
    ['another principal', STRANGER],
  ])('the same key in %s is a second request', async (_name, other) => {
    const store = memoryIdempotencyStore();
    const key = randomUUID();
    const mine = served({ store });
    const theirs = served({ store, authenticate: () => Promise.resolve(other) });
    const a = await mine.post(key, { name: 'mine' });
    const b = await theirs.post(key, { name: 'theirs' });
    expect(a.status).toBe(202);
    expect(b.status).toBe(202);
    expect(b.headers.get('idempotent-replayed')).toBeNull();
    expect(await b.text()).not.toContain('mine');
    expect(theirs.state.runs).toBe(1);
    // And each project still replays its own.
    expect(await (await mine.post(key, { name: 'mine' })).text()).toContain('mine');
  });

  it('stores only the tenant, whatever else the caller carries', async () => {
    const seen: ProjectContext[] = [];
    const inner = memoryIdempotencyStore();
    const store: IdempotencyStore = {
      ...inner,
      reserve: (tenant, request) => {
        seen.push(tenant);
        return inner.reserve(tenant, request);
      },
    };
    await served({ store }).post(randomUUID());
    expect(seen).toEqual([{ principalId: TENANT.principalId, projectId: TENANT.projectId }]);
  });
});

describe('the header', () => {
  it('missing answers 400 IDEMPOTENCY_KEY_REQUIRED and runs nothing', async () => {
    const { post, state } = served();
    const response = await post(null);
    expect(response.status).toBe(400);
    expect(await codeOf(response)).toBe('IDEMPOTENCY_KEY_REQUIRED');
    expect(state.runs).toBe(0);
  });

  it('is required on a DELETE too', async () => {
    const { app } = served();
    const response = await app.request('/v1/things/x', { method: 'DELETE' });
    expect(await codeOf(response)).toBe('IDEMPOTENCY_KEY_REQUIRED');
  });

  it.each([
    ['empty', ''],
    ['too long', 'a'.repeat(256)],
    ['a space', 'has space'],
    ['an email', 'someone@example.com'],
    ['a comma, as two headers become', 'one, two'],
    ['non ASCII', 'clé'],
  ])('malformed with %s answers 400 IDEMPOTENCY_KEY_INVALID without echoing it', async (_n, k) => {
    const { app, lines, state } = served();
    const response = await app.request('/v1/things', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': k },
      body: JSON.stringify({ name: 'Ada' }),
    });
    expect(response.status).toBe(400);
    const text = await response.text();
    expect(errorEnvelopeSchema.parse(JSON.parse(text)).error.code).toBe('IDEMPOTENCY_KEY_INVALID');
    if (k !== '') {
      expect(text).not.toContain(k);
      expect(lines.join('\n')).not.toContain(k);
    }
    expect(state.runs).toBe(0);
  });

  it('accepts the longest key the database accepts', async () => {
    expect((await served().post('a'.repeat(255))).status).toBe(202);
    expect(IDEMPOTENCY_KEY_PATTERN.source).toBe('^[A-Za-z0-9_.:-]{1,255}$');
  });

  it('is not needed on a read', async () => {
    const { app } = served();
    expect((await app.request('/v1/things/x')).status).toBe(200);
  });

  it('is asked for only after the caller is known', async () => {
    const { post } = served({
      authenticate: () => Promise.reject(new ApiError('SESSION_INVALID', 'Sign in again')),
    });
    const response = await post(null);
    expect(response.status).toBe(401);
    expect(await codeOf(response)).toBe('SESSION_INVALID');
  });
});

describe('what uses up a key', () => {
  it('an invalid body does not, since it never ran', async () => {
    const { post, state } = served();
    const key = randomUUID();
    expect((await post(key, { name: 1 })).status).toBe(400);
    expect((await post(key, { name: 'Ada' })).status).toBe(202);
    expect(state.runs).toBe(1);
  });

  it('a response that breaks its schema does not either, since that is a bug to retry', async () => {
    const store = memoryIdempotencyStore();
    let runs = 0;
    const broken = defineIdempotentRoute({
      method: 'post',
      path: '/v1/broken',
      operationId: 'broken',
      summary: 'Answers a field its schema does not declare',
      response: z.object({ ok: z.boolean() }).strict(),
      idempotency: {
        store,
        authenticate: () => Promise.resolve(TENANT),
        log: () => undefined,
      },
      handler: () => {
        runs += 1;
        return { ok: true, secret: 'x' } as { ok: boolean };
      },
    });
    const { app } = createV1App({ routes: [broken] });
    const send = () =>
      app.request('/v1/broken', { method: 'POST', headers: { 'idempotency-key': 'k-1' } });
    expect((await send()).status).toBe(500);
    expect((await send()).status).toBe(500);
    expect(runs).toBe(2);
  });
});

describe('a concurrent duplicate', () => {
  it('answers 409 IDEMPOTENCY_IN_PROGRESS with Retry-After while the first runs', async () => {
    const { post, state } = served();
    const key = randomUUID();
    const body = { name: 'Ada', behaviour: 'hang' };
    const first = post(key, body);
    await waitFor(() => state.runs === 1);
    const second = await post(key, body);
    expect(second.status).toBe(409);
    expect(second.headers.get('retry-after')).toBe('1');
    expect(await codeOf(second)).toBe('IDEMPOTENCY_IN_PROGRESS');
    state.release();
    const original = await first;
    expect(original.status).toBe(202);
    const third = await post(key, body);
    expect(await third.text()).toBe(await original.text());
    expect(state.runs).toBe(1);
  });

  it('of 20 identical requests at once produces exactly one stored response', async () => {
    const store = memoryIdempotencyStore();
    const { post, state } = served({ store });
    const key = randomUUID();
    const body = { name: 'Ada', behaviour: 'slow' };
    const responses = await Promise.all(Array.from({ length: 20 }, () => post(key, body)));
    expect(state.runs).toBe(1);
    for (const r of responses) expect([202, 409]).toContain(r.status);
    const fresh = responses.filter(
      (r) => r.status === 202 && r.headers.get('idempotent-replayed') === null,
    );
    expect(fresh).toHaveLength(1);
    const answer = await fresh[0]?.text();
    // What is stored is that one answer, and every later retry gets it.
    const stored = await store.reserve(TENANT, {
      key,
      requestSha256: requestFingerprint(
        'POST',
        new URL('http://localhost/v1/things'),
        Buffer.from(JSON.stringify(body)),
      ),
      leaseSeconds: 1,
    });
    expect(stored).toMatchObject({ kind: 'replay', status: 202, body: answer });
    expect(await (await post(key, body)).text()).toBe(answer);
  });
});

describe('when the store fails', () => {
  const failing = (over: Partial<IdempotencyStore>): IdempotencyStore => ({
    ...memoryIdempotencyStore(),
    ...over,
  });

  it('does not run the handler if the key cannot be reserved', async () => {
    const { post, state, lines } = served({
      store: failing({ reserve: () => Promise.reject(new Error('down')) }),
    });
    expect((await post(randomUUID())).status).toBe(500);
    expect(state.runs).toBe(0);
    expect(lines.some((l) => l.startsWith('event=v1_internal_error'))).toBe(true);
  });

  it('answers 503 DB_UNAVAILABLE when the database is down', async () => {
    const down = {
      tenant: () => ({
        transaction: () => Promise.reject(new DatabaseUnavailableError('connection')),
      }),
    } as unknown as Database;
    const { post, state } = served({ store: databaseIdempotencyStore(down) });
    const response = await post(randomUUID());
    expect(response.status).toBe(503);
    expect(await codeOf(response)).toBe('DB_UNAVAILABLE');
    expect(state.runs).toBe(0);
  });

  it('still answers truly when the answer cannot be stored, and logs it', async () => {
    const { post, lines } = served({
      store: failing({ complete: () => Promise.reject(new Error('down')) }),
    });
    expect((await post(randomUUID())).status).toBe(202);
    const line = lines.find((l) => l.startsWith('event=idempotency_complete_failed'));
    expect(line).toContain('error=Error');
    expect(line).toContain(`projectId=${TENANT.projectId}`);
  });

  it('logs when an attempt finds its lease has gone', async () => {
    const { post, lines } = served({ store: failing({ complete: () => Promise.resolve(false) }) });
    expect((await post(randomUUID())).status).toBe(202);
    expect(lines.some((l) => l.startsWith('event=idempotency_lease_lost'))).toBe(true);
  });

  it('answers with the original failure when the key cannot be given back', async () => {
    const { post, lines } = served({
      store: failing({ release: () => Promise.reject(new Error('down')) }),
    });
    const response = await post(randomUUID(), { name: 'Ada', behaviour: 'outage' });
    expect(await codeOf(response)).toBe('CHAIN_UNAVAILABLE');
    expect(lines.some((l) => l.startsWith('event=idempotency_release_failed'))).toBe(true);
  });
});

describe('the store adapter over the database', () => {
  it('passes every other failure through unchanged', async () => {
    const odd = new TypeError('odd');
    const broken = {
      tenant: () => ({ transaction: () => Promise.reject(odd) }),
    } as unknown as Database;
    const store = databaseIdempotencyStore(broken);
    const finish = { key: 'k', leaseId: 'l', status: 202, requestId: 'r', body: '{}' };
    await expect(
      store.reserve(TENANT, { key: 'k', requestSha256: Buffer.alloc(32), leaseSeconds: 1 }),
    ).rejects.toBe(odd);
    await expect(store.complete(TENANT, finish)).rejects.toBe(odd);
    await expect(store.release(TENANT, { key: 'k', leaseId: 'l' })).rejects.toBe(odd);
  });
});

describe('keys expire after 7 days', () => {
  const DAY = 86_400_000;

  it('replay for 7 days and then belong to whatever request comes next', async () => {
    let at = 0;
    const store = memoryIdempotencyStore(() => new Date(at));
    const { post, state } = served({ store });
    const key = randomUUID();
    expect((await post(key, { name: 'Ada' })).status).toBe(202);
    at = 7 * DAY - 1;
    expect((await post(key, { name: 'Ada' })).headers.get('idempotent-replayed')).toBe('true');
    expect(await codeOf(await post(key, { name: 'Grace' }))).toBe('IDEMPOTENCY_KEY_REUSED');
    at = 7 * DAY;
    const later = await post(key, { name: 'Grace' });
    expect(later.status).toBe(202);
    expect(later.headers.get('idempotent-replayed')).toBeNull();
    expect(state.runs).toBe(2);
  });

  it('which is the window the database keeps too', () => {
    expect(IDEMPOTENCY_REPLAY_SECONDS).toBe(7 * 24 * 60 * 60);
  });
});

describe('the helpers', () => {
  const url = (path: string) => new URL(`http://x${path}`);
  const bytes = (text: string) => new TextEncoder().encode(text);

  it('gives the same request the same fingerprint, and each difference a new one', () => {
    const base = requestFingerprint('POST', url('/v1/a?b=1'), bytes('{}'));
    expect(requestFingerprint('POST', url('/v1/a?b=1'), bytes('{}'))).toEqual(base);
    for (const other of [
      requestFingerprint('PUT', url('/v1/a?b=1'), bytes('{}')),
      requestFingerprint('POST', url('/v1/b?b=1'), bytes('{}')),
      requestFingerprint('POST', url('/v1/a?b=2'), bytes('{}')),
      requestFingerprint('POST', url('/v1/a?b=1'), bytes('{ }')),
      requestFingerprint('POST', url('/v1/a?b=1'), null),
    ]) {
      expect(other).not.toEqual(base);
    }
  });

  it('keeps parts from running into each other', () => {
    expect(requestFingerprint('POST', url('/v1/a?x'), null)).not.toEqual(
      requestFingerprint('POST', url('/v1/a'), bytes('?x')),
    );
  });

  it.each([
    [200, true],
    [202, true],
    [404, true],
    [409, true],
    [422, true],
    [429, false],
    [500, false],
    [503, false],
  ])('treats a %i as final: %s', (status, final) => {
    expect(isFinalStatus(status)).toBe(final);
  });

  it('holds the key longer than any request can run', () => {
    expect(IDEMPOTENCY_LEASE_SECONDS).toBeGreaterThan(60);
  });
});

describe('the memory store', () => {
  const HASH = Buffer.alloc(32, 1);
  const reserve = { key: 'k', requestSha256: HASH, leaseSeconds: 10 };

  it('lets the same request take over once a lease runs out, as the real one does', async () => {
    let at = 0;
    const store = memoryIdempotencyStore(() => new Date(at));
    expect((await store.reserve(TENANT, reserve)).kind).toBe('started');
    at = 9_000;
    expect((await store.reserve(TENANT, reserve)).kind).toBe('in_progress');
    expect(
      (await store.reserve(TENANT, { ...reserve, requestSha256: Buffer.alloc(32) })).kind,
    ).toBe('mismatch');
    at = 10_000;
    expect((await store.reserve(TENANT, reserve)).kind).toBe('started');
  });

  it('fences an attempt that lost its lease', async () => {
    const store = memoryIdempotencyStore();
    const finish = { key: 'k', leaseId: 'nope', status: 202, requestId: 'r', body: '{}' };
    await store.reserve(TENANT, reserve);
    expect(await store.complete(TENANT, finish)).toBe(false);
    expect(await store.release(TENANT, { key: 'k', leaseId: 'nope' })).toBe(false);
  });
});

describe('the definition', () => {
  const idempotency = {
    store: memoryIdempotencyStore(),
    authenticate: () => Promise.resolve(TENANT),
    log: () => undefined,
  };

  it('refuses a GET, which is safe to repeat as it is', () => {
    expect(() =>
      defineIdempotentRoute({
        method: 'get' as 'post',
        path: '/v1/x',
        operationId: 'x',
        summary: 's',
        response: z.object({}),
        idempotency,
        handler: () => ({}),
      }),
    ).toThrow(/GET takes no idempotency key/);
  });

  it('is documented: the required header, its codes and the replay header', async () => {
    const { document } = served();
    const create = document.paths['/v1/things']?.['post'] as {
      parameters: { name: string; in: string; required: boolean }[];
      responses: Record<string, { description: string; headers?: Record<string, unknown> }>;
    };
    expect(create.parameters).toContainEqual(
      expect.objectContaining({ name: 'Idempotency-Key', in: 'header', required: true }),
    );
    expect(create.responses['400']?.description).toContain('IDEMPOTENCY_KEY_REQUIRED');
    expect(create.responses['400']?.description).toContain('IDEMPOTENCY_KEY_INVALID');
    expect(create.responses['409']?.description).toContain('IDEMPOTENCY_IN_PROGRESS');
    expect(create.responses['422']?.description).toContain('IDEMPOTENCY_KEY_REUSED');
    expect(create.responses['503']?.description).toContain('DB_UNAVAILABLE');
    expect(Object.keys(create.responses['202']?.headers ?? {})).toContain('Idempotent-Replayed');

    const read = document.paths['/v1/things/{id}']?.['get'] as {
      parameters: { name: string }[];
      responses: Record<string, unknown>;
    };
    expect(read.parameters.map((p) => p.name)).not.toContain('Idempotency-Key');
    expect(read.responses['422']).toBeUndefined();

    const validator = new Validator();
    const result = await validator.validate(
      JSON.parse(JSON.stringify(document)) as Parameters<Validator['validate']>[0],
    );
    expect(result.errors).toBeUndefined();
    expect(result.valid).toBe(true);
  });
});
