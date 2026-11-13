// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

import { describe, expect, it } from 'vitest';

import {
  WindowLimiter,
  clientAddress,
  loadHttpSettings,
  publicGuard,
  publicLimiters,
  rateKey,
} from '../src/mcp/public.js';

describe('WindowLimiter', () => {
  it('allows the limit per window and opens again when it ends', () => {
    let now = 0;
    const limiter = new WindowLimiter(2, 1000, () => now);
    expect(limiter.take('a')).toEqual({ ok: true });
    expect(limiter.take('a')).toEqual({ ok: true });
    now = 400;
    expect(limiter.take('a')).toEqual({ ok: false, retryAfterMs: 600 });
    expect(limiter.take('b')).toEqual({ ok: true });
    now = 1000;
    expect(limiter.take('a')).toEqual({ ok: true });
    // b's window, opened at 400, ends at 1400 and is still counted.
    expect(limiter.size).toBe(2);
    now = 1400;
    limiter.take('c');
    expect(limiter.size).toBe(2);
  });

  it('refuses new keys once full, so a flood of addresses cannot grow memory', () => {
    let now = 0;
    const limiter = new WindowLimiter(1, 1000, () => now, 2);
    limiter.take('a');
    limiter.take('b');
    expect(limiter.take('c')).toEqual({ ok: false, retryAfterMs: 1000 });
    now = 1000;
    expect(limiter.take('c')).toEqual({ ok: true });
  });
});

describe('clientAddress', () => {
  const trust = { trustProxy: true };

  it('reads X-Real-IP, then the last X-Forwarded-For entry, then the socket', () => {
    expect(clientAddress({ 'x-real-ip': '203.0.113.5' }, '10.0.0.1', trust)).toBe('203.0.113.5');
    expect(clientAddress({ 'x-forwarded-for': '1.1.1.1, 203.0.113.6 ' }, '10.0.0.1', trust)).toBe(
      '203.0.113.6',
    );
    expect(clientAddress({}, '::ffff:10.0.0.1', trust)).toBe('10.0.0.1');
    expect(clientAddress({ 'x-real-ip': 'not an address' }, undefined, trust)).toBe('unknown');
  });

  it('reads only the named header when one is set', () => {
    const fly = { trustProxy: true, header: 'Fly-Client-IP' };
    const headers = { 'fly-client-ip': '203.0.113.7', 'x-real-ip': '192.0.2.1' };
    expect(clientAddress(headers, '10.0.0.1', fly)).toBe('203.0.113.7');
    expect(clientAddress({ 'x-real-ip': '192.0.2.1' }, '10.0.0.1', fly)).toBe('10.0.0.1');
  });

  it('ignores proxy headers when not behind a proxy', () => {
    expect(
      clientAddress({ 'x-real-ip': '203.0.113.5' }, '198.51.100.1', { trustProxy: false }),
    ).toBe('198.51.100.1');
  });
});

describe('rateKey', () => {
  it('keys IPv4 by address and IPv6 by its /64', () => {
    expect(rateKey('203.0.113.5')).toBe('203.0.113.5');
    expect(rateKey('2001:db8:0:1:aaaa::1')).toBe('2001:db8:0:1::/64');
    expect(rateKey('2001:0db8:0000:0001:ffff:0:0:2')).toBe('2001:db8:0:1::/64');
    expect(rateKey('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(rateKey('::1')).toBe('0:0:0:0::/64');
    expect(rateKey('::ffff:1.2.3.4')).toBe('0:0:0:0::/64');
  });
});

describe('loadHttpSettings', () => {
  it('has safe defaults', () => {
    expect(loadHttpSettings({})).toEqual({
      port: 8080,
      host: '0.0.0.0',
      maxBodyBytes: 65_536,
      requestTimeoutMs: 120_000,
      allowedOrigins: ['https://claude.ai', 'https://claude.com'],
      clientIp: { trustProxy: true },
      limits: { maxAmount: 100_000_000n, payoutsPerHour: 5, toolCallsPerMinute: 120 },
    });
  });

  it('reads every setting', () => {
    const s = loadHttpSettings({
      PORT: '3000',
      UJIRA_HTTP_HOST: '127.0.0.1',
      UJIRA_MAX_BODY_BYTES: '2048',
      UJIRA_HTTP_TIMEOUT_MS: '5000',
      UJIRA_ALLOWED_ORIGINS: 'https://Example.com/, https://claude.ai',
      UJIRA_TRUST_PROXY: '0',
      UJIRA_CLIENT_IP_HEADER: 'Fly-Client-IP',
      UJIRA_PUBLIC_MAX_AMOUNT: '50000000',
      UJIRA_PAYOUTS_PER_HOUR: '3',
      UJIRA_TOOL_CALLS_PER_MINUTE: '60',
    });
    expect(s).toEqual({
      port: 3000,
      host: '127.0.0.1',
      maxBodyBytes: 2048,
      requestTimeoutMs: 5000,
      allowedOrigins: ['https://claude.ai', 'https://claude.com', 'https://example.com'],
      clientIp: { trustProxy: false, header: 'Fly-Client-IP' },
      limits: { maxAmount: 50_000_000n, payoutsPerHour: 3, toolCallsPerMinute: 60 },
    });
  });

  it.each([
    [{ PORT: 'eighty' }, /PORT/],
    [{ PORT: '70000' }, /PORT/],
    [{ UJIRA_PUBLIC_MAX_AMOUNT: '1.5' }, /UJIRA_PUBLIC_MAX_AMOUNT/],
    [{ UJIRA_PUBLIC_MAX_AMOUNT: '0' }, /UJIRA_PUBLIC_MAX_AMOUNT/],
    [{ UJIRA_PAYOUTS_PER_HOUR: '0' }, /UJIRA_PAYOUTS_PER_HOUR/],
    [{ UJIRA_ALLOWED_ORIGINS: 'claude.ai' }, /UJIRA_ALLOWED_ORIGINS/],
    [{ UJIRA_ALLOWED_ORIGINS: 'https://a.example/path' }, /UJIRA_ALLOWED_ORIGINS/],
    [{ UJIRA_TRUST_PROXY: 'yes' }, /UJIRA_TRUST_PROXY/],
    [{ UJIRA_CLIENT_IP_HEADER: 'bad header' }, /UJIRA_CLIENT_IP_HEADER/],
  ])('refuses %o', (env, message) => {
    expect(() => loadHttpSettings(env)).toThrow(message);
  });
});

describe('publicGuard', () => {
  const limits = { maxAmount: 10n, payoutsPerHour: 1, toolCallsPerMinute: 100 };

  it('lets small payouts through and counts only payout requests per address', () => {
    const limiters = publicLimiters(limits, () => 0);
    const guard = publicGuard({ limits, limiters, client: 'a', assetCode: 'USDC' });
    expect(guard('quote_payout', { amount: 10n })).toBeUndefined();
    expect(guard('payout_status', { task_id: 't' })).toBeUndefined();
    expect(guard('request_payout', { task_id: 't', amount: 10n })).toBeUndefined();
    expect(guard('request_payout', { task_id: 't', amount: 10n })).toMatchObject({
      isError: true,
    });
  });

  it('blocks over the cap without using up the address allowance', () => {
    const limiters = publicLimiters(limits, () => 0);
    const guard = publicGuard({ limits, limiters, client: 'a', assetCode: 'USDC' });
    expect(guard('request_payout', { task_id: 't', amount: 11n })).toEqual({
      answer: {
        task_id: 't',
        outcome: 'blocked',
        reason: 'public_demo_limit',
        amount: '11',
        asset: 'USDC',
        max_amount: '10',
        detail: 'This shared public demo pays at most 0.000001 USDC per payout. Nothing was sent.',
      },
    });
    expect(guard('request_payout', { task_id: 't', amount: 1n })).toBeUndefined();
  });
});
