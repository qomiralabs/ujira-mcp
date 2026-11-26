#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// Starts the public MCP server over HTTP. Configuration comes only from the
// environment; see the README. Log lines never carry a key, a caller's
// address or a request body.
//
// This is a composition root, one of the few files allowed to import
// src/demo, and it builds the demo only when UJIRA_DEMO_FEATURES is on.

import { accessSync, constants, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { createV1App } from '../api/app.js';
import { nodeHandler } from '../api/node.js';
import { createEngine, demoFeatures, loadSettings } from '../config.js';
import { consoleFromEnv } from '../console/index.js';
import { createDemo } from '../demo/index.js';
import { EngineError } from '../errors.js';
import { createHttpServer } from './http.js';
import { loadHttpSettings } from './public.js';

const log = (line: string) => {
  process.stdout.write(`ujira-mcp-http: ${line}\n`);
};

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

function main(): void {
  // First, so a demo asked for on another network stops the server before anything else.
  const withDemo = demoFeatures();
  const settings = loadSettings();
  const http = loadHttpSettings();
  checkReceiptsWritable(settings.receiptsPath);
  const demo = withDemo ? createDemo({ base: settings, log }) : undefined;
  const wiring = createEngine(
    settings,
    demo === undefined ? {} : { extraRails: (mandate) => demo.rails(mandate) },
  );
  const { routes, keepAlive } = consoleFromEnv({
    base: settings,
    wiring,
    http,
    log,
    ...(demo === undefined ? {} : { extend: (parts) => demo.console(parts) }),
  });
  const server = createHttpServer({
    settings: http,
    log,
    extra: routes,
    v1: nodeHandler(createV1App({ log }).app),
    ...(demo === undefined ? {} : { publicMcp: demo.publicMcp(wiring.engine, http) }),
  });
  log(demo === undefined ? 'demo off' : demo.summary());
  demo?.start();
  log(`keep alive: ${keepAlive === undefined ? 'off' : 'on'}`);
  keepAlive?.start();
  server.on('error', (error: NodeJS.ErrnoException) => {
    process.stderr.write(`ujira-mcp-http: cannot listen (${error.code ?? error.name})\n`);
    process.exit(1);
  });
  server.listen(http.port, http.host, () => {
    log(
      `ready on testnet at ${http.host}:${http.port}, mandate ${settings.mandateId}, agent ${settings.agent.publicKey}`,
    );
  });
  const stop = () => {
    demo?.stop();
    keepAlive?.stop();
    server.close();
    // Let a payout in flight finish, but not forever.
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

try {
  main();
} catch (error) {
  const message = error instanceof EngineError ? error.message : 'failed to start';
  process.stderr.write(`ujira-mcp-http: ${message}\n`);
  process.exit(1);
}
