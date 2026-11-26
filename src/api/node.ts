// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// Plugs the /v1 Hono app into the existing node:http server, so /v1 sits
// beside /api, /mcp and the static pages on one port without changing them.

import type { IncomingMessage, ServerResponse } from 'node:http';

import { getRequestListener } from '@hono/node-server';
import type { Hono } from 'hono';

import type { V1Bindings, V1Env } from './context.js';

export interface V1RequestContext {
  readonly requestId: string;
  readonly client: string;
}

export type V1Handler = (
  req: IncomingMessage,
  res: ServerResponse,
  context: V1RequestContext,
) => Promise<void>;

export function nodeHandler(app: Hono<V1Env>): V1Handler {
  // The listener only hands the fetch callback the raw request objects, so
  // the per request context rides along keyed on the request itself.
  const contexts = new WeakMap<object, V1RequestContext>();
  const listener = getRequestListener(
    (request, env) => {
      const context = contexts.get(env.incoming);
      const bindings: V1Bindings =
        context === undefined ? {} : { requestId: context.requestId, client: context.client };
      return app.fetch(request, bindings);
    },
    // Left on, the adapter swaps the process wide Request and Response for
    // its own, which would change them under the MCP server too.
    { overrideGlobalObjects: false },
  );
  return async (req, res, context) => {
    contexts.set(req, context);
    await listener(req, res);
  };
}
