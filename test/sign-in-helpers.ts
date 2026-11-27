// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// Sign in on /v1 in memory: a store that keeps the database's rules (a
// challenge spent once, by its own wallet, before it lapses; sessions found
// by hash; buckets all or none), wallets made from fresh keypairs, and a
// small client for the Hono app.

import { randomBytes, randomUUID } from 'node:crypto';

import { Keypair, StrKey } from '@stellar/stellar-sdk';

import { createV1App, type V1App } from '../src/api/app.js';
import { authRoutes } from '../src/api/routes/auth.js';
import { SESSION_COOKIE } from '../src/auth/session-token.js';
import { SignIn, type SignInStore } from '../src/auth/sign-in.js';
import type { WalletProofVerifier } from '../src/auth/wallet-message.js';
import type {
  CreatedSession,
  NewSession,
  RateLimitBucket,
  ResolvedSession,
  SecurityEventKind,
  SessionPrincipal,
} from '../src/db/index.js';

export const ORIGIN = 'https://ujira.co';
export const START = Date.parse('2026-11-27T10:00:00.000Z');

/** SEP-53 through the Stellar library, as the chain adapter checks it. */
export const verifier: WalletProofVerifier = {
  parseAccount(raw) {
    const value = raw.trim();
    if (!StrKey.isValidEd25519PublicKey(value)) throw new Error('not an account');
    return value;
  },
  verifyWalletProof(address, message, signatureBase64) {
    return Keypair.fromPublicKey(address).verifyMessage(
      message,
      Buffer.from(signatureBase64, 'base64'),
    );
  },
};

export function wallet(): Keypair {
  return Keypair.fromRawEd25519Seed(randomBytes(32));
}

/** As Freighter hands it back. */
export function signBase64(kp: Keypair, text: string): string {
  return Buffer.from(kp.signMessage(text)).toString('base64');
}

/** As Albedo hands it back. */
export function signHex(kp: Keypair, text: string): string {
  return Buffer.from(kp.signMessage(text)).toString('hex');
}

export interface Clock {
  now: number;
}

export interface SessionRow {
  readonly id: string;
  readonly memberId: string;
  readonly wallet: string;
  idle: number;
  readonly absolute: number;
  revoked: string | null;
}

export class MemorySignInStore implements SignInStore {
  readonly challenges = new Map<
    string,
    { wallet: string; message: string; expiresAt: number; consumed: boolean }
  >();
  readonly sessions = new Map<string, SessionRow>();
  readonly members = new Map<string, string>();
  readonly memberships = new Map<string, SessionPrincipal[]>();
  readonly buckets = new Map<string, { tokens: number; at: number }>();
  readonly events: SecurityEventKind[] = [];
  readonly bucketKeys = new Set<string>();
  touches = 0;
  /** When set, every call rejects with it, as an outage would. */
  failWith: Error | undefined;

  constructor(protected readonly clock: Clock) {}

  protected check(): void {
    if (this.failWith !== undefined) throw this.failWith;
  }

  protected live(hash: Buffer): SessionRow | undefined {
    const row = this.sessions.get(hash.toString('hex'));
    if (row === undefined || row.revoked !== null) return undefined;
    const now = this.clock.now;
    return row.idle > now && row.absolute > now ? row : undefined;
  }

  /** Makes the wallet a member of a principal, as create_principal would. */
  grant(walletAddress: string, principal: SessionPrincipal): void {
    const memberId = this.memberOf(walletAddress);
    this.memberships.set(memberId, [...(this.memberships.get(memberId) ?? []), principal]);
  }

  protected memberOf(walletAddress: string): string {
    const known = this.members.get(walletAddress);
    if (known !== undefined) return known;
    const id = randomUUID();
    this.members.set(walletAddress, id);
    return id;
  }

  takeTokens(buckets: readonly RateLimitBucket[]): Promise<boolean> {
    this.check();
    const now = this.clock.now;
    const refilled = buckets.map((b) => {
      this.bucketKeys.add(b.key);
      const held = this.buckets.get(b.key) ?? { tokens: b.capacity, at: now };
      const tokens = Math.min(
        b.capacity,
        held.tokens + ((now - held.at) / 1000) * b.refillPerSecond,
      );
      return { key: b.key, tokens };
    });
    const allowed = refilled.every((b) => b.tokens >= 1);
    for (const b of refilled) {
      this.buckets.set(b.key, { tokens: allowed ? b.tokens - 1 : b.tokens, at: now });
    }
    return Promise.resolve(allowed);
  }

  createChallenge(input: {
    walletAddress: string;
    message: string;
    ttlSeconds: number;
  }): Promise<{ challengeId: string; expiresAt: Date }> {
    this.check();
    const challengeId = randomUUID();
    const expiresAt = this.clock.now + input.ttlSeconds * 1000;
    this.challenges.set(challengeId, {
      wallet: input.walletAddress,
      message: input.message,
      expiresAt,
      consumed: false,
    });
    return Promise.resolve({ challengeId, expiresAt: new Date(expiresAt) });
  }

  consumeChallenge(challengeId: string, walletAddress: string): Promise<string | undefined> {
    this.check();
    const row = this.challenges.get(challengeId);
    if (
      row === undefined ||
      row.consumed ||
      row.wallet !== walletAddress ||
      row.expiresAt <= this.clock.now
    ) {
      return Promise.resolve(undefined);
    }
    row.consumed = true;
    return Promise.resolve(row.message);
  }

  createSession(
    input: NewSession,
  ): Promise<{ session: CreatedSession; principals: SessionPrincipal[] }> {
    this.check();
    const memberId = this.memberOf(input.walletAddress);
    const now = this.clock.now;
    const row: SessionRow = {
      id: randomUUID(),
      memberId,
      wallet: input.walletAddress,
      idle: now + Math.min(input.idleSeconds, input.absoluteSeconds) * 1000,
      absolute: now + input.absoluteSeconds * 1000,
      revoked: null,
    };
    this.sessions.set(input.tokenSha256.toString('hex'), row);
    return Promise.resolve({
      session: {
        sessionId: row.id,
        memberId,
        idleExpiresAt: new Date(row.idle),
        absoluteExpiresAt: new Date(row.absolute),
      },
      principals: [...(this.memberships.get(memberId) ?? [])],
    });
  }

  // Projects are not modelled here, so no request resolves to one; the
  // project checks are tested against the database.
  resolveSession(tokenSha256: Buffer): Promise<ResolvedSession | undefined> {
    this.check();
    const row = this.live(tokenSha256);
    if (row === undefined) return Promise.resolve(undefined);
    return Promise.resolve({
      sessionId: row.id,
      memberId: row.memberId,
      walletAddress: row.wallet,
      idleExpiresAt: new Date(row.idle),
      absoluteExpiresAt: new Date(row.absolute),
      access: null,
    });
  }

  principals(tokenSha256: Buffer): Promise<SessionPrincipal[]> {
    this.check();
    const row = this.live(tokenSha256);
    return Promise.resolve(
      row === undefined ? [] : [...(this.memberships.get(row.memberId) ?? [])],
    );
  }

  touchSession(tokenSha256: Buffer, idleSeconds: number): Promise<Date | undefined> {
    this.check();
    this.touches += 1;
    const row = this.live(tokenSha256);
    if (row === undefined) return Promise.resolve(undefined);
    row.idle = Math.min(this.clock.now + idleSeconds * 1000, row.absolute);
    return Promise.resolve(new Date(row.idle));
  }

  revokeSession(tokenSha256: Buffer, reason: string): Promise<boolean> {
    this.check();
    const row = this.sessions.get(tokenSha256.toString('hex'));
    if (row === undefined || row.revoked !== null) return Promise.resolve(false);
    row.revoked = reason;
    return Promise.resolve(true);
  }

  recordSecurityEvent(kind: SecurityEventKind): Promise<void> {
    this.check();
    this.events.push(kind);
    return Promise.resolve();
  }
}

export interface Answer {
  readonly status: number;
  readonly json: Record<string, unknown> | undefined;
  readonly headers: Headers;
  readonly cookies: string[];
}

export interface CallOptions {
  readonly body?: unknown;
  readonly cookie?: string;
  /** null sends no Origin header. */
  readonly origin?: string | null;
  readonly client?: string;
  /** Sent as Ujira-Project, the project the request names. */
  readonly project?: string;
}

export type Call = (method: string, path: string, o?: CallOptions) => Promise<Answer>;

export function clientFor(app: V1App['app']): Call {
  return async (method, path, o = {}) => {
    const headers: Record<string, string> = {};
    if (o.body !== undefined) headers['content-type'] = 'application/json';
    const origin = o.origin === undefined ? ORIGIN : o.origin;
    if (origin !== null) headers['origin'] = origin;
    if (o.cookie !== undefined) headers['cookie'] = `${SESSION_COOKIE}=${o.cookie}`;
    if (o.project !== undefined) headers['ujira-project'] = o.project;
    const res = await app.fetch(
      new Request(`${ORIGIN}${path}`, {
        method,
        headers,
        ...(o.body === undefined ? {} : { body: JSON.stringify(o.body) }),
      }),
      { requestId: randomUUID(), client: o.client ?? '203.0.113.7' },
    );
    const text = await res.text();
    return {
      status: res.status,
      json: text === '' ? undefined : (JSON.parse(text) as Record<string, unknown>),
      headers: res.headers,
      cookies: res.headers.getSetCookie(),
    };
  };
}

/** The session cookie's value from a Set-Cookie list, or undefined. */
export function sessionCookie(cookies: readonly string[]): string | undefined {
  for (const line of cookies) {
    const [pair] = line.split(';');
    const [name, value] = (pair ?? '').split('=');
    if (name === SESSION_COOKIE) return value;
  }
  return undefined;
}

export function errorCode(answer: Answer): unknown {
  return (answer.json?.['error'] as { code?: unknown } | undefined)?.code;
}

/** Asks for a challenge and signs it; the session answer and its cookie. */
export async function signInWith(
  call: Call,
  kp: Keypair,
  o: { readonly hex?: boolean; readonly client?: string } = {},
): Promise<{ answer: Answer; token: string | undefined; challengeId: string; message: string }> {
  const challenge = await call('POST', '/v1/auth/challenge', {
    body: { address: kp.publicKey() },
    ...(o.client === undefined ? {} : { client: o.client }),
  });
  const challengeId = String(challenge.json?.['challengeId']);
  const message = String(challenge.json?.['message']);
  const signature = o.hex === true ? signHex(kp, message) : signBase64(kp, message);
  const answer = await call('POST', '/v1/auth/session', {
    body: { challengeId, address: kp.publicKey(), signature },
    ...(o.client === undefined ? {} : { client: o.client }),
  });
  return { answer, token: sessionCookie(answer.cookies), challengeId, message };
}

export interface Harness {
  readonly clock: Clock;
  readonly store: MemorySignInStore;
  readonly lines: string[];
  readonly v1: V1App;
  readonly call: Call;
}

export function memoryHarness(): Harness {
  const clock: Clock = { now: START };
  const store = new MemorySignInStore(clock);
  const lines: string[] = [];
  const log = (line: string) => {
    lines.push(line);
  };
  const now = () => new Date(clock.now);
  const signIn = new SignIn({ store, verifier, origin: ORIGIN, log, now });
  const v1 = createV1App({ routes: authRoutes({ signIn, origin: ORIGIN, now }), log });
  return { clock, store, lines, v1, call: clientFor(v1.app) };
}
