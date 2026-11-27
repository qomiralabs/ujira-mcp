// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// Creating, listing and revoking a project's API keys, from the dashboard. An
// API key can never reach these routes, whatever it holds, so a leaked key
// cannot mint more keys or keep itself alive.
//
// The whole key is in the answer to its creation and nowhere else: not in the
// database, not in a log, not in a later list. Creating a key is not written
// to the idempotency store either, because that keeps answers in clear.

import { z } from 'zod';

import {
  API_KEY_DEFAULT_EXPIRY_DAYS,
  API_KEY_MAX_EXPIRY_DAYS,
  API_KEY_MIN_EXPIRY_DAYS,
  ApiKeyError,
  type ApiKeyService,
} from '../../auth/api-key-service.js';
import { API_SCOPES } from '../../auth/scopes.js';
import type { Authenticate, SessionAccess, SessionCaller } from '../authenticate.js';
import { decodeCursor, encodeCursor } from '../cursor.js';
import { ApiError } from '../errors.js';
import { defineRoute, type Route } from '../route.js';

// A key can pay out up to what it holds, so making one is kept to the people
// who manage the project.
export const KEY_MANAGERS: SessionAccess = { via: 'session', permission: 'manage_keys' };

const DEFAULT_PAGE = 50;

const keyName = z
  .string()
  .trim()
  .min(1)
  .max(100)
  // \p{Cc} is every control character, so a name cannot break a log line or a screen.
  .regex(/^\P{Cc}+$/u);

const createBody = z
  .object({
    name: keyName,
    scopes: z
      .array(z.enum(API_SCOPES))
      .min(1)
      .max(API_SCOPES.length)
      .refine((scopes) => new Set(scopes).size === scopes.length, 'each scope at most once'),
    expiresInDays: z.int().min(API_KEY_MIN_EXPIRY_DAYS).max(API_KEY_MAX_EXPIRY_DAYS).optional(),
  })
  .strict();

const listQuery = z
  .object({
    limit: z
      .string()
      .regex(/^(?:[1-9]\d?|100)$/)
      .optional(),
    cursor: z.string().optional(),
  })
  .strict();

const keyParams = z.object({ id: z.uuid() }).strict();

const cursorSchema = z.object({ after: z.uuid() }).strict();

export const apiKeySchema = z
  .object({
    principalId: z.uuid(),
    projectId: z.uuid(),
    id: z.uuid(),
    name: z.string().nullable(),
    // The public start of the key, so a person can tell keys apart.
    prefix: z.string(),
    scopes: z.array(z.string()),
    expiresAt: z.iso.datetime(),
    revokedAt: z.iso.datetime().nullable(),
    lastUsedAt: z.iso.datetime().nullable(),
    createdAt: z.iso.datetime(),
  })
  .strict();

const createdSchema = z
  .object({
    apiKey: apiKeySchema,
    /** The whole key. This answer is the only time anyone sees it. */
    secret: z.string(),
  })
  .strict();

const pageSchema = z
  .object({ items: z.array(apiKeySchema), nextCursor: z.string().nullable() })
  .strict();

export interface ApiKeyRouteOptions {
  readonly keys: ApiKeyService;
  readonly authenticate: Authenticate;
}

function toApiError(error: unknown): unknown {
  if (!(error instanceof ApiKeyError)) return error;
  switch (error.code) {
    case 'LIMIT_REACHED':
      return new ApiError('API_KEY_LIMIT_REACHED', 'Revoke a key before creating another');
    case 'NOT_FOUND':
      // Another project's key reads exactly like one that never existed.
      return new ApiError('NOT_FOUND', 'No such key');
  }
}

function tenantOf(caller: SessionCaller): { principalId: string; projectId: string } {
  return { principalId: caller.principalId, projectId: caller.projectId };
}

function actingMember(caller: SessionCaller) {
  return { tenant: tenantOf(caller), actorId: caller.memberId };
}

async function keyCall<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw toApiError(error);
  }
}

const AUTH_ERRORS = [
  'SESSION_INVALID',
  'ORIGIN_NOT_ALLOWED',
  'FORBIDDEN',
  'NOT_FOUND',
  'DB_UNAVAILABLE',
] as const;

export function apiKeyRoutes(o: ApiKeyRouteOptions): Route[] {
  const manager = o.authenticate(KEY_MANAGERS);

  const create = defineRoute({
    method: 'post',
    path: '/v1/api-keys',
    operationId: 'createApiKey',
    summary: 'Create an API key for the project',
    description: `The whole key is in this answer and never again; only its prefix and a hash are kept. It expires after expiresInDays, ${String(API_KEY_DEFAULT_EXPIRY_DAYS)} when left out. Owners and admins only, with a dashboard session.`,
    tags: ['api-keys'],
    body: createBody,
    status: 201,
    response: createdSchema,
    errors: [...AUTH_ERRORS, 'API_KEY_LIMIT_REACHED'],
    handler: async ({ body }, c) => {
      const caller = await manager(c);
      return keyCall(() =>
        o.keys.create(
          {
            name: body.name,
            scopes: body.scopes,
            expiresInDays: body.expiresInDays ?? API_KEY_DEFAULT_EXPIRY_DAYS,
          },
          actingMember(caller),
        ),
      );
    },
  });

  const list = defineRoute({
    method: 'get',
    path: '/v1/api-keys',
    operationId: 'listApiKeys',
    summary: "List the project's API keys",
    description:
      'Revoked and expired keys are listed too, so a person can see what stopped working.',
    tags: ['api-keys'],
    query: listQuery,
    response: pageSchema,
    errors: [...AUTH_ERRORS],
    handler: async ({ query }, c) => {
      const caller = await manager(c);
      const after =
        query.cursor === undefined ? undefined : decodeCursor(query.cursor, cursorSchema).after;
      const limit = query.limit === undefined ? DEFAULT_PAGE : Number.parseInt(query.limit, 10);
      const found = await o.keys.list(tenantOf(caller), {
        limit,
        ...(after === undefined ? {} : { after }),
      });
      return {
        items: found.items,
        nextCursor: found.next === null ? null : encodeCursor({ after: found.next }),
      };
    },
  });

  const revoke = defineRoute({
    method: 'delete',
    path: '/v1/api-keys/{id}',
    operationId: 'revokeApiKey',
    summary: 'Revoke an API key',
    description:
      'The key stops at once on this server and within 30 seconds everywhere. Revoking is permanent; revoking a key again returns it as it is.',
    tags: ['api-keys'],
    params: keyParams,
    response: z.object({ apiKey: apiKeySchema }).strict(),
    errors: [...AUTH_ERRORS],
    handler: async ({ params }, c) => {
      const caller = await manager(c);
      const apiKey = await keyCall(() => o.keys.revoke(params.id, actingMember(caller)));
      return { apiKey };
    },
  });

  return [create, list, revoke];
}
