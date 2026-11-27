// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// API key authentication, in the order that spends the least on a bad request:
// the browser origin, the header, the format and checksum, and the key's
// environment are all checked in memory, so none of those failures reaches the
// database. Then the prefix is looked up and the secret's hash compared in
// constant time. Unknown, wrong secret, expired and revoked keys all read the
// same to the caller, and take the same path, so the answer tells nothing about
// which prefixes exist.
//
// A key that fails on its environment or at the lookup is recorded as a security
// event, by its public prefix only. A malformed one has no prefix worth keeping.
//
// A good lookup is cached for at most 30 seconds, so a key revoked on another
// instance stops working within that time everywhere. A hit still has its
// secret compared, because the cache is keyed by the public prefix.
//
// Log lines carry the request id and a reason code. Never the key, its prefix
// or its hash.

import { timingSafeEqual } from 'node:crypto';

import { z } from 'zod';

import { errorCode } from '../log.js';
import { API_SCOPES, type ApiScope, type KeyTenant, type Tenant } from './scopes.js';
import { hashSecret, parseToken, type TokenEnvironment } from './token.js';

/** What the store knows about a key. The secret itself is never in it. */
export interface TokenLookup {
  readonly tokenId: string;
  readonly principalId: string;
  readonly projectId: string;
  readonly secretSha256: Buffer;
  readonly scopes: readonly string[];
  readonly expiresAt: Date;
  readonly revokedAt: Date | null;
}

/** What a refused key leaves behind. The prefix is public; nothing else of the key goes here. */
export interface TokenSecurityEvent {
  readonly kind: 'token_invalid' | 'token_env_mismatch';
  readonly tokenPrefix: string;
}

/** What key authentication needs from storage. The database implements it in api-key-store.ts. */
export interface TokenStore {
  /** The key the prefix names, whatever its tenant, or undefined. */
  find(prefix: string): Promise<TokenLookup | undefined>;
  /** Records use of a key, at most once per five minutes however often it is called. */
  touchLastUsed(tenant: Tenant, tokenId: string): Promise<void>;
  recordSecurityEvent(event: TokenSecurityEvent): Promise<void>;
}

export type TokenFailureCode =
  'TOKEN_MALFORMED' | 'TOKEN_INVALID' | 'TOKEN_ENVIRONMENT_MISMATCH' | 'ORIGIN_NOT_ALLOWED';

export type TokenAuthResult =
  | { readonly ok: true; readonly tenant: KeyTenant }
  | { readonly ok: false; readonly code: TokenFailureCode };

export interface TokenCredentials {
  /** The Authorization header as sent, or null. */
  readonly authorization: string | null;
  /** The Origin header as sent, or null. */
  readonly origin: string | null;
}

export interface TokenAuthenticator {
  authenticate(credentials: TokenCredentials, requestId: string): Promise<TokenAuthResult>;
  /** Drops a key from this instance's cache, so a key revoked here stops here at once. */
  forget(prefix: string): void;
}

export interface TokenAuthOptions {
  readonly store: TokenStore;
  /** The one environment whose keys this deployment accepts. */
  readonly environment: TokenEnvironment;
  /**
   * Exact origins a browser may send a key from. Empty by default: a key is a
   * server's credential, and one sent from a web page has already leaked.
   */
  readonly allowedOrigins?: readonly string[];
  readonly log?: (line: string) => void;
  readonly now?: () => Date;
  /** Capped at the 30 second limit, so a setting cannot stretch how long a revoked key lives. */
  readonly cacheTtlMs?: number;
  readonly cacheMaxEntries?: number;
}

/** A stored key holds scopes this code does not know. The check constraint makes that a bug. */
export class TokenRecordError extends Error {
  override readonly name = 'TokenRecordError';
}

export const TOKEN_CACHE_MAX_TTL_MS = 30_000;
const DEFAULT_CACHE_ENTRIES = 10_000;

const BEARER = /^Bearer (\S+)$/i;
const SHA256_BYTES = 32;

// Compared against when no key was found, so an unknown prefix costs what a
// wrong secret costs. No secret hashes to this.
const NO_SECRET = Buffer.alloc(SHA256_BYTES);

const StoredScopes = z.array(z.enum(API_SCOPES)).min(1).max(API_SCOPES.length);

interface Cached {
  readonly lookup: TokenLookup;
  readonly scopes: readonly ApiScope[];
  readonly cachedAt: number;
}

function refused(code: TokenFailureCode): TokenAuthResult {
  return { ok: false, code };
}

function secretMatches(secret: string, stored: Buffer | undefined): boolean {
  const presented = hashSecret(secret);
  // A hash of the wrong length cannot have come from a valid row; the compare
  // would throw on it, so it fails like any other mismatch.
  const against = stored?.length === SHA256_BYTES ? stored : NO_SECRET;
  return timingSafeEqual(presented, against) && against !== NO_SECRET;
}

function scopesOf(lookup: TokenLookup): readonly ApiScope[] {
  const parsed = StoredScopes.safeParse(lookup.scopes);
  if (!parsed.success) throw new TokenRecordError('a stored key holds scopes this code refuses');
  return parsed.data;
}

export function createTokenAuthenticator(options: TokenAuthOptions): TokenAuthenticator {
  const now = options.now ?? (() => new Date());
  const log = options.log ?? (() => undefined);
  const ttlMs = Math.min(options.cacheTtlMs ?? TOKEN_CACHE_MAX_TTL_MS, TOKEN_CACHE_MAX_TTL_MS);
  const maxEntries = options.cacheMaxEntries ?? DEFAULT_CACHE_ENTRIES;
  const origins: ReadonlySet<string> = new Set(options.allowedOrigins ?? []);
  const cache = new Map<string, Cached>();

  const remember = (prefix: string, entry: Cached): void => {
    // Oldest first, since a Map keeps insertion order. Filling up only costs a
    // lookup, and the bound keeps one process from holding every key ever seen.
    if (cache.size >= maxEntries) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(prefix, entry);
  };

  const fresh = (prefix: string, at: number): Cached | undefined => {
    const entry = cache.get(prefix);
    if (entry === undefined) return undefined;
    if (at - entry.cachedAt < ttlMs) return entry;
    cache.delete(prefix);
    return undefined;
  };

  const touch = async (tenant: Tenant, tokenId: string, requestId: string): Promise<void> => {
    try {
      await options.store.touchLastUsed(tenant, tokenId);
    } catch (error) {
      // A missed timestamp must not refuse a valid key. It is logged, and the
      // next lookup tries again.
      log(`event=token_touch_failed requestId=${requestId} error=${errorCode(error)}`);
    }
  };

  const report = async (event: TokenSecurityEvent, requestId: string): Promise<void> => {
    try {
      await options.store.recordSecurityEvent(event);
    } catch (error) {
      // The caller still gets its refusal. A lost record is logged, not hidden.
      log(`event=security_event_failed requestId=${requestId} error=${errorCode(error)}`);
    }
  };

  const refuse = (code: TokenFailureCode, requestId: string): TokenAuthResult => {
    log(`event=token_refused requestId=${requestId} reason=${code}`);
    return refused(code);
  };

  return {
    forget: (prefix) => {
      cache.delete(prefix);
    },

    authenticate: async (credentials, requestId) => {
      if (credentials.origin !== null && !origins.has(credentials.origin)) {
        return refuse('ORIGIN_NOT_ALLOWED', requestId);
      }
      const presented = BEARER.exec(credentials.authorization ?? '')?.[1];
      const parsed = presented === undefined ? null : parseToken(presented);
      if (parsed === null) return refuse('TOKEN_MALFORMED', requestId);
      if (parsed.environment !== options.environment) {
        await report({ kind: 'token_env_mismatch', tokenPrefix: parsed.prefix }, requestId);
        return refuse('TOKEN_ENVIRONMENT_MISMATCH', requestId);
      }

      const at = now().getTime();
      const cached = fresh(parsed.prefix, at);
      const lookup = cached?.lookup ?? (await options.store.find(parsed.prefix));

      // Every check runs whichever failed, so the time taken says nothing either.
      const secretOk = secretMatches(parsed.secret, lookup?.secretSha256);
      const live = lookup?.revokedAt === null && lookup.expiresAt.getTime() > at;
      if (lookup === undefined || !secretOk || !live) {
        await report({ kind: 'token_invalid', tokenPrefix: parsed.prefix }, requestId);
        return refuse('TOKEN_INVALID', requestId);
      }

      const tenant: Tenant = { principalId: lookup.principalId, projectId: lookup.projectId };
      const scopes = cached?.scopes ?? scopesOf(lookup);
      if (cached === undefined) {
        remember(parsed.prefix, { lookup, scopes, cachedAt: at });
        await touch(tenant, lookup.tokenId, requestId);
      }
      return {
        ok: true,
        tenant: { ...tenant, tokenId: lookup.tokenId, prefix: parsed.prefix, scopes },
      };
    },
  };
}
