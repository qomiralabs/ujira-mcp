#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// Starts the public MCP server over HTTP. Configuration comes only from the
// environment; see the README. Log lines never carry a key, a caller's
// address or a request body.

import { accessSync, constants, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { createEngine, loadSettings } from '../config.js';
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
  const settings = loadSettings();
  const http = loadHttpSettings();
  checkReceiptsWritable(settings.receiptsPath);
  const { engine } = createEngine(settings);
  const server = createHttpServer({
    engine,
    settings: http,
    assetCode: settings.assetCode,
    recipients: [...settings.recipientRefs.keys()],
    log,
  });
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
