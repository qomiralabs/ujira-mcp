// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// Key authentication on its own, against keys held in memory: who gets in,
// what never reaches the store, what is recorded, how long a lookup is
// trusted, and that no path writes the key into a log line.

import * as crypto from 'node:crypto';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createApiKeyService } from '../src/auth/api-key-service.js';
import {
  createTokenAuthenticator,
  TOKEN_CACHE_MAX_TTL_MS,
  TokenRecordError,
  type TokenAuthOptions,
} from '../src/auth/token-auth.js';
import type { ApiScope } from '../src/auth/scopes.js';
import { formatToken, issueToken, parseToken } from '../src/auth/token.js';
import { MemoryKeys } from './api-key-helpers.js';
import { START, type Clock } from './sign-in-helpers.js';

// Counted, not replaced: the real compare still runs.
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return { ...actual, timingSafeEqual: vi.fn(actual.timingSafeEqual) };
});
const compare = vi.mocked(crypto.timingSafeEqual);

const TENANT = { principalId: crypto.randomUUID(), projectId: crypto.randomUUID() };
const REQUEST = 'req-1';

interface Setup {
  readonly clock: Clock;
  readonly keys: MemoryKeys;
  readonly lines: string[];
  readonly auth: ReturnType<typeof createTokenAuthenticator>;
  /** A key in TENANT with these scopes, as the service would make it. */
  issue(scopes?: readonly ApiScope[], days?: number): Promise<{ secret: string; id: string }>;
}

function setup(over: Partial<TokenAuthOptions> = {}): Setup {
  const clock: Clock = { now: START };
  const now = () => new Date(clock.now);
  const keys = new MemoryKeys(clock);
  const lines: string[] = [];
  const log = (line: string) => {
    lines.push(line);
  };
  const auth = createTokenAuthenticator({ store: keys, environment: 'test', log, now, ...over });
  const service = createApiKeyService({ records: keys, environment: 'test', now });
  return {
    clock,
    keys,
    lines,
    auth,
    async issue(scopes = ['payouts:read'], days = 30) {
      const made = await service.create(
        { name: 'runner', scopes, expiresInDays: days },
        { tenant: TENANT, actorId: 'member-1' },
      );
      return { secret: made.secret, id: made.apiKey.id };
    },
  };
}

/** The same key id with another secret, checksummed, so it gets as far as the compare. */
function forge(key: string): string {
  const other = parseToken(issueToken('test').token)?.secret ?? '';
  return formatToken(key.slice(0, 25), other);
}

function bearer(key: string) {
  return { authorization: `Bearer ${key}`, origin: null };
}

beforeEach(() => {
  compare.mockClear();
});

describe('who gets in', () => {
  it('lets a good key in as its tenant, with its scopes', async () => {
    const s = setup();
    const { secret, id } = await s.issue(['payouts:read', 'payouts:write']);
    const result = await s.auth.authenticate(bearer(secret), REQUEST);
    expect(result).toEqual({
      ok: true,
      tenant: {
        ...TENANT,
        tokenId: id,
        prefix: secret.slice(0, 25),
        scopes: ['payouts:read', 'payouts:write'],
      },
    });
  });

  it('reads the scheme case blind, as HTTP does', async () => {
    const s = setup();
    const { secret } = await s.issue();
    const result = await s.auth.authenticate(
      { authorization: `bearer ${secret}`, origin: null },
      REQUEST,
    );
    expect(result.ok).toBe(true);
  });

  it('answers TOKEN_INVALID alike for unknown, wrong secret, expired and revoked keys', async () => {
    const s = setup();
    const unknown = issueToken('test').token;
    const good = await s.issue();
    const wrongSecret = forge(good.secret);
    const expired = await s.issue(['payouts:read'], 1);
    const revoked = await s.issue();
    await s.keys.revoke(TENANT, revoked.id, 'member-1');
    s.clock.now += 86_400_000;

    for (const key of [unknown, wrongSecret, expired.secret, revoked.secret]) {
      expect(await s.auth.authenticate(bearer(key), REQUEST), key.slice(0, 8)).toEqual({
        ok: false,
        code: 'TOKEN_INVALID',
      });
    }
    // The good key still works, so the refusals above were about each key.
    expect((await s.auth.authenticate(bearer(good.secret), REQUEST)).ok).toBe(true);
  });

  it('compares a secret in constant time on every path that reaches the store', async () => {
    const s = setup();
    const good = await s.issue();
    const revoked = await s.issue();
    await s.keys.revoke(TENANT, revoked.id, 'member-1');
    const cases = [issueToken('test').token, revoked.secret, good.secret];
    for (const key of cases) {
      compare.mockClear();
      await s.auth.authenticate(bearer(key), REQUEST);
      // Exactly one compare of two 32 byte digests, found or not.
      expect(compare, key.slice(0, 8)).toHaveBeenCalledTimes(1);
      const [a, b] = compare.mock.calls[0] ?? [];
      expect((a as Buffer).length).toBe(32);
      expect((b as Buffer).length).toBe(32);
    }
  });

  it('refuses a stored hash of the wrong length as a mismatch, not a crash', async () => {
    const s = setup();
    const { secret, id } = await s.issue();
    const row = s.keys.rows.get(id);
    if (row === undefined) throw new Error('missing row');
    s.keys.rows.set(id, { ...row, secretSha256: Buffer.alloc(16) });
    expect(await s.auth.authenticate(bearer(secret), REQUEST)).toEqual({
      ok: false,
      code: 'TOKEN_INVALID',
    });
  });

  it('fails closed on a stored scope this code does not know', async () => {
    const s = setup();
    const { secret, id } = await s.issue();
    const row = s.keys.rows.get(id);
    if (row === undefined) throw new Error('missing row');
    s.keys.rows.set(id, { ...row, scopes: ['admin:all'] });
    await expect(s.auth.authenticate(bearer(secret), REQUEST)).rejects.toBeInstanceOf(
      TokenRecordError,
    );
  });

  it('lets a store outage through, so the caller answers 503 rather than 401', async () => {
    const s = setup();
    const { secret } = await s.issue();
    const outage = new Error('db down');
    s.keys.findFails = outage;
    await expect(s.auth.authenticate(bearer(secret), REQUEST)).rejects.toBe(outage);
  });
});

describe('what never reaches the store', () => {
  it.each([
    ['no header', null],
    ['another scheme', 'Basic dXNlcjpwYXNz'],
    ['a bad checksum', `Bearer ${issueToken('test').token.slice(0, -1)}a`],
    ['two values', `Bearer ${issueToken('test').token} extra`],
    ['an empty bearer', 'Bearer '],
  ])('answers TOKEN_MALFORMED for %s with no lookup', async (_name, authorization) => {
    const s = setup();
    const result = await s.auth.authenticate({ authorization, origin: null }, REQUEST);
    expect(result).toEqual({ ok: false, code: 'TOKEN_MALFORMED' });
    expect(s.keys.finds).toBe(0);
    expect(s.keys.events).toEqual([]);
  });

  it('refuses a live key on testnet with TOKEN_ENVIRONMENT_MISMATCH', async () => {
    const s = setup();
    const live = issueToken('live');
    const result = await s.auth.authenticate(bearer(live.token), REQUEST);
    expect(result).toEqual({ ok: false, code: 'TOKEN_ENVIRONMENT_MISMATCH' });
    expect(s.keys.finds).toBe(0);
  });

  it('refuses a test key where live keys are expected', async () => {
    const s = setup({ environment: 'live' });
    const result = await s.auth.authenticate(bearer(issueToken('test').token), REQUEST);
    expect(result).toEqual({ ok: false, code: 'TOKEN_ENVIRONMENT_MISMATCH' });
  });

  it('refuses a key sent from a web page, whatever the page', async () => {
    const s = setup();
    const { secret } = await s.issue();
    for (const origin of ['https://ujira.co', 'https://evil.example', 'null']) {
      const result = await s.auth.authenticate(
        { authorization: `Bearer ${secret}`, origin },
        REQUEST,
      );
      expect(result, origin).toEqual({ ok: false, code: 'ORIGIN_NOT_ALLOWED' });
    }
    expect(s.keys.finds).toBe(0);
  });

  it('accepts an origin that was allowed by name', async () => {
    const s = setup({ allowedOrigins: ['https://partner.example'] });
    const { secret } = await s.issue();
    const result = await s.auth.authenticate(
      { authorization: `Bearer ${secret}`, origin: 'https://partner.example' },
      REQUEST,
    );
    expect(result.ok).toBe(true);
  });
});

describe('security events', () => {
  it('records a key that fails the lookup, by its prefix only', async () => {
    const s = setup();
    const unknown = issueToken('test');
    await s.auth.authenticate(bearer(unknown.token), REQUEST);
    expect(s.keys.events).toEqual([{ kind: 'token_invalid', tokenPrefix: unknown.prefix }]);
  });

  it('records a key from the wrong environment', async () => {
    const s = setup();
    const live = issueToken('live');
    await s.auth.authenticate(bearer(live.token), REQUEST);
    expect(s.keys.events).toEqual([{ kind: 'token_env_mismatch', tokenPrefix: live.prefix }]);
  });

  it('records nothing for a good key', async () => {
    const s = setup();
    const { secret } = await s.issue();
    await s.auth.authenticate(bearer(secret), REQUEST);
    expect(s.keys.events).toEqual([]);
  });

  it('still refuses when the record cannot be written, and logs that it was lost', async () => {
    const s = setup();
    s.keys.eventFails = new Error('ops schema down');
    const result = await s.auth.authenticate(bearer(issueToken('test').token), REQUEST);
    expect(result).toEqual({ ok: false, code: 'TOKEN_INVALID' });
    expect(s.lines).toContain(`event=security_event_failed requestId=${REQUEST} error=Error`);
  });
});

describe('the lookup cache', () => {
  it('looks a key up once within its window, and again after it', async () => {
    const s = setup();
    const { secret } = await s.issue();
    await s.auth.authenticate(bearer(secret), REQUEST);
    await s.auth.authenticate(bearer(secret), REQUEST);
    expect(s.keys.finds).toBe(1);
    s.clock.now += TOKEN_CACHE_MAX_TTL_MS;
    await s.auth.authenticate(bearer(secret), REQUEST);
    expect(s.keys.finds).toBe(2);
  });

  it('never holds a key longer than 30 seconds, whatever it is told', async () => {
    const s = setup({ cacheTtlMs: 3_600_000 });
    const { secret } = await s.issue();
    await s.auth.authenticate(bearer(secret), REQUEST);
    s.clock.now += TOKEN_CACHE_MAX_TTL_MS;
    await s.auth.authenticate(bearer(secret), REQUEST);
    expect(s.keys.finds).toBe(2);
  });

  it('still compares the secret on a hit', async () => {
    const s = setup();
    const { secret } = await s.issue();
    await s.auth.authenticate(bearer(secret), REQUEST);
    expect(await s.auth.authenticate(bearer(forge(secret)), REQUEST)).toEqual({
      ok: false,
      code: 'TOKEN_INVALID',
    });
  });

  it('stops a revoked key at once once it is forgotten here, and at the window elsewhere', async () => {
    const s = setup();
    const { secret, id } = await s.issue();
    await s.auth.authenticate(bearer(secret), REQUEST);
    await s.keys.revoke(TENANT, id, 'member-1');
    // Another instance would still hold it for the rest of its window.
    expect((await s.auth.authenticate(bearer(secret), REQUEST)).ok).toBe(true);
    s.auth.forget(secret.slice(0, 25));
    expect((await s.auth.authenticate(bearer(secret), REQUEST)).ok).toBe(false);
  });

  it('stops a key at its expiry even while it is cached', async () => {
    const s = setup();
    const { secret } = await s.issue(['payouts:read'], 1);
    s.clock.now += 86_400_000 - 10_000;
    expect((await s.auth.authenticate(bearer(secret), REQUEST)).ok).toBe(true);
    s.clock.now += 10_000;
    expect((await s.auth.authenticate(bearer(secret), REQUEST)).ok).toBe(false);
  });

  it('caches no failure, so a key created a moment later works', async () => {
    const s = setup();
    const { secret, id } = await s.issue();
    const row = s.keys.rows.get(id);
    if (row === undefined) throw new Error('missing row');
    s.keys.rows.delete(id);
    expect((await s.auth.authenticate(bearer(secret), REQUEST)).ok).toBe(false);
    s.keys.rows.set(id, row);
    expect((await s.auth.authenticate(bearer(secret), REQUEST)).ok).toBe(true);
  });

  it('holds a bounded number of keys, dropping the oldest', async () => {
    const s = setup({ cacheMaxEntries: 2 });
    const a = await s.issue();
    const b = await s.issue();
    const c = await s.issue();
    for (const key of [a, b, c]) await s.auth.authenticate(bearer(key.secret), REQUEST);
    expect(s.keys.finds).toBe(3);
    await s.auth.authenticate(bearer(c.secret), REQUEST);
    await s.auth.authenticate(bearer(b.secret), REQUEST);
    expect(s.keys.finds).toBe(3);
    await s.auth.authenticate(bearer(a.secret), REQUEST);
    expect(s.keys.finds).toBe(4);
  });
});

describe('last used', () => {
  it('is recorded on a lookup, not on a cache hit, and not for a refused key', async () => {
    const s = setup();
    const { secret, id } = await s.issue();
    await s.auth.authenticate(bearer(issueToken('test').token), REQUEST);
    expect(s.keys.touches).toBe(0);
    await s.auth.authenticate(bearer(secret), REQUEST);
    await s.auth.authenticate(bearer(secret), REQUEST);
    expect(s.keys.touches).toBe(1);
    expect(s.keys.rows.get(id)?.lastUsedAt).toEqual(new Date(START));
  });

  it('a failure to record it is logged and does not refuse the key', async () => {
    const s = setup();
    const { secret } = await s.issue();
    s.keys.touchFails = new Error('busy');
    expect((await s.auth.authenticate(bearer(secret), REQUEST)).ok).toBe(true);
    expect(s.lines).toContain(`event=token_touch_failed requestId=${REQUEST} error=Error`);
  });
});

describe('logs', () => {
  it('never carry a key, its prefix or its hash, on any path', async () => {
    const s = setup();
    const good = await s.issue();
    const live = issueToken('live');
    const unknown = issueToken('test');
    const keys = [good.secret, live.token, unknown.token, `${good.secret}x`];
    for (const key of keys) await s.auth.authenticate(bearer(key), REQUEST);
    expect(s.lines.length).toBeGreaterThan(0);
    for (const line of s.lines) {
      expect(line).not.toMatch(/ujk_/);
      for (const key of keys) expect(line).not.toContain(key.slice(9, 25));
    }
    expect(s.lines).toContain(`event=token_refused requestId=${REQUEST} reason=TOKEN_INVALID`);
  });
});
