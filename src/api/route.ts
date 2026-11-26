// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// A /v1 route is data first: its method, path and zod schemas are what the
// app mounts, what validates every request and what the OpenAPI document is
// generated from, so the published contract cannot drift from the code.
//
// Handlers only ever see input that passed its schema, and their output is
// checked against the response schema before it leaves, so a handler that
// returns a field the schema does not declare fails loudly in tests instead
// of leaking it.

import { z } from 'zod';

import { readJsonBody } from './body.js';
import type { V1Context } from './context.js';
import { ApiError, validationDetails, type ApiErrorCode, type ErrorDetail } from './errors.js';

export type HttpMethod = 'get' | 'post' | 'put' | 'patch' | 'delete';
export type SuccessStatus = 200 | 201 | 202;

export interface RouteInput<B, Q, P> {
  readonly body: B;
  readonly query: Q;
  readonly params: P;
}

type AnyObject = z.ZodObject;

export interface RouteDefinition<
  B extends z.ZodType,
  Q extends AnyObject,
  P extends AnyObject,
  R extends z.ZodType,
> {
  readonly method: HttpMethod;
  /** OpenAPI style, such as `/v1/payouts/{id}`. */
  readonly path: string;
  readonly operationId: string;
  readonly summary: string;
  readonly description?: string;
  readonly tags?: readonly string[];
  readonly body?: B;
  readonly query?: Q;
  readonly params?: P;
  /** Defaults to 200. */
  readonly status?: SuccessStatus;
  readonly response: R;
  readonly responseDescription?: string;
  /** Codes this route answers beyond the ones every route can. */
  readonly errors?: readonly ApiErrorCode[];
  readonly handler: (
    input: RouteInput<z.output<B>, z.output<Q>, z.output<P>>,
    c: V1Context,
  ) => Promise<z.input<R>> | z.input<R>;
}

/** A route with its types erased, as the app and the OpenAPI generator hold it. */
export interface Route {
  readonly method: HttpMethod;
  readonly path: string;
  readonly operationId: string;
  readonly summary: string;
  readonly description: string | undefined;
  readonly tags: readonly string[];
  readonly status: SuccessStatus;
  readonly errors: readonly ApiErrorCode[];
  readonly body: z.ZodType | undefined;
  readonly query: AnyObject | undefined;
  readonly params: AnyObject | undefined;
  readonly response: z.ZodType;
  readonly responseDescription: string;
  run(c: V1Context): Promise<Response>;
}

/** Raised when a handler's output breaks its own response schema: a bug, answered as INTERNAL. */
export class ResponseSchemaError extends Error {
  constructor(operationId: string) {
    super(`the response of ${operationId} does not match its schema`);
    this.name = 'ResponseSchemaError';
  }
}

const SEGMENT = /^(?:[a-z0-9][a-z0-9._-]*|\{[a-zA-Z][a-zA-Z0-9]*\})$/;
const OPERATION_ID = /^[a-z][a-zA-Z0-9]*$/;

/** The names inside braces, in order. */
export function pathParams(path: string): string[] {
  return [...path.matchAll(/\{([a-zA-Z][a-zA-Z0-9]*)\}/g)].map((m) => m[1] ?? '');
}

/** `/v1/payouts/{id}` as Hono writes it, `/v1/payouts/:id`. */
export function honoPath(path: string): string {
  return path.replace(/\{([a-zA-Z][a-zA-Z0-9]*)\}/g, ':$1');
}

/** A route that is wrong by construction never gets mounted; this runs at start, not per request. */
function checkDefinition(d: {
  path: string;
  operationId: string;
  params: AnyObject | undefined;
  method: HttpMethod;
  body: z.ZodType | undefined;
}): void {
  const where = `route ${d.operationId}`;
  if (!OPERATION_ID.test(d.operationId))
    throw new Error(`${where}: operationId must be lower camel case`);
  const segments = d.path.split('/').slice(1);
  if (
    segments[0] !== 'v1' ||
    segments.length < 2 ||
    !segments.slice(1).every((s) => SEGMENT.test(s))
  ) {
    throw new Error(`${where}: path must be /v1/ followed by lower case segments or {params}`);
  }
  const declared = pathParams(d.path).sort();
  const schema = Object.keys(d.params?.shape ?? {}).sort();
  if (declared.join(',') !== schema.join(',')) {
    throw new Error(`${where}: the params schema must name exactly the path parameters`);
  }
  if (d.method === 'get' && d.body !== undefined) throw new Error(`${where}: a GET takes no body`);
}

function parseOr400<T extends z.ZodType>(schema: T, value: unknown, prefix: string): z.output<T> {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new ApiError('INVALID_REQUEST', 'The request does not match the schema', {
    details: validationDetails(parsed.error, prefix),
  });
}

/** Query values as single strings; a repeated key is refused rather than silently picking one. */
function queryObject(url: string): Record<string, string> {
  const out: Record<string, string> = {};
  const repeated: ErrorDetail[] = [];
  for (const [key, value] of new URL(url).searchParams) {
    if (Object.hasOwn(out, key))
      repeated.push({ path: `query.${key.slice(0, 64)}`, issue: 'repeated' });
    else out[key] = value;
  }
  if (repeated.length > 0) {
    throw new ApiError('INVALID_REQUEST', 'A query parameter is repeated', {
      details: repeated.slice(0, 20),
    });
  }
  return out;
}

export function defineRoute<
  B extends z.ZodType = z.ZodUndefined,
  Q extends AnyObject = AnyObject,
  P extends AnyObject = AnyObject,
  R extends z.ZodType = z.ZodType,
>(d: RouteDefinition<B, Q, P, R>): Route {
  checkDefinition({
    path: d.path,
    operationId: d.operationId,
    params: d.params,
    method: d.method,
    body: d.body,
  });
  const status = d.status ?? 200;

  async function run(c: V1Context): Promise<Response> {
    // Without a declared schema the part is not read at all, so a stray
    // query string or body on a route that takes none is ignored.
    const query = d.query === undefined ? {} : parseOr400(d.query, queryObject(c.req.url), 'query');
    const params = d.params === undefined ? {} : parseOr400(d.params, c.req.param(), 'params');
    const body =
      d.body === undefined ? undefined : parseOr400(d.body, await readJsonBody(c.req.raw), 'body');
    const out = await d.handler(
      {
        body: body as z.output<B>,
        query: query as z.output<Q>,
        params: params as z.output<P>,
      },
      c,
    );
    const checked = d.response.safeParse(out);
    if (!checked.success) throw new ResponseSchemaError(d.operationId);
    return c.body(JSON.stringify(checked.data), status, {
      'content-type': 'application/json; charset=utf-8',
    });
  }

  return {
    method: d.method,
    path: d.path,
    operationId: d.operationId,
    summary: d.summary,
    description: d.description,
    tags: d.tags ?? [],
    status,
    errors: d.errors ?? [],
    body: d.body,
    query: d.query,
    params: d.params,
    response: d.response,
    responseDescription: d.responseDescription ?? 'OK',
    run,
  };
}
