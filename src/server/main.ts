#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The image's entry point. Runs the roles named in UJIRA_ROLES (web, worker
// or web,worker; unset means both) and stops them on SIGTERM. Every line is
// one JSON object on stdout through the redacting sink in src/log.ts, with
// `service` naming the part that wrote it: ujira-server, ujira-mcp-http (the
// web role, the name the HTTP server has always logged as) or ujira-worker.
// A failure to start is one plain line on stderr, before any logging runs.

import { EngineError } from '../errors.js';
import { jsonLog } from '../log.js';
import { startWorker } from '../worker/index.js';
import { parseRoles } from './roles.js';
import { runServer, type RoleHandle } from './run.js';
import { ListenError, startWeb } from './web.js';

const prefixed = (service: string) =>
  jsonLog({ service, write: (json) => process.stdout.write(`${json}\n`) });
const log = prefixed('ujira-server');

function failed(error: unknown): never {
  const message =
    error instanceof EngineError || error instanceof ListenError
      ? error.message
      : 'failed to start';
  process.stderr.write(`ujira-server: ${message}\n`);
  process.exit(1);
}

try {
  const roles = parseRoles(process.env['UJIRA_ROLES']);
  const workerLog = prefixed('ujira-worker');
  await runServer({
    roles,
    factories: {
      web: () => startWeb(process.env, prefixed('ujira-mcp-http')),
      worker: () => Promise.resolve<RoleHandle>({ role: 'worker', ...startWorker(workerLog) }),
    },
    proc: process,
    log,
  });
} catch (error) {
  failed(error);
}
