// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// What creating, listing and revoking a key does. These are dashboard actions:
// by the time anything here runs, the route has refused an API key and checked
// the member's role in the project.
//
// A key's whole text exists only in the answer that creates it. It is not
// stored, not logged, and the create route is not written to the idempotency
// store, because that holds answers in clear.

import type { ApiScope, Tenant } from './scopes.js';
import { issueToken, type TokenEnvironment } from './token.js';

/** Enough for a key per service and environment, few enough that a leak is easy to sweep. */
export const API_KEY_MAX_ACTIVE = 20;
export const API_KEY_MIN_EXPIRY_DAYS = 1;
export const API_KEY_MAX_EXPIRY_DAYS = 730;
/** Taken when a request names no expiry. Every key expires; rotation is how one is kept. */
export const API_KEY_DEFAULT_EXPIRY_DAYS = 365;

const DAY_MS = 86_400_000;

export interface StoredApiKey {
  readonly id: string;
  /** Null only on a key made before keys had names. */
  readonly name: string | null;
  readonly prefix: string;
  readonly scopes: readonly string[];
  readonly expiresAt: Date;
  readonly revokedAt: Date | null;
  readonly lastUsedAt: Date | null;
  readonly createdAt: Date;
}

export interface NewStoredKey {
  readonly name: string;
  readonly prefix: string;
  /** SHA-256 of the secret part. The secret itself never leaves the service. */
  readonly secretSha256: Buffer;
  readonly scopes: readonly ApiScope[];
  readonly expiresAt: Date;
}

/** The key rows. Each method takes the tenant, and sees nothing outside it. */
export interface ApiKeyRecords {
  /** Null when the project already holds its limit of active keys. Writes the audit entry. */
  create(tenant: Tenant, key: NewStoredKey, actorId: string): Promise<StoredApiKey | null>;
  list(
    tenant: Tenant,
    page: { readonly limit: number; readonly after?: string },
  ): Promise<{ readonly items: readonly StoredApiKey[]; readonly next: string | null }>;
  /**
   * The key, revoked whether by this call or before it, or undefined if it is
   * not in this project. Writes the audit entry when this call revoked it.
   */
  revoke(tenant: Tenant, id: string, actorId: string): Promise<StoredApiKey | undefined>;
}

export type ApiKeyErrorCode = 'LIMIT_REACHED' | 'NOT_FOUND';

/** A refusal the API answers with its own code; another tenant's key reads as NOT_FOUND. */
export class ApiKeyError extends Error {
  override readonly name = 'ApiKeyError';
  readonly code: ApiKeyErrorCode;

  constructor(code: ApiKeyErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export interface ApiKeyView {
  readonly principalId: string;
  readonly projectId: string;
  readonly id: string;
  readonly name: string | null;
  readonly prefix: string;
  readonly scopes: string[];
  readonly expiresAt: string;
  readonly revokedAt: string | null;
  readonly lastUsedAt: string | null;
  readonly createdAt: string;
}

function iso(date: Date | null): string | null {
  return date === null ? null : date.toISOString();
}

export function viewOf(tenant: Tenant, key: StoredApiKey): ApiKeyView {
  return {
    principalId: tenant.principalId,
    projectId: tenant.projectId,
    id: key.id,
    name: key.name,
    prefix: key.prefix,
    scopes: [...key.scopes],
    expiresAt: key.expiresAt.toISOString(),
    revokedAt: iso(key.revokedAt),
    lastUsedAt: iso(key.lastUsedAt),
    createdAt: key.createdAt.toISOString(),
  };
}

export interface ApiKeyServiceOptions {
  readonly records: ApiKeyRecords;
  /** The one environment this deployment issues keys for. */
  readonly environment: TokenEnvironment;
  /** Told the prefix of every key revoked here, so this instance stops it at once. */
  readonly onRevoked?: (prefix: string) => void;
  readonly now?: () => Date;
}

export interface CreateApiKey {
  readonly name: string;
  readonly scopes: readonly ApiScope[];
  /** Whole days, already checked against the bounds above. */
  readonly expiresInDays: number;
}

export interface Caller {
  readonly tenant: Tenant;
  /** The member acting, for the audit entry. */
  readonly actorId: string;
}

export interface ApiKeyService {
  create(input: CreateApiKey, caller: Caller): Promise<{ apiKey: ApiKeyView; secret: string }>;
  list(
    tenant: Tenant,
    page: { readonly limit: number; readonly after?: string },
  ): Promise<{ items: ApiKeyView[]; next: string | null }>;
  revoke(id: string, caller: Caller): Promise<ApiKeyView>;
}

export function createApiKeyService(o: ApiKeyServiceOptions): ApiKeyService {
  const now = o.now ?? (() => new Date());
  return {
    async create(input, { tenant, actorId }) {
      const expiresAt = new Date(now().getTime() + input.expiresInDays * DAY_MS);
      const issued = issueToken(o.environment);
      const stored = await o.records.create(
        tenant,
        {
          name: input.name,
          prefix: issued.prefix,
          secretSha256: issued.secretSha256,
          // In the order the caller gave, each once, as the schema already insisted.
          scopes: input.scopes,
          expiresAt,
        },
        actorId,
      );
      if (stored === null) {
        throw new ApiKeyError('LIMIT_REACHED', 'This project holds as many active keys as it may');
      }
      return { apiKey: viewOf(tenant, stored), secret: issued.token };
    },

    async list(tenant, page) {
      const found = await o.records.list(tenant, page);
      return { items: found.items.map((key) => viewOf(tenant, key)), next: found.next };
    },

    async revoke(id, { tenant, actorId }) {
      const stored = await o.records.revoke(tenant, id, actorId);
      if (stored === undefined) throw new ApiKeyError('NOT_FOUND', 'No such key');
      o.onRevoked?.(stored.prefix);
      return viewOf(tenant, stored);
    },
  };
}
