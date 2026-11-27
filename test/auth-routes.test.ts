// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// Wallet sign in on /v1 with a store that keeps the database's rules in
// memory and a clock the tests move. The same routes run against Postgres in
// auth-routes.db.test.ts.

import { createHash, randomUUID } from 'node:crypto';

import { Validator } from '@seriousme/openapi-schema-validator';
import { describe, expect, it } from 'vitest';

import { loadSignInSettings, signInEnabled } from '../src/auth/settings.js';
import { newSessionToken, SESSION_COOKIE, sessionTokenHash } from '../src/auth/session-token.js';
import {
  SESSION_ABSOLUTE_SECONDS,
  SESSION_IDLE_SECONDS,
  SIGN_IN_LIMITS,
} from '../src/auth/sign-in.js';
import { parseWalletMessage } from '../src/auth/wallet-message.js';
import { DatabaseUnavailableError } from '../src/db/index.js';
import {
  errorCode,
  memoryHarness,
  ORIGIN,
  signBase64,
  signInWith,
  START,
  wallet,
} from './sign-in-helpers.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

describe('session tokens', () => {
  it('are 32 random bytes, found by the SHA-256 of those bytes', () => {
    const token = newSessionToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(newSessionToken()).not.toBe(token);
    const expected = createHash('sha256').update(Buffer.from(token, 'base64url')).digest();
    expect(sessionTokenHash(token)?.equals(expected)).toBe(true);
  });

  it('refuses anything this server could not have issued', () => {
    const token = newSessionToken();
    for (const bad of ['', 'short', `${token}A`, `${token.slice(0, 42)}+`, ' '.repeat(43)]) {
      expect(sessionTokenHash(bad), bad).toBeUndefined();
    }
    // The last character carries two spare bits, zero in the canonical form;
    // the next character decodes to the same bytes and is still refused.
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const index = alphabet.indexOf(token.at(-1) ?? 'A');
    const sibling = `${token.slice(0, 42)}${alphabet[index + 1] ?? 'B'}`;
    expect(Buffer.from(sibling, 'base64url').equals(Buffer.from(token, 'base64url'))).toBe(true);
    expect(sessionTokenHash(sibling)).toBeUndefined();
  });
});

describe('POST /v1/auth/challenge', () => {
  it('issues a sign in message for this site and that wallet, for 10 minutes', async () => {
    const h = memoryHarness();
    const kp = wallet();
    const res = await h.call('POST', '/v1/auth/challenge', { body: { address: kp.publicKey() } });
    expect(res.status).toBe(201);
    expect(Object.keys(res.json ?? {}).sort()).toEqual(['challengeId', 'expiresAt', 'message']);
    const message = parseWalletMessage(String(res.json?.['message']));
    expect(message).toMatchObject({ purpose: 'sign_in', origin: ORIGIN, address: kp.publicKey() });
    expect(res.json?.['expiresAt']).toBe(new Date(START + 10 * MINUTE).toISOString());
    const row = h.store.challenges.get(String(res.json?.['challengeId']));
    expect(row).toMatchObject({ wallet: kp.publicKey(), consumed: false });
    expect(row?.message).toBe(res.json?.['message']);
  });

  it('stores the address in the form the adapter writes it', async () => {
    const h = memoryHarness();
    const kp = wallet();
    const res = await h.call('POST', '/v1/auth/challenge', {
      body: { address: ` ${kp.publicKey()} ` },
    });
    expect(res.status).toBe(201);
    expect(h.store.challenges.get(String(res.json?.['challengeId']))?.wallet).toBe(kp.publicKey());
  });

  it('refuses an address that is not an account, and any extra field', async () => {
    const h = memoryHarness();
    const bad = await h.call('POST', '/v1/auth/challenge', { body: { address: 'GNOTANACCOUNT' } });
    expect(bad.status).toBe(400);
    expect(bad.json).toMatchObject({
      error: {
        code: 'INVALID_REQUEST',
        details: [{ path: 'body.address', issue: 'invalid_address' }],
      },
    });
    const extra = await h.call('POST', '/v1/auth/challenge', {
      body: { address: wallet().publicKey(), purpose: 'recipient_wallet' },
    });
    expect(extra.status).toBe(400);
    expect(errorCode(extra)).toBe('INVALID_REQUEST');
    expect(h.store.challenges.size).toBe(0);
  });

  it('is rate limited per address, with Retry-After', async () => {
    const h = memoryHarness();
    const kp = wallet();
    const ask = (client: string) =>
      h.call('POST', '/v1/auth/challenge', { body: { address: kp.publicKey() }, client });
    for (let i = 0; i < SIGN_IN_LIMITS.challengePerAddress.capacity; i += 1) {
      // A new client each time, so only the address bucket can run out.
      expect((await ask(`198.51.100.${i}`)).status).toBe(201);
    }
    const limited = await ask('198.51.100.200');
    expect(limited.status).toBe(429);
    expect(errorCode(limited)).toBe('RATE_LIMITED');
    expect(limited.headers.get('retry-after')).toBe('1');
    // Another wallet from the same client is not held up by this one.
    const other = await h.call('POST', '/v1/auth/challenge', {
      body: { address: wallet().publicKey() },
      client: '198.51.100.200',
    });
    expect(other.status).toBe(201);
    h.clock.now += 1000;
    expect((await ask('198.51.100.201')).status).toBe(201);
  });

  it('is rate limited per client address', async () => {
    const h = memoryHarness();
    const ask = () =>
      h.call('POST', '/v1/auth/challenge', {
        body: { address: wallet().publicKey() },
        client: '192.0.2.9',
      });
    for (let i = 0; i < SIGN_IN_LIMITS.challengePerClient.capacity; i += 1) {
      expect((await ask()).status).toBe(201);
    }
    expect((await ask()).status).toBe(429);
    const elsewhere = await h.call('POST', '/v1/auth/challenge', {
      body: { address: wallet().publicKey() },
      client: '192.0.2.10',
    });
    expect(elsewhere.status).toBe(201);
  });

  it('keys buckets by digest, never by the address or the client', async () => {
    const h = memoryHarness();
    const kp = wallet();
    await h.call('POST', '/v1/auth/challenge', {
      body: { address: kp.publicKey() },
      client: '192.0.2.77',
    });
    const keys = [...h.store.bucketKeys];
    expect(keys).toHaveLength(2);
    for (const key of keys) {
      expect(key).toMatch(/^[a-z_]{1,32}:[0-9a-f]{64}$/);
      expect(key).not.toContain(kp.publicKey());
      expect(key).not.toContain('192.0.2.77');
    }
  });
});

describe('POST /v1/auth/session', () => {
  it('starts a session from a Freighter signature and sets the cookie', async () => {
    const h = memoryHarness();
    const kp = wallet();
    const principal = { principalId: randomUUID(), name: 'Acme', role: 'owner' };
    h.store.grant(kp.publicKey(), principal);
    const { answer, token } = await signInWith(h.call, kp);
    expect(answer.status).toBe(200);
    expect(answer.json).toEqual({
      member: { id: h.store.members.get(kp.publicKey()), address: kp.publicKey() },
      principals: [{ id: principal.principalId, name: 'Acme', role: 'owner' }],
    });
    expect(answer.cookies).toHaveLength(1);
    const cookie = answer.cookies[0] ?? '';
    expect(cookie.startsWith(`${SESSION_COOKIE}=`)).toBe(true);
    const attributes = cookie
      .split(';')
      .slice(1)
      .map((a) => a.trim());
    expect(attributes).toEqual(
      expect.arrayContaining([
        'HttpOnly',
        'Secure',
        'SameSite=Lax',
        'Path=/v1',
        `Max-Age=${String(SESSION_ABSOLUTE_SECONDS)}`,
      ]),
    );
    // Only the hash is kept.
    expect(token).toBeDefined();
    const stored = [...h.store.sessions.keys()];
    expect(stored).toEqual([sessionTokenHash(token ?? '')?.toString('hex')]);
    expect(stored[0]).not.toContain(token);
    const row = h.store.sessions.get(stored[0] ?? '');
    expect(row?.idle).toBe(START + SESSION_IDLE_SECONDS * 1000);
    expect(row?.absolute).toBe(START + SESSION_ABSOLUTE_SECONDS * 1000);
  });

  it('accepts an Albedo signature in hex', async () => {
    const h = memoryHarness();
    const { answer, token } = await signInWith(h.call, wallet(), { hex: true });
    expect(answer.status).toBe(200);
    expect(token).toBeDefined();
  });

  it('refuses a challenge used once already', async () => {
    const h = memoryHarness();
    const kp = wallet();
    const first = await signInWith(h.call, kp);
    expect(first.answer.status).toBe(200);
    const again = await h.call('POST', '/v1/auth/session', {
      body: {
        challengeId: first.challengeId,
        address: kp.publicKey(),
        signature: signBase64(kp, first.message),
      },
    });
    expect(again.status).toBe(401);
    expect(errorCode(again)).toBe('SESSION_INVALID');
    expect(again.cookies).toEqual([]);
  });

  it('refuses a challenge after 10 minutes', async () => {
    const h = memoryHarness();
    const kp = wallet();
    const challenge = await h.call('POST', '/v1/auth/challenge', {
      body: { address: kp.publicKey() },
    });
    h.clock.now += 10 * MINUTE;
    const late = await h.call('POST', '/v1/auth/session', {
      body: {
        challengeId: challenge.json?.['challengeId'],
        address: kp.publicKey(),
        signature: signBase64(kp, String(challenge.json?.['message'])),
      },
    });
    expect(late.status).toBe(401);
    expect(errorCode(late)).toBe('SESSION_INVALID');
  });

  it('refuses an unknown challenge, and another wallet presenting one', async () => {
    const h = memoryHarness();
    const kp = wallet();
    const thief = wallet();
    const unknown = await h.call('POST', '/v1/auth/session', {
      body: { challengeId: randomUUID(), address: kp.publicKey(), signature: 'x'.repeat(128) },
    });
    expect(errorCode(unknown)).toBe('SESSION_INVALID');
    const challenge = await h.call('POST', '/v1/auth/challenge', {
      body: { address: kp.publicKey() },
    });
    const stolen = await h.call('POST', '/v1/auth/session', {
      body: {
        challengeId: challenge.json?.['challengeId'],
        address: thief.publicKey(),
        signature: signBase64(thief, String(challenge.json?.['message'])),
      },
    });
    expect(stolen.status).toBe(401);
    expect(errorCode(stolen)).toBe('SESSION_INVALID');
    // The owner's challenge is still theirs to use.
    const mine = await h.call('POST', '/v1/auth/session', {
      body: {
        challengeId: challenge.json?.['challengeId'],
        address: kp.publicKey(),
        signature: signBase64(kp, String(challenge.json?.['message'])),
      },
    });
    expect(mine.status).toBe(200);
  });

  it('treats a bad signature as a security event, and spends the challenge', async () => {
    const h = memoryHarness();
    const kp = wallet();
    const challenge = await h.call('POST', '/v1/auth/challenge', {
      body: { address: kp.publicKey() },
    });
    const message = String(challenge.json?.['message']);
    const forged = await h.call('POST', '/v1/auth/session', {
      body: {
        challengeId: challenge.json?.['challengeId'],
        address: kp.publicKey(),
        signature: signBase64(wallet(), message),
      },
    });
    expect(forged.status).toBe(401);
    expect(errorCode(forged)).toBe('SESSION_INVALID');
    expect(h.store.events).toEqual(['sign_in_failed']);
    expect(h.lines.some((l) => l.includes('event=security_event kind=sign_in_failed'))).toBe(true);
    expect(h.store.sessions.size).toBe(0);
    const retry = await h.call('POST', '/v1/auth/session', {
      body: {
        challengeId: challenge.json?.['challengeId'],
        address: kp.publicKey(),
        signature: signBase64(kp, message),
      },
    });
    expect(errorCode(retry)).toBe('SESSION_INVALID');
  });

  it('treats a signature that is not one as a security event too', async () => {
    const h = memoryHarness();
    const kp = wallet();
    const challenge = await h.call('POST', '/v1/auth/challenge', {
      body: { address: kp.publicKey() },
    });
    const res = await h.call('POST', '/v1/auth/session', {
      body: {
        challengeId: challenge.json?.['challengeId'],
        address: kp.publicKey(),
        signature: 'not a signature',
      },
    });
    expect(errorCode(res)).toBe('SESSION_INVALID');
    expect(h.store.events).toEqual(['sign_in_failed']);
  });

  it('answers 403 ORIGIN_NOT_ALLOWED from another site, before spending anything', async () => {
    const h = memoryHarness();
    const kp = wallet();
    const challenge = await h.call('POST', '/v1/auth/challenge', {
      body: { address: kp.publicKey() },
    });
    const body = {
      challengeId: challenge.json?.['challengeId'],
      address: kp.publicKey(),
      signature: signBase64(kp, String(challenge.json?.['message'])),
    };
    for (const origin of ['https://evil.example', 'https://ujira.co.evil.example', null]) {
      const res = await h.call('POST', '/v1/auth/session', { body, origin });
      expect(res.status, String(origin)).toBe(403);
      expect(errorCode(res)).toBe('ORIGIN_NOT_ALLOWED');
      expect(res.cookies).toEqual([]);
    }
    expect((await h.call('POST', '/v1/auth/session', { body })).status).toBe(200);
  });

  it('refuses a malformed body before touching the store', async () => {
    const h = memoryHarness();
    const kp = wallet();
    for (const body of [
      { challengeId: 'not-a-uuid', address: kp.publicKey(), signature: 'abc' },
      { challengeId: randomUUID(), address: kp.publicKey() },
      { challengeId: randomUUID(), address: kp.publicKey(), signature: 'a'.repeat(257) },
    ]) {
      const res = await h.call('POST', '/v1/auth/session', { body });
      expect(res.status).toBe(400);
      expect(errorCode(res)).toBe('INVALID_REQUEST');
    }
    const badAddress = await h.call('POST', '/v1/auth/session', {
      body: { challengeId: randomUUID(), address: 'nope', signature: 'abc' },
    });
    expect(badAddress.status).toBe(400);
    expect(h.store.bucketKeys.size).toBe(0);
  });

  it('is rate limited per client address', async () => {
    const h = memoryHarness();
    const kp = wallet();
    const attempt = () =>
      h.call('POST', '/v1/auth/session', {
        body: { challengeId: randomUUID(), address: kp.publicKey(), signature: 'abc' },
        client: '192.0.2.50',
      });
    for (let i = 0; i < SIGN_IN_LIMITS.sessionPerClient.capacity; i += 1) {
      expect((await attempt()).status).toBe(401);
    }
    const limited = await attempt();
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('1');
  });
});

describe('GET /v1/me', () => {
  it('names the member and their principals', async () => {
    const h = memoryHarness();
    const kp = wallet();
    const { token } = await signInWith(h.call, kp);
    const principal = { principalId: randomUUID(), name: 'Later Ltd', role: 'admin' };
    h.store.grant(kp.publicKey(), principal);
    const me = await h.call('GET', '/v1/me', { cookie: token ?? '' });
    expect(me.status).toBe(200);
    expect(me.json).toEqual({
      member: { id: h.store.members.get(kp.publicKey()), address: kp.publicKey() },
      principals: [{ id: principal.principalId, name: 'Later Ltd', role: 'admin' }],
    });
  });

  it('never shows one person the principals of another', async () => {
    const h = memoryHarness();
    const alice = wallet();
    const bob = wallet();
    h.store.grant(alice.publicKey(), {
      principalId: randomUUID(),
      name: 'Alice Co',
      role: 'owner',
    });
    h.store.grant(bob.publicKey(), { principalId: randomUUID(), name: 'Bob Co', role: 'owner' });
    const a = await signInWith(h.call, alice);
    const b = await signInWith(h.call, bob);
    const meA = await h.call('GET', '/v1/me', { cookie: a.token ?? '' });
    const meB = await h.call('GET', '/v1/me', { cookie: b.token ?? '' });
    expect(meA.json?.['principals']).toEqual([expect.objectContaining({ name: 'Alice Co' })]);
    expect(meB.json?.['principals']).toEqual([expect.objectContaining({ name: 'Bob Co' })]);
  });

  it('answers SESSION_INVALID without a cookie, or with one this server never issued', async () => {
    const h = memoryHarness();
    for (const cookie of [undefined, 'garbage', newSessionToken()]) {
      const res = await h.call('GET', '/v1/me', cookie === undefined ? {} : { cookie });
      expect(res.status, String(cookie)).toBe(401);
      expect(errorCode(res)).toBe('SESSION_INVALID');
    }
  });

  it('works from any origin, since a read changes nothing', async () => {
    const h = memoryHarness();
    const { token } = await signInWith(h.call, wallet());
    const res = await h.call('GET', '/v1/me', { cookie: token ?? '', origin: null });
    expect(res.status).toBe(200);
  });

  it('extends the idle window at most once an hour, never past the absolute expiry', async () => {
    const h = memoryHarness();
    const { token } = await signInWith(h.call, wallet());
    const me = () => h.call('GET', '/v1/me', { cookie: token ?? '' });
    h.clock.now += 30 * MINUTE;
    expect((await me()).status).toBe(200);
    expect(h.store.touches).toBe(0);
    h.clock.now += 31 * MINUTE;
    expect((await me()).status).toBe(200);
    expect(h.store.touches).toBe(1);
    const row = [...h.store.sessions.values()][0];
    expect(row?.idle).toBe(h.clock.now + SESSION_IDLE_SECONDS * 1000);
    // Near the end the idle window is the absolute one and nothing is written.
    h.clock.now = START + (SESSION_ABSOLUTE_SECONDS - 60) * 1000;
    if (row !== undefined) row.idle = row.absolute;
    expect((await me()).status).toBe(200);
    expect(h.store.touches).toBe(1);
    h.clock.now = START + SESSION_ABSOLUTE_SECONDS * 1000;
    expect((await me()).status).toBe(401);
  });

  it('lapses after 30 idle days', async () => {
    const h = memoryHarness();
    const { token } = await signInWith(h.call, wallet());
    h.clock.now += SESSION_IDLE_SECONDS * 1000;
    expect((await h.call('GET', '/v1/me', { cookie: token ?? '' })).status).toBe(401);
  });

  it('answers 503 DB_UNAVAILABLE when the store is down', async () => {
    const h = memoryHarness();
    const { token } = await signInWith(h.call, wallet());
    h.store.failWith = new DatabaseUnavailableError('08006');
    const res = await h.call('GET', '/v1/me', { cookie: token ?? '' });
    expect(res.status).toBe(503);
    expect(errorCode(res)).toBe('DB_UNAVAILABLE');
    expect(res.headers.get('retry-after')).toBe('5');
    expect(h.lines.some((l) => l.includes('event=v1_db_unavailable') && l.includes('08006'))).toBe(
      true,
    );
  });

  it('answers 500 INTERNAL for any other store failure', async () => {
    const h = memoryHarness();
    h.store.failWith = new Error('a bug');
    const res = await h.call('POST', '/v1/auth/challenge', {
      body: { address: wallet().publicKey() },
    });
    expect(res.status).toBe(500);
    expect(errorCode(res)).toBe('INTERNAL');
  });
});

describe('DELETE /v1/auth/session', () => {
  it('ends the session and clears the cookie; the cookie no longer works', async () => {
    const h = memoryHarness();
    const { token } = await signInWith(h.call, wallet());
    const out = await h.call('DELETE', '/v1/auth/session', { cookie: token ?? '' });
    expect(out.status).toBe(200);
    expect(out.json).toEqual({ signedOut: true });
    const cleared = out.cookies[0] ?? '';
    expect(cleared).toMatch(new RegExp(`^${SESSION_COOKIE}=;`));
    expect(cleared).toContain('Max-Age=0');
    expect(cleared).toContain('Path=/v1');
    expect([...h.store.sessions.values()][0]?.revoked).toBe('signed_out');
    expect(errorCode(await h.call('GET', '/v1/me', { cookie: token ?? '' }))).toBe(
      'SESSION_INVALID',
    );
    const twice = await h.call('DELETE', '/v1/auth/session', { cookie: token ?? '' });
    expect(twice.status).toBe(401);
    expect(errorCode(twice)).toBe('SESSION_INVALID');
  });

  it('answers 403 ORIGIN_NOT_ALLOWED to a write with the session from another site', async () => {
    const h = memoryHarness();
    const { token } = await signInWith(h.call, wallet());
    for (const origin of ['https://evil.example', 'http://ujira.co', null]) {
      const res = await h.call('DELETE', '/v1/auth/session', { cookie: token ?? '', origin });
      expect(res.status, String(origin)).toBe(403);
      expect(errorCode(res)).toBe('ORIGIN_NOT_ALLOWED');
    }
    expect((await h.call('GET', '/v1/me', { cookie: token ?? '' })).status).toBe(200);
  });

  it('answers SESSION_INVALID without a session', async () => {
    const h = memoryHarness();
    expect(errorCode(await h.call('DELETE', '/v1/auth/session'))).toBe('SESSION_INVALID');
  });
});

describe('what sign in writes to the log', () => {
  it('never carries the session token, its hash, the signature, the message or the address', async () => {
    const h = memoryHarness();
    const kp = wallet();
    const { token, message } = await signInWith(h.call, kp);
    // A second session, a refused attempt, a read, a read that extends, and sign out.
    const second = await signInWith(h.call, kp);
    expect(second.answer.status).toBe(200);
    const challenge = await h.call('POST', '/v1/auth/challenge', {
      body: { address: kp.publicKey() },
    });
    const badSignature = signBase64(wallet(), String(challenge.json?.['message']));
    await h.call('POST', '/v1/auth/session', {
      body: {
        challengeId: challenge.json?.['challengeId'],
        address: kp.publicKey(),
        signature: badSignature,
      },
    });
    await h.call('GET', '/v1/me', { cookie: token ?? '' });
    h.clock.now += 2 * HOUR;
    await h.call('GET', '/v1/me', { cookie: token ?? '' });
    await h.call('DELETE', '/v1/auth/session', { cookie: token ?? '' });

    expect(h.lines.length).toBeGreaterThanOrEqual(4);
    const logged = h.lines.join('\n');
    const secrets = [
      token ?? 'missing',
      second.token ?? 'missing',
      sessionTokenHash(token ?? '')?.toString('hex') ?? 'missing',
      sessionTokenHash(token ?? '')?.toString('base64') ?? 'missing',
      signBase64(kp, message),
      badSignature,
      kp.publicKey(),
      parseWalletMessage(message).nonce,
    ];
    for (const secret of secrets) expect(logged).not.toContain(secret);
    expect(logged).toContain('event=sign_in ');
    expect(logged).toContain('event=sign_out ');
  });
});

describe('the OpenAPI document', () => {
  it('lists the sign in routes and is valid OpenAPI 3.1', async () => {
    const h = memoryHarness();
    const res = await h.call('GET', '/v1/openapi.json');
    const validator = new Validator();
    const result = await validator.validate(res.json ?? {});
    expect(result.errors).toBeUndefined();
    const paths = (res.json?.['paths'] ?? {}) as Record<string, Record<string, unknown>>;
    expect(Object.keys(paths['/v1/auth/session'] ?? {}).sort()).toEqual(['delete', 'post']);
    expect(Object.keys(paths['/v1/auth/challenge'] ?? {})).toEqual(['post']);
    expect(Object.keys(paths['/v1/me'] ?? {})).toEqual(['get']);
  });
});

describe('the sign in setting', () => {
  it('is off unless UJIRA_SIGN_IN is on', () => {
    expect(signInEnabled({})).toBe(false);
    expect(signInEnabled({ UJIRA_SIGN_IN: '' })).toBe(false);
    expect(signInEnabled({ UJIRA_SIGN_IN: 'off' })).toBe(false);
    expect(signInEnabled({ UJIRA_SIGN_IN: 'on' })).toBe(true);
    expect(loadSignInSettings({})).toEqual({ enabled: false });
    for (const bad of ['true', '1', 'ON', 'yes']) {
      expect(() => signInEnabled({ UJIRA_SIGN_IN: bad }), bad).toThrow('UJIRA_SIGN_IN');
    }
  });

  it('needs the https origin the console is served from', () => {
    const on = (origin?: string) =>
      loadSignInSettings({
        UJIRA_SIGN_IN: 'on',
        ...(origin === undefined ? {} : { UJIRA_PUBLIC_ORIGIN: origin }),
      });
    expect(on('https://ujira.co')).toEqual({ enabled: true, origin: 'https://ujira.co' });
    expect(on('https://ujira.co/')).toEqual({ enabled: true, origin: 'https://ujira.co' });
    expect(on('http://localhost:8080')).toEqual({
      enabled: true,
      origin: 'http://localhost:8080',
    });
    for (const bad of [undefined, 'ujira.co', 'http://ujira.co', 'https://ujira.co/app']) {
      expect(() => on(bad), String(bad)).toThrow('UJIRA_PUBLIC_ORIGIN');
    }
  });
});
