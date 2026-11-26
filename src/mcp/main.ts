#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// Starts the MCP server on stdio. Configuration comes only from the
// environment; see the README. Startup failures go to stderr, never stdout,
// which belongs to the protocol.
//
// A composition root: with UJIRA_DEMO_FEATURES on it adds the demo's SDP
// rail, as the HTTP server does.

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { createEngine, demoFeatures, loadSettings } from '../config.js';
import { createDemo } from '../demo/index.js';
import { EngineError } from '../errors.js';
import { createMcpServer } from './server.js';

async function main(): Promise<void> {
  const withDemo = demoFeatures();
  const settings = loadSettings();
  const demo = withDemo
    ? createDemo({
        base: settings,
        log: (line) => process.stderr.write(`ujira-mcp: ${line}\n`),
      })
    : undefined;
  const { engine } = createEngine(
    settings,
    demo === undefined ? {} : { extraRails: (mandate) => demo.rails(mandate) },
  );
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
