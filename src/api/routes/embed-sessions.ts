// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// POST, GET /v1/embed/sessions, DELETE /v1/embed/sessions/{id}, and
// GET, PUT /v1/embed/origins: how a project hands the onboarding widget to
// one of its recipients, takes it back, and says which pages may run it.
//
// Each takes an API key with the recipients scope or a dashboard session
// whose role allows it. A session is made for one recipient of the caller's
// project; another project's recipient reads as not found.
//
// Making a session is deliberately not replayed from idempotency storage: the
// answer is the token, which must never be stored in clear. A retry makes a
// second session, which the first one's expiry or a revoke ends.

import { z } from 'zod';

import {
  EMBED_SESSION_MAX_SECONDS,
  EMBED_SESSION_MIN_SECONDS,
  MAX_EMBED_ORIGINS,
  type EmbedSession,
  type ProjectContext,
} from '../../db/index.js';
import {
  DEFAULT_EMBED_SESSION_SECONDS,
  EmbedError,
  type EmbedSessionService,
} from '../../identity/embed.js';
import type { Authenticate } from '../authenticate.js';
import { decodeCursor, encodeCursor } from '../cursor.js';
import { ApiError } from '../errors.js';
import { defineRoute, type Route } from '../route.js';

export interface EmbedSessionRouteOptions {
  readonly service: EmbedSessionService;
  readonly authenticate: Authenticate;
}

export const DEFAULT_SESSION_PAGE_SIZE = 50;

// Only the tenant goes on: the service has no use for the key or the session behind it.
function tenantOf(caller: ProjectContext): ProjectContext {
  return { principalId: caller.principalId, projectId: caller.projectId };
}

// The exact form a browser sends: https, or http on the developer's own
// machine, a lower case host, an optional port, no path. The database holds
// the same rule.
const ORIGIN_FORMAT =
  /^(?:https:\/\/[a-z0-9.-]{1,253}(?::[0-9]{1,5})?|http:\/\/localhost(?::[0-9]{1,5})?)$/;

const origin = z
  .string()
  .max(270)
  .refine(
    (text) => {
      if (!ORIGIN_FORMAT.test(text)) return false;
      try {
        return new URL(text).origin === text;
      } catch {
        return false;
      }
    },
    { message: 'an origin such as https://example.com' },
  );

const createBody = z
  .object({
    recipientId: z.uuid(),
    expiresInSeconds: z
      .number()
      .int()
      .min(EMBED_SESSION_MIN_SECONDS)
      .max(EMBED_SESSION_MAX_SECONDS)
      .optional(),
  })
  .strict();

const listQuery = z
  .object({
    recipientId: z.uuid().optional(),
    cursor: z.string().min(1).max(512).optional(),
    limit: z
      .string()
      .regex(/^(?:[1-9]|[1-9][0-9]|100)$/)
      .optional(),
  })
  .strict();

const idParams = z.object({ id: z.uuid() }).strict();

// The newest first key a page ended on: a creation time to the microsecond and an id.
const cursorSchema = z
  .object({
    after: z
      .string()
      .regex(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z\|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      ),
  })
  .strict();

const originsBody = z.object({ origins: z.array(origin).max(MAX_EMBED_ORIGINS) }).strict();
const originsAnswer = z.object({ origins: z.array(z.string()) }).strict();

const sessionSchema = z
  .object({
    id: z.uuid(),
    recipientId: z.uuid(),
    createdAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
    revokedAt: z.iso.datetime().nullable(),
  })
  .strict();

function sessionWire(session: EmbedSession): z.input<typeof sessionSchema> {
  return {
    id: session.id,
    recipientId: session.recipientId,
    createdAt: session.createdAt.toISOString(),
    expiresAt: session.expiresAt.toISOString(),
    revokedAt: session.revokedAt === null ? null : session.revokedAt.toISOString(),
  };
}

// The service's refusals as the one error envelope, with fixed messages.
export function embedSessionApiError(error: unknown): unknown {
  if (!(error instanceof EmbedError)) return error;
  switch (error.code) {
    case 'RECIPIENT_NOT_FOUND':
      return new ApiError('NOT_FOUND', 'No such recipient', { cause: error });
    case 'SESSION_NOT_FOUND':
      return new ApiError('NOT_FOUND', 'No such embed session', { cause: error });
    case 'RECIPIENT_SUSPENDED':
      return new ApiError('FORBIDDEN', 'Payouts to this recipient are on hold', { cause: error });
    default:
      return error;
  }
}

async function answering<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw embedSessionApiError(error);
  }
}

const AUTH_ERRORS = [
  'TOKEN_MALFORMED',
  'TOKEN_INVALID',
  'TOKEN_ENVIRONMENT_MISMATCH',
  'SESSION_INVALID',
  'FORBIDDEN',
  'DB_UNAVAILABLE',
] as const;

export function embedSessionRoutes(o: EmbedSessionRouteOptions): Route[] {
  const create = defineRoute({
    method: 'post',
    path: '/v1/embed/sessions',
    operationId: 'createEmbedSession',
    summary: 'Make a short lived token for the onboarding widget',
    description:
      'The token lets the widget act for this one recipient, from the hosted invite page or a page the project allows, until it expires or is revoked. It lasts 30 minutes unless expiresInSeconds says otherwise, from 5 minutes to 7 days. It is returned once and only its hash is kept, so this is never replayed: a retry makes another session.',
    tags: ['embed'],
    body: createBody,
    status: 201,
    response: z.object({ session: sessionSchema, token: z.string() }).strict(),
    responseDescription: 'The session, and its token, shown this once',
    errors: [...AUTH_ERRORS, 'ORIGIN_NOT_ALLOWED', 'NOT_FOUND'],
    handler: async ({ body }, c) => {
      const caller = tenantOf(await o.authenticate({ scope: 'recipients:write' })(c));
      const created = await answering(() =>
        o.service.create(caller, {
          recipientId: body.recipientId,
          expiresInSeconds: body.expiresInSeconds ?? DEFAULT_EMBED_SESSION_SECONDS,
        }),
      );
      return { session: sessionWire(created.session), token: created.token };
    },
  });

  const list = defineRoute({
    method: 'get',
    path: '/v1/embed/sessions',
    operationId: 'listEmbedSessions',
    summary: 'List embed sessions',
    description:
      "The project's embed sessions newest first, optionally of one recipient. Tokens are never listed.",
    tags: ['embed'],
    query: listQuery,
    response: z
      .object({ items: z.array(sessionSchema), nextCursor: z.string().nullable() })
      .strict(),
    errors: [...AUTH_ERRORS],
    handler: async ({ query }, c) => {
      const caller = tenantOf(await o.authenticate({ scope: 'recipients:read' })(c));
      const after =
        query.cursor === undefined ? undefined : decodeCursor(query.cursor, cursorSchema).after;
      const page = await answering(() =>
        o.service.list(caller, {
          recipientId: query.recipientId,
          after,
          limit:
            query.limit === undefined
              ? DEFAULT_SESSION_PAGE_SIZE
              : Number.parseInt(query.limit, 10),
        }),
      );
      return {
        items: page.items.map(sessionWire),
        nextCursor: page.next === null ? null : encodeCursor({ after: page.next }),
      };
    },
  });

  const revoke = defineRoute({
    method: 'delete',
    path: '/v1/embed/sessions/{id}',
    operationId: 'revokeEmbedSession',
    summary: 'Revoke an embed session',
    description:
      'Its token stops working on the next request. Revoking a session already revoked changes nothing.',
    tags: ['embed'],
    params: idParams,
    response: z.object({ session: sessionSchema }).strict(),
    errors: [...AUTH_ERRORS, 'ORIGIN_NOT_ALLOWED', 'NOT_FOUND'],
    handler: async ({ params }, c) => {
      const caller = tenantOf(await o.authenticate({ scope: 'recipients:write' })(c));
      const session = await answering(() => o.service.revoke(caller, params.id));
      return { session: sessionWire(session) };
    },
  });

  const origins = defineRoute({
    method: 'get',
    path: '/v1/embed/origins',
    operationId: 'getEmbedOrigins',
    summary: 'The pages the widget may run on',
    description:
      "The origins of the project's own pages where its embed tokens work. The hosted invite page always works and is not listed.",
    tags: ['embed'],
    response: originsAnswer,
    errors: [...AUTH_ERRORS],
    handler: async (_input, c) => {
      const caller = tenantOf(await o.authenticate({ scope: 'recipients:read' })(c));
      return { origins: await o.service.allowedOrigins(caller) };
    },
  });

  const setOrigins = defineRoute({
    method: 'put',
    path: '/v1/embed/origins',
    operationId: 'setEmbedOrigins',
    summary: 'Say which pages the widget may run on',
    description:
      'Replaces the list, at most 10 origins, each exactly as a browser sends it, such as https://pay.example.com. A token already made follows the new list on its next request.',
    tags: ['embed'],
    body: originsBody,
    response: originsAnswer,
    errors: [...AUTH_ERRORS, 'ORIGIN_NOT_ALLOWED'],
    handler: async ({ body }, c) => {
      const caller = tenantOf(await o.authenticate({ scope: 'recipients:write' })(c));
      return { origins: await o.service.setAllowedOrigins(caller, body.origins) };
    },
  });

  return [create, list, revoke, origins, setOrigins];
}
