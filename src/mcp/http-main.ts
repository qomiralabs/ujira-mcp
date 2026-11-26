#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The `ujira-mcp-http` command: the web role on its own, whatever
// UJIRA_ROLES says. The image runs src/server/main.ts, which picks the roles.
// Configuration comes only from the environment; see the README. Log lines
// never carry a key, a caller's address or a request body.

import { EngineError } from '../errors.js';
import { runServer } from '../server/run.js';
import { ListenError, startWeb } from '../server/web.js';

const log = (line: string) => {
  process.stdout.write(`ujira-mcp-http: ${line}\n`);
};

try {
  await runServer({
    roles: ['web'],
    factories: { web: () => startWeb(process.env, log) },
    proc: process,
    log,
  });
} catch (error) {
  const message =
    error instanceof EngineError || error instanceof ListenError
      ? error.message
      : 'failed to start';
  process.stderr.write(`ujira-mcp-http: ${message}\n`);
  process.exit(1);
}
