// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The web role: the site, the console at /app, its API under /api, the
// public API under /v1, the MCP at /m/<mandate>/mcp, and /healthz, all from
// one HTTP server, with the mandate keep alive. With UJIRA_DEMO_FEATURES on it
// also serves the testnet demo: the public MCP at /mcp, the faucet and the
// recycler. Configuration comes only from the environment; see the README.
// Log lines never carry a key, a caller's address or a request body.
//
// This is a composition root, one of the few files allowed to import
// src/demo, and it builds the demo only when UJIRA_DEMO_FEATURES is on.

import { accessSync, constants, mkdirSync } from 'node:fs';
import type { Server } from 'node:http';
import { dirname } from 'node:path';

import { createV1App } from '../api/app.js';
import { nodeHandler } from '../api/node.js';
import type { Route } from '../api/route.js';
import { authRoutes } from '../api/routes/auth.js';
import { tenancyRoutes } from '../api/routes/tenancy.js';
import { postgresSignInStore } from '../auth/postgres-store.js';
import { loadSignInSettings, type SignInSettings } from '../auth/settings.js';
import { SignIn } from '../auth/sign-in.js';
import type { WalletProofVerifier } from '../auth/wallet-message.js';
import { createEngine, demoFeatures, loadSettings } from '../config.js';
import { consoleFromEnv } from '../console/index.js';
import { createDatabase, DatabaseConfigError, loadDatabaseConfig } from '../db/index.js';
import { createDemo } from '../demo/index.js';
import { EngineError } from '../errors.js';
import { createHttpServer } from '../mcp/http.js';
import { loadHttpSettings } from '../mcp/public.js';
import { postgresTenancyStore } from '../tenancy/postgres-store.js';
import { Tenancy } from '../tenancy/tenancy.js';
import { observabilityFromEnv } from './observability.js';
import type { RoleHandle } from './run.js';

interface SignInWiring {
  readonly routes: Route[];
  readonly close: () => Promise<void>;
}

/**
 * The sign in, principal and project routes and the database behind them,
 * only when UJIRA_SIGN_IN is on. Off, the web role needs no database at all,
 * as before.
 */
function signInWiring(
  settings: SignInSettings,
  env: Env,
  verifier: WalletProofVerifier,
  log: (line: string) => void,
): SignInWiring | undefined {
  if (!settings.enabled) return undefined;
  let config: ReturnType<typeof loadDatabaseConfig>;
  try {
    config = loadDatabaseConfig(env);
  } catch (error) {
    // Its message names the variable that is wrong, never the value, so the
    // entry points may print it as they print any other setting error.
    if (error instanceof DatabaseConfigError) {
      throw new EngineError('config_invalid', error.message, { cause: error });
    }
    throw error;
  }
  const db = createDatabase(config);
  const signIn = new SignIn({
    store: postgresSignInStore(db),
    verifier,
    origin: settings.origin,
    log,
  });
  const tenancy = new Tenancy({ store: postgresTenancyStore(db), log });
  return {
    routes: [
      ...authRoutes({ signIn, origin: settings.origin }),
      ...tenancyRoutes({ signIn, tenancy, origin: settings.origin }),
    ],
    close: () => db.close(),
  };
}

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
  // First, so a demo asked for on another network stops the server before anything else.
  const withDemo = demoFeatures(env);
  const settings = loadSettings(env);
  const http = loadHttpSettings(env);
  const signInSettings = loadSignInSettings(env);
  checkReceiptsWritable(settings.receiptsPath);
  const demo = withDemo ? createDemo({ base: settings, env, log }) : undefined;
  const wiring = createEngine(settings, {
    log,
    ...(demo === undefined ? {} : { extraRails: (mandate) => demo.rails(mandate) }),
  });
  const observe = observabilityFromEnv({ env, settings, wiring, log });
  const { routes, keepAlive } = consoleFromEnv({
    base: settings,
    wiring,
    http,
    log,
    env,
    ...(demo === undefined ? {} : { extend: (parts) => demo.console(parts) }),
  });
  const signIn = signInWiring(signInSettings, env, wiring.adapter, log);
  const server = createHttpServer({
    settings: http,
    log,
    extra: routes,
    v1: nodeHandler(createV1App({ log, routes: signIn?.routes ?? [] }).app),
    deepHealth: observe.deepHealth,
    ...(demo === undefined ? {} : { publicMcp: demo.publicMcp(wiring.engine, http) }),
  });
  const stopTimers = async () => {
    demo?.stop();
    keepAlive?.stop();
    await observe.stop();
  };
  log(demo === undefined ? 'demo off' : demo.summary());
  log(`sign in: ${signIn === undefined ? 'off' : 'on'}`);
  demo?.start();
  log(`keep alive: ${keepAlive === undefined ? 'off' : 'on'}`);
  keepAlive?.start();
  observe.start();
  try {
    await listen(server, http.port, http.host);
  } catch (error) {
    await stopTimers();
    await signIn?.close();
    throw error;
  }
  log(
    `ready on testnet at ${http.host}:${http.port}, mandate ${settings.mandateId}, agent ${settings.agent.publicKey}`,
  );
  return {
    role: 'web',
    async stop() {
      const closed = closeServer(server, graceMs);
      const timers = stopTimers();
      await closed;
      await timers;
      // After the server, so a request still in its grace can finish its query.
      await signIn?.close();
    },
  };
}
