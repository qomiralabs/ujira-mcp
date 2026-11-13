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
import { createMcpServer } from './server.js';

export interface HttpServerOptions {
  readonly engine: PayoutEngine;
  readonly settings: HttpSettings;
  readonly assetCode: string;
  /** Allowlisted destinations to tell visitors about. */
  readonly recipients?: readonly string[];
  /** One line per request: method, path, status and time. Never addresses or bodies. */
  readonly log?: (line: string) => void;
  readonly now?: () => number;
}

class BodyTooLarge extends Error {}

function send(
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

function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
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

export function createHttpServer(options: HttpServerOptions): Server {
  const { engine, settings, assetCode } = options;
  const log = options.log ?? (() => undefined);
  const now = options.now ?? Date.now;
  const limiters = publicLimiters(settings.limits, now);
  const allowed = new Set(settings.allowedOrigins);
  const { notes, instructions } = publicNotes(settings.limits, assetCode, options.recipients ?? []);

  async function mcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Browsers send Origin; server to server clients do not, and are let in.
    const origin = req.headers.origin;
    if (origin !== undefined && !allowed.has(origin.replace(/\/+$/, '').toLowerCase())) {
      rpcError(res, 403, -32000, 'This origin may not call this server');
      return;
    }
    if (req.method !== 'POST') {
      // Stateless: no stream to open with GET and no session to end with DELETE.
      rpcError(res, 405, -32000, 'Method not allowed; POST JSON-RPC to /mcp', { allow: 'POST' });
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

    const client = rateKey(clientAddress(req.headers, req.socket.remoteAddress, settings.clientIp));
    const server = createMcpServer(engine, {
      guard: publicGuard({ limits: settings.limits, limiters, client, assetCode }),
      notes,
      instructions,
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

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = (req.url ?? '/').split('?')[0];
    if (path === '/healthz') {
      if (req.method === 'GET' || req.method === 'HEAD') send(res, 200, { status: 'ok' });
      else send(res, 405, { error: 'method not allowed' }, { allow: 'GET' });
      return;
    }
    if (path === '/mcp') {
      await mcp(req, res);
      return;
    }
    send(res, 404, { error: 'not found' });
  }

  const server = createServer((req, res) => {
    const started = now();
    const path = (req.url ?? '/').split('?')[0] ?? '/';
    const known = path === '/mcp' || path === '/healthz' ? path : 'other';
    // A payout waits for the ledger, so the limit is generous, but nothing waits forever.
    const deadline = setTimeout(() => {
      rpcError(res, 504, -32000, 'The request took too long');
    }, settings.requestTimeoutMs);
    res.on('close', () => {
      clearTimeout(deadline);
      log(`${req.method ?? '?'} ${known} ${res.statusCode} ${now() - started}ms`);
    });
    route(req, res).catch((error: unknown) => {
      log(`request failed (${error instanceof Error ? error.name : 'NonError'})`);
      rpcError(res, 500, -32603, 'Internal error');
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
