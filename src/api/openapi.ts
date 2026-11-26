// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The OpenAPI 3.1 document for /v1, generated from the same route
// definitions the app mounts. OpenAPI 3.1 schemas are JSON Schema 2020-12,
// which is what zod emits, so no second schema language sits in between.
//
// Generation is strict: a schema zod cannot express in JSON Schema (a
// bigint, a transform without an output type) fails at start rather than
// publishing a document that lies about the wire.

import { z } from 'zod';

import { MAX_BODY_BYTES } from './body.js';
import { REQUEST_ID_HEADER } from './context.js';
import { API_ERROR_STATUS, errorEnvelopeSchema, type ApiErrorCode } from './errors.js';
import type { Route } from './route.js';

export const OPENAPI_VERSION = '3.1.0';

export interface OpenApiInfo {
  readonly title: string;
  readonly version: string;
  readonly description?: string;
}

export type JsonObject = Record<string, unknown>;

export interface OpenApiDocument {
  readonly openapi: typeof OPENAPI_VERSION;
  readonly info: OpenApiInfo;
  readonly paths: Record<string, Record<string, JsonObject>>;
  readonly components: JsonObject;
}

function jsonSchema(schema: z.ZodType, io: 'input' | 'output'): JsonObject {
  const out = z.toJSONSchema(schema, {
    target: 'draft-2020-12',
    io,
    unrepresentable: 'throw',
  }) as JsonObject;
  // The document names its dialect once; repeating it per schema adds nothing.
  delete out['$schema'];
  return out;
}

const ERROR_REF = { $ref: '#/components/schemas/ErrorEnvelope' };
const REQUEST_ID_REF = { $ref: '#/components/headers/RequestId' };

/** Every route can answer these, whatever it declares. */
const ALWAYS: readonly ApiErrorCode[] = ['INTERNAL'];
const WITH_INPUT: readonly ApiErrorCode[] = ['INVALID_REQUEST'];
const WITH_BODY: readonly ApiErrorCode[] = ['PAYLOAD_TOO_LARGE', 'UNSUPPORTED_MEDIA_TYPE'];

function parameters(schema: z.ZodObject | undefined, where: 'path' | 'query'): JsonObject[] {
  if (schema === undefined) return [];
  const object = jsonSchema(schema, 'input');
  const properties = (object['properties'] ?? {}) as Record<string, JsonObject>;
  const required = new Set((object['required'] ?? []) as string[]);
  return Object.entries(properties).map(([name, property]) => {
    const { description, ...rest } = property;
    return {
      name,
      in: where,
      required: where === 'path' || required.has(name),
      ...(typeof description === 'string' ? { description } : {}),
      schema: rest,
    };
  });
}

function errorResponses(route: Route): Record<string, JsonObject> {
  const codes = new Set<ApiErrorCode>([...ALWAYS, ...route.errors]);
  if (route.body !== undefined || route.query !== undefined || route.params !== undefined) {
    for (const code of WITH_INPUT) codes.add(code);
  }
  if (route.body !== undefined) for (const code of WITH_BODY) codes.add(code);
  const byStatus = new Map<number, ApiErrorCode[]>();
  for (const code of codes) {
    const status = API_ERROR_STATUS[code];
    byStatus.set(status, [...(byStatus.get(status) ?? []), code]);
  }
  const out: Record<string, JsonObject> = {};
  for (const [status, list] of [...byStatus].sort(([a], [b]) => a - b)) {
    out[String(status)] = {
      description: list.sort().join(', '),
      headers: { [REQUEST_ID_HEADER]: REQUEST_ID_REF },
      content: { 'application/json': { schema: ERROR_REF } },
    };
  }
  return out;
}

function operation(route: Route): JsonObject {
  const params = [...parameters(route.params, 'path'), ...parameters(route.query, 'query')];
  return {
    operationId: route.operationId,
    summary: route.summary,
    ...(route.description === undefined ? {} : { description: route.description }),
    ...(route.tags.length === 0 ? {} : { tags: [...route.tags] }),
    ...(params.length === 0 ? {} : { parameters: params }),
    ...(route.body === undefined
      ? {}
      : {
          requestBody: {
            required: true,
            description: `JSON, at most ${MAX_BODY_BYTES} bytes.`,
            content: { 'application/json': { schema: jsonSchema(route.body, 'input') } },
          },
        }),
    responses: {
      [String(route.status)]: {
        description: route.responseDescription,
        headers: { [REQUEST_ID_HEADER]: REQUEST_ID_REF },
        content: { 'application/json': { schema: jsonSchema(route.response, 'output') } },
      },
      ...errorResponses(route),
    },
  };
}

export function buildOpenApi(routes: readonly Route[], info: OpenApiInfo): OpenApiDocument {
  const paths: Record<string, Record<string, JsonObject>> = {};
  const operationIds = new Set<string>();
  for (const route of routes) {
    if (operationIds.has(route.operationId)) {
      throw new Error(`two routes share the operationId ${route.operationId}`);
    }
    operationIds.add(route.operationId);
    const item = (paths[route.path] ??= {});
    if (item[route.method] !== undefined) {
      throw new Error(`two routes answer ${route.method.toUpperCase()} ${route.path}`);
    }
    item[route.method] = operation(route);
  }
  return {
    openapi: OPENAPI_VERSION,
    info: {
      title: info.title,
      version: info.version,
      ...(info.description === undefined ? {} : { description: info.description }),
    },
    paths,
    components: {
      schemas: { ErrorEnvelope: jsonSchema(errorEnvelopeSchema, 'output') },
      headers: {
        RequestId: {
          description: 'Names this request in our logs. Quote it when asking for support.',
          required: true,
          schema: { type: 'string' },
        },
      },
    },
  };
}
