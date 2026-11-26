// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The web role: the site, the console at /app, its API under /api, the
// public MCP at /mcp and /m/<mandate>/mcp, and /healthz, all from one HTTP
// server. Configuration comes only from the environment; see the README.
// Log lines never carry a key, a caller's address or a request body.

import { accessSync, constants, mkdirSync } from 'node:fs';
import type { Server } from 'node:http';
import { dirname } from 'node:path';

import { createV1App } from '../api/app.js';
import { nodeHandler } from '../api/node.js';
import { createEngine, loadSettings } from '../config.js';
import { consoleFromEnv } from '../console/index.js';
import { EngineError } from '../errors.js';
import { createHttpServer } from '../mcp/http.js';
import { loadHttpSettings } from '../mcp/public.js';
import type { RoleHandle } from './run.js';

type Env = Readonly<Record<string, string | undefined>>;

/**
 * How long requests already in flight may run once the server stops
 * listening. A payout waits for the ledger, so this is generous, and it
 * leaves the worker the rest of the stop budget.
 */
export const WEB_GRACE_MS = 10_000;

/** How often connections that went idle during the grace are closed. */
const IDLE_SWEEP_MS = 100;

/** The server could not bind its port; `code` is the system's, such as EADDRINUSE. */
export class ListenError extends Error {
  readonly code: string;

  constructor(code: string, options?: { cause?: unknown }) {
    super(`cannot listen (${code})`, options);
    this.name = 'ListenError';
    this.code = code;
  }
}

/**
 * A receipt is written after the money moves, so a log it cannot write to
 * must stop the server at start, not after a payout.
 */
function checkReceiptsWritable(path: string): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    accessSync(dirname(path), constants.W_OK);
  } catch (error) {
    throw new EngineError(
      'config_invalid',
      'the directory of UJIRA_RECEIPTS_FILE is not writable',
      {
        cause: error,
      },
    );
  }
}

/**
 * Stops taking connections at once, lets requests in flight finish for up to
 * `graceMs`, then closes whatever is left. Keep alive connections that go
 * idle in the meantime are closed as they do, so a stop never waits out the
 * keep alive timeout.
 */
export function closeServer(server: Server, graceMs: number): Promise<void> {
  return new Promise((resolve) => {
    const sweep = setInterval(() => {
      server.closeIdleConnections();
    }, IDLE_SWEEP_MS);
    const force = setTimeout(() => {
      server.closeAllConnections();
    }, graceMs);
    server.close(() => {
      clearInterval(sweep);
      clearTimeout(force);
      resolve();
    });
    server.closeIdleConnections();
  });
}

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const failed = (error: NodeJS.ErrnoException) => {
      reject(new ListenError(error.code ?? error.name, { cause: error }));
    };
    server.once('error', failed);
    server.listen(port, host, () => {
      server.off('error', failed);
      resolve();
    });
  });
}

/** Builds everything the web role serves from `env`, listens, and resolves once it does. */
export async function startWeb(
  env: Env,
  log: (line: string) => void,
  graceMs: number = WEB_GRACE_MS,
): Promise<RoleHandle> {
  const settings = loadSettings(env);
  const http = loadHttpSettings(env);
  checkReceiptsWritable(settings.receiptsPath);
  const wiring = createEngine(settings);
  const {
    routes,
    settings: consoleSettings,
    recycler,
  } = consoleFromEnv(settings, wiring, http, log, env);
  const server = createHttpServer({
    engine: wiring.engine,
    settings: http,
    assetCode: settings.assetCode,
    recipients: [...settings.recipientRefs.keys()],
    log,
    extra: routes,
    v1: nodeHandler(createV1App({ log }).app),
  });
  log(
    `console: faucet ${consoleSettings.treasury === undefined ? 'off' : 'on'}, sdp ${settings.sdp === undefined ? 'off' : 'on'}, recycler ${recycler === undefined ? 'off' : `every ${String(consoleSettings.recycleIntervalSeconds)}s`}`,
  );
  recycler?.start(consoleSettings.recycleIntervalSeconds * 1000);
  try {
    await listen(server, http.port, http.host);
  } catch (error) {
    recycler?.stop();
    throw error;
  }
  log(
    `ready on testnet at ${http.host}:${http.port}, mandate ${settings.mandateId}, agent ${settings.agent.publicKey}`,
  );
  return {
    role: 'web',
    async stop() {
      const closed = closeServer(server, graceMs);
      recycler?.stop();
      await closed;
    },
  };
}
