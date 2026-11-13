#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// Starts the MCP server on stdio. Configuration comes only from the
// environment; see the README. Startup failures go to stderr, never stdout,
// which belongs to the protocol.

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { createEngine, loadSettings } from '../config.js';
import { EngineError } from '../errors.js';
import { createMcpServer } from './server.js';

async function main(): Promise<void> {
  const settings = loadSettings();
  const { engine } = createEngine(settings);
  const server = createMcpServer(engine, {
    onInternalError: (name) => {
      process.stderr.write(`ujira-mcp: internal error (${name})\n`);
    },
  });
  await server.connect(new StdioServerTransport());
  process.stderr.write(
    `ujira-mcp: ready on testnet, mandate ${settings.mandateId}, agent ${settings.agent.publicKey}\n`,
  );
}

main().catch((error: unknown) => {
  const message = error instanceof EngineError ? error.message : 'failed to start';
  process.stderr.write(`ujira-mcp: ${message}\n`);
  process.exit(1);
});
