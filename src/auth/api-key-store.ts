// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// API keys on Postgres, through the repository layer. Thin on purpose: the
// rules live in the services, and what is left here is which transaction each
// call runs in.
//
// Finding a key by its prefix runs unscoped, because the key is how the tenant
// is found. Everything after that runs in the key's own tenant transaction,
// and a key's audit entry commits or rolls back with the change it records.

import {
  apiTokens,
  audit,
  entryPoints,
  securityEvents,
  type ApiToken,
  type Database,
} from '../db/index.js';
import { API_KEY_MAX_ACTIVE, type ApiKeyRecords, type StoredApiKey } from './api-key-service.js';
import type { TokenStore } from './token-auth.js';

function storedKeyOf(token: ApiToken): StoredApiKey {
  return {
    id: token.id,
    name: token.name,
    prefix: token.prefix,
    scopes: token.scopes,
    expiresAt: token.expiresAt,
    revokedAt: token.revokedAt,
    lastUsedAt: token.lastUsedAt,
    createdAt: token.createdAt,
  };
}

// The key's id and that it is a key. Its name is a person's words, and the
// audit log keeps only what it needs.
function auditTarget(id: string): { readonly target_type: string; readonly target_id: string } {
  return { target_type: 'api_key', target_id: id };
}

export function databaseApiKeyRecords(db: Database): ApiKeyRecords {
  return {
    create: (tenant, key, actorId) =>
      db.tenant(tenant).transaction(async (tx) => {
        const created = await apiTokens.createWithinLimit(tx, key, API_KEY_MAX_ACTIVE);
        if (created === undefined) return null;
        await audit.record(tx, {
          action: 'api_key.created',
          actor: { kind: 'member', id: actorId },
          metadata: auditTarget(created.id),
        });
        return storedKeyOf(created);
      }),

    list: (tenant, page) =>
      db.tenant(tenant).transaction(async (tx) => {
        const found = await apiTokens.list(tx, page);
        return { items: found.items.map(storedKeyOf), next: found.next };
      }),

    revoke: (tenant, id, actorId) =>
      db.tenant(tenant).transaction(async (tx) => {
        if (await apiTokens.revoke(tx, id)) {
          await audit.record(tx, {
            action: 'api_key.revoked',
            actor: { kind: 'member', id: actorId },
            metadata: auditTarget(id),
          });
        }
        const token = await apiTokens.get(tx, id);
        return token === undefined ? undefined : storedKeyOf(token);
      }),
  };
}

export function databaseTokenStore(db: Database): TokenStore {
  return {
    find: (prefix) => db.unscoped((tx) => entryPoints.authenticateToken(tx, prefix)),
    touchLastUsed: async (tenant, tokenId) => {
      await db.tenant(tenant).transaction((tx) => apiTokens.touchLastUsed(tx, tokenId));
    },
    recordSecurityEvent: (event) =>
      db.unscoped((tx) =>
        securityEvents.record(tx, { kind: event.kind, tokenPrefix: event.tokenPrefix }),
      ),
  };
}
