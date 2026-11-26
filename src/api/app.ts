// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The public API at /v1. Every answer, success or failure, carries
// Ujira-Request-Id, and every failure is the one error envelope, so a client
// never has to tell a framework's default page from ours.
//
// Log lines name the request id, the matched route pattern and the error
// class. Never the raw path, a header, a body or an error message, since
// any of those can carry a key or a person's data.

import { randomUUID } from 'node:crypto';

import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { routePath } from 'hono/route';

import { bodyGuard, MAX_BODY_BYTES } from './body.js';
import { REQUEST_ID_HEADER, type V1Context, type V1Env } from './context.js';
import { ApiError, envelope, type ApiErrorCode, type ErrorDetail } from './errors.js';
import { buildOpenApi, type OpenApiDocument, type OpenApiInfo } from './openapi.js';
import { honoPath, type Route } from './route.js';
import { openApiRoute, pingRoute } from './routes/meta.js';

export interface V1AppOptions {
  /** Routes beyond the built in ping and OpenAPI ones. */
  readonly routes?: readonly Route[];
  readonly log?: (line: string) => void;
  readonly maxBodyBytes?: number;
  readonly info?: OpenApiInfo;
}

export interface V1App {
  readonly app: Hono<V1Env>;
  readonly routes: readonly Route[];
  readonly document: OpenApiDocument;
}

export const DEFAULT_INFO: OpenApiInfo = {
  title: 'UJIRA API',
  version: '1',
  description:
    'Mandate bound payouts on Stellar. Amounts are integer minor units as decimal strings, with an explicit asset, network and scale.',
};

/** Hono's own exceptions, mapped onto our codes so none of its default bodies leak out. */
function codeForStatus(status: number): ApiErrorCode {
  switch (status) {
    case 400:
      return 'INVALID_REQUEST';
    case 404:
      return 'NOT_FOUND';
    case 413:
      return 'PAYLOAD_TOO_LARGE';
    case 415:
      return 'UNSUPPORTED_MEDIA_TYPE';
    default:
      return 'INTERNAL';
  }
}

const FIXED_MESSAGE: Partial<Record<ApiErrorCode, string>> = {
  INVALID_REQUEST: 'The request is not valid',
  NOT_FOUND: 'No such route',
  PAYLOAD_TOO_LARGE: 'The request body is too large',
  UNSUPPORTED_MEDIA_TYPE: 'Request bodies must be application/json',
  INTERNAL: 'Internal error',
};

function errorResponse(
  c: V1Context,
  code: ApiErrorCode,
  status: number,
  message: string,
  details?: readonly ErrorDetail[],
  headers: Readonly<Record<string, string>> = {},
): Response {
  // Set by the first middleware, before anything that can fail.
  const requestId = c.get('requestId');
  return new Response(JSON.stringify(envelope(code, message, requestId, details)), {
    status,
    headers: {
      ...headers,
      'content-type': 'application/json; charset=utf-8',
      [REQUEST_ID_HEADER]: requestId,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'NonError';
}

export function createV1App(options: V1AppOptions = {}): V1App {
  const log = options.log ?? (() => undefined);
  const routes: readonly Route[] = [
    pingRoute,
    // Only called per request, long after the document below exists.
    openApiRoute(() => document),
    ...(options.routes ?? []),
  ];
  // Built once at start: a route that cannot be documented stops the server
  // from starting instead of failing the first time someone asks.
  const document = buildOpenApi(routes, options.info ?? DEFAULT_INFO);

  const app = new Hono<V1Env>();

  app.use(async (c, next) => {
    const env = c.env as V1Env['Bindings'] | undefined;
    const requestId = env?.requestId ?? randomUUID();
    c.set('requestId', requestId);
    await next();
    c.header(REQUEST_ID_HEADER, requestId);
    c.header('cache-control', 'no-store');
    c.header('x-content-type-options', 'nosniff');
  });
  app.use(bodyGuard(options.maxBodyBytes ?? MAX_BODY_BYTES));

  for (const route of routes) {
    app.on(route.method.toUpperCase(), honoPath(route.path), (c) => route.run(c));
  }

  app.notFound((c) => errorResponse(c, 'NOT_FOUND', 404, 'No such route'));

  app.onError((error, c) => {
    if (error instanceof ApiError) {
      return errorResponse(
        c,
        error.code,
        error.status,
        error.message,
        error.details,
        error.headers,
      );
    }
    if (error instanceof HTTPException) {
      const code = codeForStatus(error.status);
      const status = code === 'INTERNAL' ? 500 : error.status;
      return errorResponse(c, code, status, FIXED_MESSAGE[code] ?? 'Internal error');
    }
    log(
      `event=v1_internal_error requestId=${c.get('requestId')} route=${routePath(c)} error=${errorName(error)}`,
    );
    return errorResponse(c, 'INTERNAL', 500, 'Internal error');
  });

  return { app, routes, document };
}
