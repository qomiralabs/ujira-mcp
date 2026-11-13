// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The MCP server over Streamable HTTP, for a public URL anyone can add as a
// connector. Stateless: every POST gets a fresh server and transport, so no
// session lives in memory and a restart loses nothing but the rate limit
// counts. There is no auth, so the guards in public.ts carry the safety.
//
// Every answer this file writes itself is a fixed message. Nothing a caller
// sends, and nothing from an internal error, is echoed back or logged.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

import type { PayoutEngine } from '../engine/engine.js';
import {
  clientAddress,
  publicGuard,
  publicLimiters,
  publicNotes,
  rateKey,
  type HttpSettings,
} from './public.js';
import { createMcpServer, type ServerOptions } from './server.js';

/** One engine with the guard and notes it is served with. */
export interface McpBinding {
  readonly engine: PayoutEngine;
  readonly options: ServerOptions;
}

/**
 * Routes beyond /mcp and /healthz, such as the console API and its pages.
 * The server owns body limits, timeouts and the caller's address; the
 * handler owns everything it answers.
 */
export interface ExtraRoutes {
  /** The binding for /m/<id>/mcp, or undefined when that mandate is not served here. */
  mandateMcp(id: string, client: string): McpBinding | undefined;
  /** Answers the request and returns true, or returns false to let the server say 404. */
  handle(req: IncomingMessage, res: ServerResponse, path: string, client: string): Promise<boolean>;
}

export interface HttpServerOptions {
  readonly engine: PayoutEngine;
  readonly settings: HttpSettings;
  readonly assetCode: string;
  /** Allowlisted destinations to tell visitors about. */
  readonly recipients?: readonly string[];
  /** One line per request: method, path, status and time. Never addresses or bodies. */
  readonly log?: (line: string) => void;
  readonly now?: () => number;
  readonly extra?: ExtraRoutes;
}

export class BodyTooLarge extends Error {}

export function send(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
) {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

/** A JSON-RPC error with no id, the shape MCP clients expect from a refused POST. */
function rpcError(
  res: ServerResponse,
  status: number,
  code: number,
  message: string,
  headers?: Record<string, string>,
) {
  send(res, status, { jsonrpc: '2.0', error: { code, message }, id: null }, headers);
}

export function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) {
      reject(new BodyTooLarge());
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        req.off('data', onData);
        reject(new BodyTooLarge());
        return;
      }
      chunks.push(chunk);
    };
    req.on('data', onData);
    req.on('end', () => {
      resolve(Buffer.concat(chunks));
    });
    req.on('error', reject);
  });
}

/** /m/<mandate>/mcp, the per mandate connector URL. */
const MANDATE_MCP = /^\/m\/(C[A-Z2-7]{55})\/mcp$/;

/** The path label a log line carries: a route, never an address. */
function routeLabel(path: string): string {
  if (path === '/mcp' || path === '/healthz') return path;
  if (MANDATE_MCP.test(path)) return '/m/:id/mcp';
  if (path.startsWith('/api/')) return '/api';
  return 'other';
}

export function createHttpServer(options: HttpServerOptions): Server {
  const { engine, settings, assetCode, extra } = options;
  const log = options.log ?? (() => undefined);
  const now = options.now ?? Date.now;
  const limiters = publicLimiters(settings.limits, now);
  const allowed = new Set(settings.allowedOrigins);
  const { notes, instructions } = publicNotes(settings.limits, assetCode, options.recipients ?? []);

  async function mcp(
    req: IncomingMessage,
    res: ServerResponse,
    path: string,
    bind: (client: string) => McpBinding | undefined,
  ): Promise<void> {
    // Browsers send Origin; server to server clients do not, and are let in.
    const origin = req.headers.origin;
    if (origin !== undefined && !allowed.has(origin.replace(/\/+$/, '').toLowerCase())) {
      rpcError(res, 403, -32000, 'This origin may not call this server');
      return;
    }
    if (req.method !== 'POST') {
      // Stateless: no stream to open with GET and no session to end with DELETE.
      // The path matched a fixed pattern, so echoing it repeats nothing the caller chose freely.
      rpcError(res, 405, -32000, `Method not allowed; POST JSON-RPC to ${path}`, {
        allow: 'POST',
      });
      return;
    }
    const client = rateKey(clientAddress(req.headers, req.socket.remoteAddress, settings.clientIp));
    const binding = bind(client);
    if (binding === undefined) {
      rpcError(res, 404, -32000, 'This server does not serve that mandate');
      return;
    }
    let raw: Buffer;
    try {
      raw = await readBody(req, settings.maxBodyBytes);
    } catch (error) {
      if (!(error instanceof BodyTooLarge)) throw error;
      rpcError(res, 413, -32000, 'The request body is too large', { connection: 'close' });
      // Drop the rest unread instead of buffering it.
      req.resume();
      return;
    }
    let body: unknown;
    try {
      body = JSON.parse(raw.toString('utf8'));
    } catch {
      rpcError(res, 400, -32700, 'Parse error');
      return;
    }

    const server = createMcpServer(binding.engine, {
      ...binding.options,
      onInternalError: (name) => {
        log(`internal error (${name})`);
      },
    });
    const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    // The SDK's own types disagree under exactOptionalPropertyTypes (its
    // getters may return undefined where Transport says they may not).
    await server.connect(transport as Transport);
    await transport.handleRequest(req, res, body);
  }

  const demo = (client: string): McpBinding => ({
    engine,
    options: {
      guard: publicGuard({ limits: settings.limits, limiters, client, assetCode }),
      notes,
      instructions,
    },
  });

  async function route(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
    if (path === '/healthz') {
      if (req.method === 'GET' || req.method === 'HEAD') send(res, 200, { status: 'ok' });
      else send(res, 405, { error: 'method not allowed' }, { allow: 'GET' });
      return;
    }
    if (path === '/mcp') {
      await mcp(req, res, path, demo);
      return;
    }
    if (extra !== undefined) {
      const id = MANDATE_MCP.exec(path)?.[1];
      if (id !== undefined) {
        await mcp(req, res, path, (client) => extra.mandateMcp(id, client));
        return;
      }
      const client = rateKey(
        clientAddress(req.headers, req.socket.remoteAddress, settings.clientIp),
      );
      if (await extra.handle(req, res, path, client)) return;
    }
    send(res, 404, { error: 'not found' });
  }

  /** The API answers in its own error shape; everything else is JSON-RPC. */
  function failure(res: ServerResponse, path: string, status: number, message: string) {
    if (path.startsWith('/api/')) {
      send(res, status, {
        error: { code: status === 504 ? 'timeout' : 'internal_error', message },
      });
    } else {
      rpcError(res, status, status === 504 ? -32000 : -32603, message);
    }
  }

  const server = createServer((req, res) => {
    const started = now();
    const path = (req.url ?? '/').split('?')[0] ?? '/';
    const known = routeLabel(path);
    // A payout waits for the ledger, so the limit is generous, but nothing waits forever.
    const deadline = setTimeout(() => {
      failure(res, path, 504, 'The request took too long');
    }, settings.requestTimeoutMs);
    res.on('close', () => {
      clearTimeout(deadline);
      log(`${req.method ?? '?'} ${known} ${res.statusCode} ${now() - started}ms`);
    });
    route(req, res, path).catch((error: unknown) => {
      log(`request failed (${error instanceof Error ? error.name : 'NonError'})`);
      failure(res, path, 500, 'Internal error');
    });
  });
  // Receiving the request is bounded separately from answering it, so a slow
  // sender cannot hold a socket open.
  server.headersTimeout = 15_000;
  server.requestTimeout = 30_000;
  // Longer than the platform proxy keeps idle connections, so it never reuses one we closed.
  server.keepAliveTimeout = 75_000;
  return server;
}
