// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The API key routes and the one authenticate every tenant route uses, in
// memory: keys are shown once and stored as a prefix and a hash, only owners
// and admins manage them and only from a session, a key works in its own
// project with its own scopes and nowhere else, and neither the key nor its
// hash is ever written to a log.

import { randomUUID } from 'node:crypto';

import { Validator } from '@seriousme/openapi-schema-validator';
import { describe, expect, it, vi } from 'vitest';

import { API_KEY_MAX_ACTIVE } from '../src/auth/api-key-service.js';
import { hashSecret, issueToken, parseToken } from '../src/auth/token.js';
import { DatabaseUnavailableError } from '../src/db/index.js';
import { codeOf, keysHarness } from './api-key-helpers.js';
import { START } from './sign-in-helpers.js';

const DAY_MS = 86_400_000;

// Each test signs people in with real signatures, and the first also loads the
// wallet library, which takes more than the default on a busy machine.
vi.setConfig({ testTimeout: 20_000 });

describe('creating a key', () => {
  it('returns the whole key once, and keeps only its prefix and the hash of its secret', async () => {
    const h = keysHarness();
    const owner = await h.member('owner');
    const created = await h.request('POST', '/v1/api-keys', {
      cookie: owner.cookie,
      project: owner.projectId,
      body: { name: '  Payroll runner ', scopes: ['payouts:write', 'payouts:read'] },
    });
    expect(created.status).toBe(201);
    const secret = String(created.json?.['secret']);
    const parsed = parseToken(secret);
    expect(parsed?.environment).toBe('test');
    expect(created.json?.['apiKey']).toEqual({
      principalId: owner.principalId,
      projectId: owner.projectId,
      id: expect.any(String) as string,
      name: 'Payroll runner',
      prefix: parsed?.prefix,
      scopes: ['payouts:write', 'payouts:read'],
      expiresAt: new Date(START + 365 * DAY_MS).toISOString(),
      revokedAt: null,
      lastUsedAt: null,
      createdAt: new Date(START).toISOString(),
    });

    const [row] = [...h.keys.rows.values()];
    expect(row?.prefix).toBe(parsed?.prefix);
    expect(row?.secretSha256).toEqual(hashSecret(parsed?.secret ?? ''));
    expect(JSON.stringify(row)).not.toContain(parsed?.secret);

    // Never again: not in the list, not on revoke.
    const listed = await h.request('GET', '/v1/api-keys', {
      cookie: owner.cookie,
      project: owner.projectId,
    });
    expect(listed.status).toBe(200);
    expect(JSON.stringify(listed.json)).not.toContain(parsed?.secret);
    expect(listed.json?.['items']).toEqual([created.json?.['apiKey']]);
    expect(listed.json?.['nextCursor']).toBeNull();
  });

  it('writes an audit entry naming the member and the key, in the key project', async () => {
    const h = keysHarness();
    const admin = await h.member('admin');
    await h.keyFor(admin, ['payouts:read']);
    const [row] = [...h.keys.rows.values()];
    expect(h.keys.audit).toEqual([
      {
        action: 'api_key.created',
        principalId: admin.principalId,
        projectId: admin.projectId,
        actorId: admin.memberId,
        targetId: row?.id,
      },
    ]);
  });

  it('takes an expiry in whole days, from 1 to 730', async () => {
    const h = keysHarness();
    const owner = await h.member('owner');
    const made = await h.request('POST', '/v1/api-keys', {
      cookie: owner.cookie,
      project: owner.projectId,
      body: { name: 'short', scopes: ['payouts:read'], expiresInDays: 7 },
    });
    expect((made.json?.['apiKey'] as { expiresAt?: string }).expiresAt).toBe(
      new Date(START + 7 * DAY_MS).toISOString(),
    );
    for (const expiresInDays of [0, 731, 1.5, '30']) {
      const refused = await h.request('POST', '/v1/api-keys', {
        cookie: owner.cookie,
        project: owner.projectId,
        body: { name: 'bad', scopes: ['payouts:read'], expiresInDays },
      });
      expect(refused.status, String(expiresInDays)).toBe(400);
      expect(refused.json?.['error']).toMatchObject({
        code: 'INVALID_REQUEST',
        details: [{ path: 'body.expiresInDays' }],
      });
    }
  });

  it.each([
    ['an unknown scope', { name: 'k', scopes: ['admin:all'] }, 'body.scopes.0'],
    ['no scope', { name: 'k', scopes: [] }, 'body.scopes'],
    ['a scope twice', { name: 'k', scopes: ['payouts:read', 'payouts:read'] }, 'body.scopes'],
    ['an empty name', { name: '   ', scopes: ['payouts:read'] }, 'body.name'],
    ['a control character', { name: 'a\nb', scopes: ['payouts:read'] }, 'body.name'],
    ['a long name', { name: 'n'.repeat(101), scopes: ['payouts:read'] }, 'body.name'],
    [
      'a field it does not know',
      { name: 'k', scopes: ['payouts:read'], tenant: 'x' },
      'body.tenant',
    ],
  ])('refuses %s with INVALID_REQUEST', async (_name, body, path) => {
    const h = keysHarness();
    const owner = await h.member('owner');
    const refused = await h.request('POST', '/v1/api-keys', {
      cookie: owner.cookie,
      project: owner.projectId,
      body,
    });
    expect(refused.status).toBe(400);
    const error = refused.json?.['error'] as { code: string; details: { path: string }[] };
    expect(error.code).toBe('INVALID_REQUEST');
    expect(error.details.length).toBeGreaterThan(0);
    expect(error.details.map((d) => d.path)).toEqual(error.details.map(() => path));
    expect(h.keys.rows.size).toBe(0);
  });

  it('stops at the limit of active keys, and a revoked key frees its place', async () => {
    const h = keysHarness();
    const owner = await h.member('owner');
    for (let n = 0; n < API_KEY_MAX_ACTIVE; n += 1) await h.keyFor(owner, ['payouts:read']);
    const over = await h.request('POST', '/v1/api-keys', {
      cookie: owner.cookie,
      project: owner.projectId,
      body: { name: 'one more', scopes: ['payouts:read'] },
    });
    expect(over.status).toBe(409);
    expect(codeOf(over)).toBe('API_KEY_LIMIT_REACHED');
    const [first] = [...h.keys.rows.keys()];
    await h.request('DELETE', `/v1/api-keys/${String(first)}`, {
      cookie: owner.cookie,
      project: owner.projectId,
    });
    await expect(h.keyFor(owner, ['payouts:read'])).resolves.toMatch(/^ujk_test_/);
  });
});

describe('who may manage keys', () => {
  it('lets owners and admins create, list and revoke', async () => {
    const h = keysHarness();
    for (const role of ['owner', 'admin']) {
      const m = await h.member(role);
      await h.keyFor(m, ['payouts:read']);
      const listed = await h.request('GET', '/v1/api-keys', {
        cookie: m.cookie,
        project: m.projectId,
      });
      expect(listed.status, role).toBe(200);
      const [key] = listed.json?.['items'] as { id: string }[];
      const revoked = await h.request('DELETE', `/v1/api-keys/${String(key?.id)}`, {
        cookie: m.cookie,
        project: m.projectId,
      });
      expect(revoked.status, role).toBe(200);
    }
  });

  it('refuses developers and viewers with FORBIDDEN on every key route', async () => {
    const h = keysHarness();
    const owner = await h.member('owner');
    await h.keyFor(owner, ['payouts:read']);
    const [id] = [...h.keys.rows.keys()];
    for (const role of ['developer', 'viewer', 'auditor']) {
      const m = await h.member(role, owner);
      const as = { cookie: m.cookie, project: m.projectId };
      const answers = [
        await h.request('POST', '/v1/api-keys', {
          ...as,
          body: { name: 'k', scopes: ['payouts:read'] },
        }),
        await h.request('GET', '/v1/api-keys', as),
        await h.request('DELETE', `/v1/api-keys/${String(id)}`, as),
      ];
      for (const answer of answers) {
        expect(answer.status, role).toBe(403);
        expect(codeOf(answer), role).toBe('FORBIDDEN');
      }
    }
    expect(h.keys.rows.size).toBe(1);
    expect([...h.keys.rows.values()][0]?.revokedAt).toBeNull();
  });

  it('refuses an API key on every key route, whatever scopes it holds', async () => {
    const h = keysHarness();
    const owner = await h.member('owner');
    const key = await h.keyFor(owner, [
      'payouts:read',
      'payouts:write',
      'approvals:write',
      'recipients:read',
      'recipients:write',
      'mandates:read',
      'mandates:write',
      'receipts:read',
      'webhooks:manage',
      'corridors:read',
    ]);
    const [id] = [...h.keys.rows.keys()];
    const answers = [
      await h.request('POST', '/v1/api-keys', {
        key,
        body: { name: 'k', scopes: ['payouts:read'] },
      }),
      await h.request('GET', '/v1/api-keys', { key }),
      await h.request('DELETE', `/v1/api-keys/${String(id)}`, { key }),
    ];
    for (const answer of answers) {
      expect(answer.status).toBe(403);
      expect(codeOf(answer)).toBe('FORBIDDEN');
    }
    expect(h.keys.rows.size).toBe(1);
  });

  it('answers SESSION_INVALID without a session', async () => {
    const h = keysHarness();
    const answer = await h.request('GET', '/v1/api-keys', { project: randomUUID() });
    expect(answer.status).toBe(401);
    expect(codeOf(answer)).toBe('SESSION_INVALID');
  });

  it('refuses a write from another site before it looks at the session', async () => {
    const h = keysHarness();
    const owner = await h.member('owner');
    const answer = await h.request('POST', '/v1/api-keys', {
      cookie: owner.cookie,
      project: owner.projectId,
      origin: 'https://evil.example',
      body: { name: 'k', scopes: ['payouts:read'] },
    });
    expect(answer.status).toBe(403);
    expect(codeOf(answer)).toBe('ORIGIN_NOT_ALLOWED');
    expect(h.keys.rows.size).toBe(0);
  });

  it('needs the project named in Ujira-Project', async () => {
    const h = keysHarness();
    const owner = await h.member('owner');
    const missing = await h.request('GET', '/v1/api-keys', { cookie: owner.cookie });
    expect(missing.status).toBe(400);
    expect(missing.json?.['error']).toMatchObject({
      details: [{ path: 'header.ujira-project', issue: 'required' }],
    });
    const bad = await h.request('GET', '/v1/api-keys', { cookie: owner.cookie, project: 'main' });
    expect(bad.json?.['error']).toMatchObject({
      details: [{ path: 'header.ujira-project', issue: 'invalid' }],
    });
    // One project, however its id is spelt.
    const upper = await h.request('GET', '/v1/api-keys', {
      cookie: owner.cookie,
      project: owner.projectId.toUpperCase(),
    });
    expect(upper.status).toBe(200);
  });

  it('answers NOT_FOUND for a project the person cannot reach, real or not', async () => {
    const h = keysHarness();
    const alice = await h.member('owner');
    const bob = await h.member('owner');
    for (const project of [bob.projectId, randomUUID()]) {
      const answer = await h.request('GET', '/v1/api-keys', { cookie: alice.cookie, project });
      expect(answer.status).toBe(404);
      expect(codeOf(answer)).toBe('NOT_FOUND');
    }
  });
});

describe('revoking a key', () => {
  it('stops the key at once, writes an audit entry, and is permanent', async () => {
    const h = keysHarness();
    const owner = await h.member('owner');
    const key = await h.keyFor(owner, ['payouts:read']);
    expect((await h.request('GET', '/v1/probe', { key })).status).toBe(200);
    const [id] = [...h.keys.rows.keys()];
    const as = { cookie: owner.cookie, project: owner.projectId };
    h.clock.now += 1000;
    const revoked = await h.request('DELETE', `/v1/api-keys/${String(id)}`, as);
    expect(revoked.status).toBe(200);
    expect(revoked.json?.['apiKey']).toMatchObject({
      id,
      revokedAt: new Date(START + 1000).toISOString(),
    });
    expect(h.keys.audit.map((a) => a.action)).toEqual(['api_key.created', 'api_key.revoked']);
    expect(h.keys.audit[1]).toMatchObject({ actorId: owner.memberId, targetId: id });

    // Within the cache window, yet refused: the revoke told this instance.
    const after = await h.request('GET', '/v1/probe', { key });
    expect(after.status).toBe(401);
    expect(codeOf(after)).toBe('TOKEN_INVALID');

    // Again is the same answer, and no second entry.
    const again = await h.request('DELETE', `/v1/api-keys/${String(id)}`, as);
    expect(again.json).toEqual(revoked.json);
    expect(h.keys.audit).toHaveLength(2);
  });

  it("answers NOT_FOUND for another project's key, and leaves it working", async () => {
    const h = keysHarness();
    const alice = await h.member('owner');
    const bob = await h.member('owner');
    const bobsKey = await h.keyFor(bob, ['payouts:read']);
    const [id] = [...h.keys.rows.keys()];
    for (const target of [String(id), randomUUID()]) {
      const answer = await h.request('DELETE', `/v1/api-keys/${target}`, {
        cookie: alice.cookie,
        project: alice.projectId,
      });
      expect(answer.status).toBe(404);
      expect(codeOf(answer)).toBe('NOT_FOUND');
    }
    expect((await h.request('GET', '/v1/probe', { key: bobsKey })).status).toBe(200);
    const bad = await h.request('DELETE', '/v1/api-keys/not-a-uuid', {
      cookie: alice.cookie,
      project: alice.projectId,
    });
    expect(bad.status).toBe(400);
  });
});

describe('listing keys', () => {
  it('shows a project only its own keys, in pages', async () => {
    const h = keysHarness();
    const alice = await h.member('owner');
    const sibling = await h.member('owner', {
      principalId: alice.principalId,
      projectId: randomUUID(),
    });
    const bob = await h.member('owner');
    for (let n = 0; n < 3; n += 1) await h.keyFor(alice, ['payouts:read']);
    await h.keyFor(sibling, ['payouts:read']);
    await h.keyFor(bob, ['payouts:read']);
    const as = { cookie: alice.cookie, project: alice.projectId };

    const first = await h.request('GET', '/v1/api-keys?limit=2', as);
    const firstItems = first.json?.['items'] as { projectId: string }[];
    expect(firstItems).toHaveLength(2);
    const cursor = String(first.json?.['nextCursor']);
    const second = await h.request('GET', `/v1/api-keys?limit=2&cursor=${cursor}`, as);
    const secondItems = second.json?.['items'] as { projectId: string }[];
    expect(secondItems).toHaveLength(1);
    expect(second.json?.['nextCursor']).toBeNull();
    for (const item of [...firstItems, ...secondItems])
      expect(item.projectId).toBe(alice.projectId);

    for (const query of ['limit=0', 'limit=101', 'limit=x', 'cursor=@@', 'cursor=e30']) {
      const refused = await h.request('GET', `/v1/api-keys?${query}`, as);
      expect(refused.status, query).toBe(400);
    }
  });
});

describe('authenticate', () => {
  it('runs a key as its own tenant, whatever project a header names', async () => {
    const h = keysHarness();
    const owner = await h.member('owner');
    const key = await h.keyFor(owner, ['payouts:read']);
    const answer = await h.request('GET', '/v1/probe', { key, project: randomUUID() });
    expect(answer.status).toBe(200);
    expect(answer.json).toEqual({
      kind: 'key',
      principalId: owner.principalId,
      projectId: owner.projectId,
    });
  });

  it('answers FORBIDDEN to a key without the route scope', async () => {
    const h = keysHarness();
    const owner = await h.member('owner');
    const reader = await h.keyFor(owner, ['payouts:read']);
    const refused = await h.request('POST', '/v1/probe', {
      key: reader,
      body: { n: 1 },
      headers: { 'idempotency-key': 'run-1' },
    });
    expect(refused.status).toBe(403);
    expect(codeOf(refused)).toBe('FORBIDDEN');
    const writerOnly = await h.keyFor(owner, ['payouts:write']);
    expect((await h.request('GET', '/v1/probe', { key: writerOnly })).status).toBe(403);
  });

  it('is the authenticate of an idempotent write, which stores the key per tenant', async () => {
    const h = keysHarness();
    const owner = await h.member('owner');
    const writer = await h.keyFor(owner, ['payouts:write']);
    const send = () =>
      h.request('POST', '/v1/probe', {
        key: writer,
        body: { n: 1 },
        headers: { 'idempotency-key': 'run-1' },
      });
    const first = await send();
    expect(first.status).toBe(202);
    expect(first.json).toEqual({
      kind: 'key',
      principalId: owner.principalId,
      projectId: owner.projectId,
    });
    const replay = await send();
    expect(replay.headers.get('idempotent-replayed')).toBe('true');
    const missing = await h.request('POST', '/v1/probe', { key: writer, body: { n: 1 } });
    expect(codeOf(missing)).toBe('IDEMPOTENCY_KEY_REQUIRED');
  });

  it('runs a session in the project it names, as far as the role goes', async () => {
    const h = keysHarness();
    const owner = await h.member('owner');
    const viewer = await h.member('viewer', owner);
    const developer = await h.member('developer', owner);
    const read = await h.request('GET', '/v1/probe', {
      cookie: viewer.cookie,
      project: owner.projectId,
    });
    expect(read.json).toEqual({
      kind: 'session',
      principalId: owner.principalId,
      projectId: owner.projectId,
    });
    const write = (cookie: string, n: number) =>
      h.request('POST', '/v1/probe', {
        cookie,
        project: owner.projectId,
        body: { n },
        headers: { 'idempotency-key': `w-${String(n)}` },
      });
    const viewerWrite = await write(viewer.cookie, 1);
    expect(viewerWrite.status).toBe(403);
    expect(codeOf(viewerWrite)).toBe('FORBIDDEN');
    expect((await write(developer.cookie, 2)).status).toBe(202);
  });

  it('answers TOKEN_MALFORMED to a session on a route for keys only', async () => {
    const h = keysHarness();
    const owner = await h.member('owner');
    const answer = await h.request('GET', '/v1/probe/key', {
      cookie: owner.cookie,
      project: owner.projectId,
    });
    expect(answer.status).toBe(401);
    expect(codeOf(answer)).toBe('TOKEN_MALFORMED');
    const key = await h.keyFor(owner, ['payouts:read']);
    expect((await h.request('GET', '/v1/probe/key', { key })).status).toBe(200);
  });

  it.each([
    ['a malformed key', 'ujk_test_nope', 'TOKEN_MALFORMED'],
    ['an unknown key', issueToken('test').token, 'TOKEN_INVALID'],
    ['a live key on testnet', issueToken('live').token, 'TOKEN_ENVIRONMENT_MISMATCH'],
  ])('answers 401 to %s', async (_name, key, code) => {
    const h = keysHarness();
    const answer = await h.request('GET', '/v1/probe', { key });
    expect(answer.status).toBe(401);
    expect(codeOf(answer)).toBe(code);
  });

  it('answers TOKEN_INVALID to an expired key', async () => {
    const h = keysHarness();
    const owner = await h.member('owner');
    const key = await h.keyFor(owner, ['payouts:read'], { expiresInDays: 1 });
    h.clock.now += DAY_MS;
    const answer = await h.request('GET', '/v1/probe', { key });
    expect(answer.status).toBe(401);
    expect(codeOf(answer)).toBe('TOKEN_INVALID');
  });

  it('answers ORIGIN_NOT_ALLOWED to a key sent from a web page', async () => {
    const h = keysHarness();
    const owner = await h.member('owner');
    const key = await h.keyFor(owner, ['payouts:read']);
    const answer = await h.request('GET', '/v1/probe', { key, origin: 'https://ujira.co' });
    expect(answer.status).toBe(403);
    expect(codeOf(answer)).toBe('ORIGIN_NOT_ALLOWED');
  });

  it('never falls back to the session when a key is refused', async () => {
    const h = keysHarness();
    const owner = await h.member('owner');
    const answer = await h.request('GET', '/v1/probe', {
      cookie: owner.cookie,
      project: owner.projectId,
      key: issueToken('test').token,
    });
    expect(answer.status).toBe(401);
    expect(codeOf(answer)).toBe('TOKEN_INVALID');
  });

  it('answers 503 when the key lookup cannot reach the database', async () => {
    const h = keysHarness();
    h.keys.findFails = new DatabaseUnavailableError('connect');
    const answer = await h.request('GET', '/v1/probe', { key: issueToken('test').token });
    expect(answer.status).toBe(503);
    expect(codeOf(answer)).toBe('DB_UNAVAILABLE');
  });
});

describe('logs and the document', () => {
  it('never carry a key, its prefix or its secret', async () => {
    const h = keysHarness();
    const owner = await h.member('owner');
    const key = await h.keyFor(owner, ['payouts:read']);
    await h.request('GET', '/v1/probe', { key });
    await h.request('GET', '/v1/probe', { key: `${key}x` });
    await h.request('GET', '/v1/probe', { key: issueToken('live').token });
    const [id] = [...h.keys.rows.keys()];
    await h.request('DELETE', `/v1/api-keys/${String(id)}`, {
      cookie: owner.cookie,
      project: owner.projectId,
    });
    await h.request('GET', '/v1/probe', { key });
    expect(h.lines.length).toBeGreaterThan(0);
    for (const line of h.lines) {
      expect(line).not.toMatch(/ujk_/);
      expect(line).not.toContain(key.slice(9, 25));
      expect(line).not.toContain(key.slice(26, 78));
    }
  });

  it('documents the key routes in a valid OpenAPI 3.1 document', async () => {
    const h = keysHarness();
    const res = await h.request('GET', '/v1/openapi.json');
    const result = await new Validator().validate(res.json ?? {});
    expect(result.errors).toBeUndefined();
    const paths = (res.json?.['paths'] ?? {}) as Record<string, Record<string, unknown>>;
    expect(Object.keys(paths['/v1/api-keys'] ?? {}).sort()).toEqual(['get', 'post']);
    expect(Object.keys(paths['/v1/api-keys/{id}'] ?? {})).toEqual(['delete']);
    const create = paths['/v1/api-keys']?.['post'] as { responses: Record<string, unknown> };
    expect(Object.keys(create.responses)).toEqual(
      expect.arrayContaining(['201', '400', '401', '403', '404', '409', '503']),
    );
  });
});
