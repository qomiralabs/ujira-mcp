// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// Routes about the API itself, open to anyone: a liveness check that goes
// through the whole /v1 stack, and the OpenAPI document.

import { z } from 'zod';

import type { OpenApiDocument } from '../openapi.js';
import { defineRoute } from '../route.js';

export const pingRoute = defineRoute({
  method: 'get',
  path: '/v1/ping',
  operationId: 'ping',
  summary: 'Check that the API answers',
  description: 'Touches no database and no chain, so it says only that /v1 is reachable.',
  tags: ['meta'],
  response: z.object({ status: z.literal('ok') }).strict(),
  handler: () => ({ status: 'ok' as const }),
});

/** Checks the shape a client relies on and passes the rest of the document through as it is. */
const documentSchema = z.looseObject({
  openapi: z.string(),
  info: z.looseObject({ title: z.string(), version: z.string() }),
  paths: z.record(z.string(), z.unknown()),
});

/** The document is built from the full route list, which includes this route, so it is read lazily. */
export function openApiRoute(document: () => OpenApiDocument) {
  return defineRoute({
    method: 'get',
    path: '/v1/openapi.json',
    operationId: 'getOpenApi',
    summary: 'The OpenAPI 3.1 document for /v1',
    tags: ['meta'],
    response: documentSchema,
    responseDescription: 'An OpenAPI 3.1 document',
    // The document's interfaces have no index signature, which the loose schema's input type wants.
    handler: () => document() as unknown as z.input<typeof documentSchema>,
  });
}
