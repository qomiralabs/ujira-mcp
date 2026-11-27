// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// Wallet sign in, from the challenge to the session, and the session on every
// later request. Nothing here knows a chain: address rules and the signature
// check come from the verifier the chain adapter provides, and storage is a
// port the database implements, so these rules are tested without either.
//
// A challenge is spent before its signature is checked. A wrong signature
// therefore uses it up, and no challenge can be tried twice; the person asks
// for a new one, which is rate limited.
//
// Log lines carry the request id, the member id and a reason code. Never the
// token, its hash, the signature, the signed text or the wallet address.

import { createHash } from 'node:crypto';

import type {
  CreatedSession,
  NewSession,
  RateLimitBucket,
  ResolvedSession,
  SecurityEventKind,
  SessionPrincipal,
} from '../db/index.js';
import { sessionTokenHash, newSessionToken } from './session-token.js';
import {
  createWalletMessage,
  verifyWalletMessage,
  WALLET_MESSAGE_TTL_MS,
  WalletMessageError,
  type WalletProofVerifier,
} from './wallet-message.js';

export const SESSION_IDLE_SECONDS = 30 * 24 * 60 * 60;
export const SESSION_ABSOLUTE_SECONDS = 90 * 24 * 60 * 60;

/**
 * How stale the idle expiry may get before a request extends it. Extending on
 * every request would be a write per request; once an hour is a write per
 * active session per hour and moves a 30 day window by at most an hour.
 */
export const SESSION_TOUCH_AFTER_SECONDS = 60 * 60;

export const CHALLENGE_TTL_SECONDS = WALLET_MESSAGE_TTL_MS / 1000;

/**
 * Token buckets refill at a whole number of tokens a second at the slowest,
 * so the capacity is the burst. Per address stops one wallet's challenges
 * from being churned; per client stops one caller from sweeping addresses.
 */
export const SIGN_IN_LIMITS = {
  challengePerAddress: { capacity: 5, refillPerSecond: 1 },
  challengePerClient: { capacity: 20, refillPerSecond: 1 },
  sessionPerClient: { capacity: 20, refillPerSecond: 1 },
} as const;

/** What sign in needs from storage. The database implements it in postgres-store.ts. */
export interface SignInStore {
  /** True when every bucket gave a token; none is taken otherwise. */
  takeTokens(buckets: readonly RateLimitBucket[]): Promise<boolean>;
  createChallenge(input: {
    readonly walletAddress: string;
    readonly message: string;
    readonly ttlSeconds: number;
  }): Promise<{ readonly challengeId: string; readonly expiresAt: Date }>;
  /** Spends the challenge; the signed text, or undefined if unknown, spent, lapsed or another wallet's. */
  consumeChallenge(challengeId: string, walletAddress: string): Promise<string | undefined>;
  /** The session and the principals of the person it belongs to, in one transaction. */
  createSession(
    input: NewSession,
  ): Promise<{ readonly session: CreatedSession; readonly principals: SessionPrincipal[] }>;
  resolveSession(
    tokenSha256: Buffer,
    projectId: string | null,
  ): Promise<ResolvedSession | undefined>;
  principals(tokenSha256: Buffer): Promise<SessionPrincipal[]>;
  touchSession(tokenSha256: Buffer, idleSeconds: number): Promise<Date | undefined>;
  revokeSession(tokenSha256: Buffer, reason: string): Promise<boolean>;
  recordSecurityEvent(kind: SecurityEventKind): Promise<void>;
}

export type SignInErrorCode = 'ADDRESS_INVALID' | 'RATE_LIMITED' | 'SESSION_INVALID';

/** A refusal the API answers with a fixed message; the reason is never shown to the caller. */
export class SignInError extends Error {
  readonly code: SignInErrorCode;

  constructor(code: SignInErrorCode, message: string) {
    super(message);
    this.name = 'SignInError';
    this.code = code;
  }
}

export interface SignInOptions {
  readonly store: SignInStore;
  readonly verifier: WalletProofVerifier;
  /** The app origin every challenge names, such as https://ujira.co. */
  readonly origin: string;
  readonly log?: (line: string) => void;
  readonly now?: () => Date;
}

export interface IssuedChallenge {
  readonly challengeId: string;
  readonly message: string;
  readonly expiresAt: string;
}

export interface StartedSession {
  /** The cookie value. It goes to the browser once and is never stored or logged. */
  readonly token: string;
  readonly memberId: string;
  readonly address: string;
  readonly absoluteExpiresAt: Date;
  readonly principals: readonly SessionPrincipal[];
}

/** A live session, as a request carries it. */
export interface ActiveSession extends ResolvedSession {
  readonly tokenSha256: Buffer;
}

/** A bucket key is the digest of what is limited, so no address or client reaches the table. */
function bucket(
  kind: string,
  subject: string,
  limit: { readonly capacity: number; readonly refillPerSecond: number },
): RateLimitBucket {
  const digest = createHash('sha256').update(`${kind}\n${subject}`).digest('hex');
  return { key: `${kind}:${digest}`, ...limit };
}

function sessionInvalid(): SignInError {
  return new SignInError('SESSION_INVALID', 'The session or challenge is not valid');
}

export class SignIn {
  private readonly log: (line: string) => void;
  private readonly now: () => Date;

  constructor(private readonly o: SignInOptions) {
    this.log = o.log ?? (() => undefined);
    this.now = o.now ?? (() => new Date());
  }

  private account(raw: string): string {
    try {
      return this.o.verifier.parseAccount(raw);
    } catch {
      throw new SignInError('ADDRESS_INVALID', 'The address is not a valid account');
    }
  }

  private async limit(buckets: readonly RateLimitBucket[]): Promise<void> {
    if (!(await this.o.store.takeTokens(buckets))) {
      throw new SignInError('RATE_LIMITED', 'Too many sign in attempts');
    }
  }

  /** A one time message for the wallet to sign, kept for ten minutes at most. */
  async challenge(rawAddress: string, client: string): Promise<IssuedChallenge> {
    const address = this.account(rawAddress);
    await this.limit([
      bucket('signin_address', address, SIGN_IN_LIMITS.challengePerAddress),
      bucket('signin_client', client, SIGN_IN_LIMITS.challengePerClient),
    ]);
    const { message, text } = createWalletMessage({
      purpose: 'sign_in',
      origin: this.o.origin,
      address,
      now: this.now(),
    });
    const created = await this.o.store.createChallenge({
      walletAddress: address,
      message: text,
      ttlSeconds: CHALLENGE_TTL_SECONDS,
    });
    // The database clock decides when the row lapses and the text names its
    // own expiry; the earlier of the two is the one the person can rely on.
    const expiresAt = Math.min(created.expiresAt.getTime(), Date.parse(message.expiresAt));
    return {
      challengeId: created.challengeId,
      message: text,
      expiresAt: new Date(expiresAt).toISOString(),
    };
  }

  /** Trades a signed challenge for a session. Every refusal is SESSION_INVALID. */
  async startSession(
    input: { readonly challengeId: string; readonly address: string; readonly signature: string },
    client: string,
    requestId: string,
  ): Promise<StartedSession> {
    const address = this.account(input.address);
    await this.limit([bucket('signin_session_client', client, SIGN_IN_LIMITS.sessionPerClient)]);
    const signed = await this.o.store.consumeChallenge(input.challengeId, address);
    if (signed === undefined) {
      this.log(`event=sign_in_refused requestId=${requestId} reason=CHALLENGE_UNUSABLE`);
      throw sessionInvalid();
    }
    try {
      await verifyWalletMessage(
        {
          message: signed,
          address,
          signature: input.signature,
          expected: { purpose: 'sign_in', origin: this.o.origin },
          now: this.now(),
        },
        // The challenge row was spent atomically just above, which is the
        // single use guarantee; the nonce inside it needs no second store.
        { verifier: this.o.verifier, nonces: { consume: () => Promise.resolve(true) } },
      );
    } catch (error) {
      if (!(error instanceof WalletMessageError)) throw error;
      // The challenge was real and issued to this address, so a failure here
      // is someone holding a challenge without the key: worth a record.
      await this.o.store.recordSecurityEvent('sign_in_failed');
      this.log(
        `event=security_event kind=sign_in_failed requestId=${requestId} reason=${error.code}`,
      );
      throw sessionInvalid();
    }
    const token = newSessionToken();
    const tokenSha256 = sessionTokenHash(token);
    /* v8 ignore next -- newSessionToken only makes tokens sessionTokenHash accepts. */
    if (tokenSha256 === undefined) throw new Error('a new session token did not hash');
    const { session, principals } = await this.o.store.createSession({
      tokenSha256,
      walletAddress: address,
      idleSeconds: SESSION_IDLE_SECONDS,
      absoluteSeconds: SESSION_ABSOLUTE_SECONDS,
    });
    this.log(`event=sign_in requestId=${requestId} member=${session.memberId}`);
    return {
      token,
      memberId: session.memberId,
      address,
      absoluteExpiresAt: session.absoluteExpiresAt,
      principals,
    };
  }

  /**
   * The live session behind a cookie value, checked against the project the
   * request names, if any. Extends the idle window at most once an hour.
   */
  async resolve(token: string | undefined, projectId: string | null): Promise<ActiveSession> {
    const tokenSha256 = token === undefined ? undefined : sessionTokenHash(token);
    if (tokenSha256 === undefined) throw sessionInvalid();
    const resolved = await this.o.store.resolveSession(tokenSha256, projectId);
    if (resolved === undefined) throw sessionInvalid();
    const now = this.now().getTime();
    const idleLeftSeconds = (resolved.idleExpiresAt.getTime() - now) / 1000;
    const canExtend = resolved.idleExpiresAt.getTime() < resolved.absoluteExpiresAt.getTime();
    if (canExtend && SESSION_IDLE_SECONDS - idleLeftSeconds >= SESSION_TOUCH_AFTER_SECONDS) {
      // A session that lapsed in between still answers this one request: it
      // was live when it was read, and the next request will find it gone.
      const extended = await this.o.store.touchSession(tokenSha256, SESSION_IDLE_SECONDS);
      if (extended !== undefined) return { ...resolved, idleExpiresAt: extended, tokenSha256 };
    }
    return { ...resolved, tokenSha256 };
  }

  principals(session: ActiveSession): Promise<SessionPrincipal[]> {
    return this.o.store.principals(session.tokenSha256);
  }

  /** Ends the session for good. SESSION_INVALID when it had already ended. */
  async signOut(session: ActiveSession, requestId: string): Promise<void> {
    if (!(await this.o.store.revokeSession(session.tokenSha256, 'signed_out'))) {
      throw sessionInvalid();
    }
    this.log(`event=sign_out requestId=${requestId} member=${session.memberId}`);
  }
}
