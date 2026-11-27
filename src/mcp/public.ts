// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// What keeps a public, authless server safe to leave open: limits on how
// often anyone can call it, how a caller's address is read, and the server's
// settings. Everything here is in memory and per process, which is enough
// for the single machine the server runs on. The public demo's own guard is
// in src/demo.

import type { IncomingHttpHeaders } from 'node:http';
import { isIP, isIPv4, isIPv6 } from 'node:net';

import { z } from 'zod';

import { EngineError } from '../errors.js';
import { minorUnits } from '../money.js';

/** Counts hits per key in fixed windows. */
export class WindowLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
    /** Past this many live keys a new key is refused, so memory stays bounded under a flood. */
    private readonly maxKeys = 10_000,
  ) {}

  get size(): number {
    return this.hits.size;
  }

  take(key: string): { ok: true } | { ok: false; retryAfterMs: number } {
    const now = this.now();
    // Keys are re-inserted when their window restarts, so the map stays in
    // order of expiry and pruning stops at the first live key.
    for (const [k, entry] of this.hits) {
      if (entry.resetAt > now) break;
      this.hits.delete(k);
    }
    const entry = this.hits.get(key);
    if (entry === undefined) {
      if (this.hits.size >= this.maxKeys) return { ok: false, retryAfterMs: this.windowMs };
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
      return { ok: true };
    }
    if (entry.count >= this.limit) return { ok: false, retryAfterMs: entry.resetAt - now };
    entry.count += 1;
    return { ok: true };
  }
}

export interface ClientIpSource {
  /** Read the address from a proxy header; off when the server faces the internet directly. */
  readonly trustProxy: boolean;
  /** The one header to read. Unset, X-Real-IP and then X-Forwarded-For are tried. */
  readonly header?: string;
}

function normalizeAddress(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const ip = raw.trim();
  const mapped = ip.toLowerCase().startsWith('::ffff:') ? ip.slice(7) : undefined;
  if (mapped !== undefined && isIPv4(mapped)) return mapped;
  return isIP(ip) === 0 ? undefined : ip.toLowerCase();
}

/**
 * The last address in a header. Proxies append what they saw, so the last
 * entry is the one the nearest proxy wrote, while earlier ones are whatever
 * the client claimed.
 */
function lastAddress(value: string | string[] | undefined): string | undefined {
  const joined = Array.isArray(value) ? value.join(',') : value;
  return normalizeAddress(joined?.split(',').at(-1));
}

/** The caller's address, as the proxy in front of this server saw it. */
export function clientAddress(
  headers: IncomingHttpHeaders,
  socketAddress: string | undefined,
  source: ClientIpSource,
): string {
  if (source.trustProxy) {
    const names = source.header === undefined ? ['x-real-ip', 'x-forwarded-for'] : [source.header];
    for (const name of names) {
      const ip = lastAddress(headers[name.toLowerCase()]);
      if (ip !== undefined) return ip;
    }
  }
  return normalizeAddress(socketAddress) ?? 'unknown';
}

/** An IPv6 address as its /64, the block one subscriber usually holds. */
function ipv6Block(ip: string): string {
  const [head = '', tail] = ip.split('::');
  const groups = (s: string) => (s === '' ? [] : s.split(':'));
  const front = groups(head);
  let all = front;
  if (tail !== undefined) {
    const back = groups(tail);
    const backSize = back.reduce((n, g) => n + (g.includes('.') ? 2 : 1), 0);
    all = [...front, ...Array<string>(8 - front.length - backSize).fill('0'), ...back];
  }
  const block = all.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, ''));
  return `${block.join(':')}::/64`;
}

/**
 * The key a caller is rate limited under. An IPv6 caller can pick any of
 * the many addresses in their block, so the block is the key.
 */
export function rateKey(address: string): string {
  return isIPv6(address) ? ipv6Block(address) : address;
}

export interface PublicLimits {
  /** The largest payout a public caller may ask for, in minor units. */
  readonly maxAmount: bigint;
  /** request_payout calls per hour from one address. */
  readonly payoutsPerHour: number;
  /** Tool calls per minute from everyone together. */
  readonly toolCallsPerMinute: number;
}

export interface HttpSettings {
  readonly port: number;
  readonly host: string;
  readonly maxBodyBytes: number;
  /** How long one request may take, start to answer. */
  readonly requestTimeoutMs: number;
  readonly allowedOrigins: readonly string[];
  readonly clientIp: ClientIpSource;
  readonly limits: PublicLimits;
}

/** Claude's web and desktop apps; a client with no Origin, such as Cursor, is let in too. */
export const DEFAULT_ORIGINS = ['https://claude.ai', 'https://claude.com'] as const;

/** 10 USDC: below any approval threshold the demo mandate sets. */
export const DEFAULT_MAX_AMOUNT = 100_000_000n;

type Env = Readonly<Record<string, string | undefined>>;

function value(env: Env, name: string): string | undefined {
  const v = env[name]?.trim();
  return v === undefined || v === '' ? undefined : v;
}

function whole(env: Env, name: string, fallback: number, min: number, max: number): number {
  const raw = value(env, name);
  if (raw === undefined) return fallback;
  const parsed = z
    .string()
    .regex(/^\d{1,10}$/)
    .transform(Number)
    .pipe(z.number().int().min(min).max(max))
    .safeParse(raw);
  if (!parsed.success) {
    throw new EngineError('config_invalid', `${name} must be a whole number from ${min} to ${max}`);
  }
  return parsed.data;
}

const origin = z
  .string()
  .transform((s) => s.replace(/\/+$/, '').toLowerCase())
  .refine((s) => {
    try {
      return new URL(s).origin === s;
    } catch {
      return false;
    }
  });

export function loadHttpSettings(env: Env = process.env): HttpSettings {
  const rawMax = value(env, 'UJIRA_PUBLIC_MAX_AMOUNT');
  const max = rawMax === undefined ? undefined : minorUnits.safeParse(rawMax);
  if (max?.success === false) {
    throw new EngineError(
      'config_invalid',
      'UJIRA_PUBLIC_MAX_AMOUNT must be a positive whole number of minor units',
    );
  }
  const extra = (value(env, 'UJIRA_ALLOWED_ORIGINS') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
  const origins = new Set<string>(DEFAULT_ORIGINS);
  for (const o of extra) {
    const parsed = origin.safeParse(o);
    if (!parsed.success) {
      throw new EngineError(
        'config_invalid',
        'UJIRA_ALLOWED_ORIGINS must list origins such as https://example.com, comma separated',
      );
    }
    origins.add(parsed.data);
  }
  const trust = value(env, 'UJIRA_TRUST_PROXY') ?? '1';
  if (!['0', '1', 'true', 'false'].includes(trust)) {
    throw new EngineError('config_invalid', 'UJIRA_TRUST_PROXY must be 1 or 0');
  }
  const header = value(env, 'UJIRA_CLIENT_IP_HEADER');
  if (header !== undefined && !/^[A-Za-z0-9-]{1,64}$/.test(header)) {
    throw new EngineError('config_invalid', 'UJIRA_CLIENT_IP_HEADER must be a header name');
  }
  return {
    port: whole(env, 'PORT', 8080, 0, 65_535),
    host: value(env, 'UJIRA_HTTP_HOST') ?? '0.0.0.0',
    maxBodyBytes: whole(env, 'UJIRA_MAX_BODY_BYTES', 64 * 1024, 1024, 4 * 1024 * 1024),
    requestTimeoutMs: whole(env, 'UJIRA_HTTP_TIMEOUT_MS', 120_000, 1_000, 600_000),
    allowedOrigins: [...origins],
    clientIp: {
      trustProxy: trust === '1' || trust === 'true',
      ...(header === undefined ? {} : { header }),
    },
    limits: {
      maxAmount: max?.data ?? DEFAULT_MAX_AMOUNT,
      payoutsPerHour: whole(env, 'UJIRA_PAYOUTS_PER_HOUR', 5, 1, 10_000),
      toolCallsPerMinute: whole(env, 'UJIRA_TOOL_CALLS_PER_MINUTE', 120, 1, 100_000),
    },
  };
}
