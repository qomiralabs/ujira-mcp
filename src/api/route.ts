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
//
// A route that moves money is defined with defineIdempotentRoute instead. It
// cannot be declared without an Idempotency-Key store, so a money write that
// forgot its replay protection does not compile.

import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { z } from 'zod';

import type { ProjectContext } from '../db/index.js';
import { parseJsonText, readBodyBytes } from './body.js';
import type { V1Context } from './context.js';
import { ApiError, validationDetails, type ApiErrorCode, type ErrorDetail } from './errors.js';
import {
  answerOnce,
  idempotencyKeyOf,
  REPLAYED_HEADER,
  requestFingerprint,
  type Answer,
  type IdempotencyStore,
} from './idempotency.js';

export type HttpMethod = 'get' | 'post' | 'put' | 'patch' | 'delete';
export type WriteMethod = Exclude<HttpMethod, 'get'>;
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

/** Where an idempotent route keeps its keys, and who is asking. */
export interface RouteIdempotency<A extends ProjectContext> {
  readonly store: IdempotencyStore;
  /**
   * Runs before anything else on the route. Keys belong to the caller's
   * project, so the caller has to be known before a key can be looked up, and
   * a caller who is not signed in learns nothing about keys at all.
   */
  readonly authenticate: (c: V1Context) => Promise<A>;
  readonly log: (line: string) => void;
}

/** What an idempotent route's handler gets beside its input. */
export interface IdempotentCall<A extends ProjectContext> {
  /** The client's key, for a unique constraint of the handler's own. */
  readonly key: string;
  /** Who is asking, as `authenticate` found them. */
  readonly caller: A;
}

export interface IdempotentRouteDefinition<
  B extends z.ZodType,
  Q extends AnyObject,
  P extends AnyObject,
  R extends z.ZodType,
  A extends ProjectContext,
> extends Omit<RouteDefinition<B, Q, P, R>, 'method' | 'handler'> {
  readonly method: WriteMethod;
  readonly idempotency: RouteIdempotency<A>;
  readonly handler: (
    input: RouteInput<z.output<B>, z.output<Q>, z.output<P>> & {
      readonly idempotent: IdempotentCall<A>;
    },
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
  /** Whether the route takes an Idempotency-Key and replays its answers. */
  readonly idempotent: boolean;
  /**
   * Methods mounted on the same path and handed to `run` as well, but left out
   * of the OpenAPI document. A protocol such as MCP must answer some methods
   * with 405 rather than the 404 an unknown route gets.
   */
  readonly alsoMounted?: readonly HttpMethod[];
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
const JSON_TYPE = 'application/json; charset=utf-8';

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
  idempotent: boolean;
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
  // A read is safe to repeat as it is, so a key on one would only use up storage.
  if (d.method === 'get' && d.idempotent)
    throw new Error(`${where}: a GET takes no idempotency key`);
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

interface CommonDefinition {
  readonly method: HttpMethod;
  readonly path: string;
  readonly operationId: string;
  readonly summary: string;
  readonly description?: string | undefined;
  readonly tags?: readonly string[] | undefined;
  readonly body?: z.ZodType | undefined;
  readonly query?: AnyObject | undefined;
  readonly params?: AnyObject | undefined;
  readonly status?: SuccessStatus | undefined;
  readonly response: z.ZodType;
  readonly responseDescription?: string | undefined;
  readonly errors?: readonly ApiErrorCode[] | undefined;
}

interface ErasedInput {
  readonly body: unknown;
  readonly query: unknown;
  readonly params: unknown;
  readonly idempotent?: IdempotentCall<ProjectContext>;
}

type ErasedHandler = (input: ErasedInput, c: V1Context) => unknown;

function send(c: V1Context, answer: Answer, replayed: boolean): Response {
  // Statuses here are a route's own success status or a stored 4xx, none of
  // which is a status that forbids a body.
  return c.body(answer.body, answer.status as ContentfulStatusCode, {
    'content-type': JSON_TYPE,
    ...(replayed ? { [REPLAYED_HEADER]: 'true' } : {}),
  });
}

function buildRoute(
  d: CommonDefinition,
  idempotency: RouteIdempotency<ProjectContext> | undefined,
  handler: ErasedHandler,
): Route {
  checkDefinition({
    path: d.path,
    operationId: d.operationId,
    params: d.params,
    method: d.method,
    body: d.body,
    idempotent: idempotency !== undefined,
  });
  const status = d.status ?? 200;

  async function run(c: V1Context): Promise<Response> {
    let call: IdempotentCall<ProjectContext> | undefined;
    if (idempotency !== undefined) {
      const caller = await idempotency.authenticate(c);
      call = { caller, key: idempotencyKeyOf(c.req.raw.headers) };
    }
    // Without a declared schema the part is not read at all, so a stray
    // query string or body on a route that takes none is ignored.
    const query = d.query === undefined ? {} : parseOr400(d.query, queryObject(c.req.url), 'query');
    const params = d.params === undefined ? {} : parseOr400(d.params, c.req.param(), 'params');
    // The bytes are kept for the fingerprint. A request that fails its schema
    // never reaches the store, so it does not use up its key.
    let bodyBytes: Buffer | null = null;
    let body: unknown = undefined;
    if (d.body !== undefined) {
      bodyBytes = await readBodyBytes(c.req.raw);
      body = parseOr400(d.body, parseJsonText(bodyBytes.toString('utf8')), 'body');
    }
    const answer = async (): Promise<Answer> => {
      const out = await handler(
        { body, query, params, ...(call === undefined ? {} : { idempotent: call }) },
        c,
      );
      const checked = d.response.safeParse(out);
      if (!checked.success) throw new ResponseSchemaError(d.operationId);
      return { status, body: JSON.stringify(checked.data) };
    };
    if (idempotency === undefined || call === undefined) return send(c, await answer(), false);
    const once = await answerOnce(
      {
        store: idempotency.store,
        // Only the tenant, whatever else the caller carries.
        tenant: { principalId: call.caller.principalId, projectId: call.caller.projectId },
        key: call.key,
        requestSha256: requestFingerprint(d.method.toUpperCase(), new URL(c.req.url), bodyBytes),
        requestId: c.get('requestId'),
        operation: d.operationId,
        log: idempotency.log,
      },
      answer,
    );
    return send(c, once.answer, once.replayed);
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
    idempotent: idempotency !== undefined,
    run,
  };
}

export function defineRoute<
  B extends z.ZodType = z.ZodUndefined,
  Q extends AnyObject = AnyObject,
  P extends AnyObject = AnyObject,
  R extends z.ZodType = z.ZodType,
>(d: RouteDefinition<B, Q, P, R>): Route {
  return buildRoute(d, undefined, (input, c) =>
    d.handler(input as RouteInput<z.output<B>, z.output<Q>, z.output<P>>, c),
  );
}

/**
 * A write that must happen at most once per Idempotency-Key: every route that
 * moves money. The key is required, a retry gets the first answer back, and the
 * handler gets the key for a unique constraint of its own.
 */
export function defineIdempotentRoute<
  B extends z.ZodType = z.ZodUndefined,
  Q extends AnyObject = AnyObject,
  P extends AnyObject = AnyObject,
  R extends z.ZodType = z.ZodType,
  A extends ProjectContext = ProjectContext,
>(d: IdempotentRouteDefinition<B, Q, P, R, A>): Route {
  type Input = Parameters<typeof d.handler>[0];
  return buildRoute(d, d.idempotency, (input, c) => d.handler(input as Input, c));
}
