#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The image's entry point. Runs the roles named in UJIRA_ROLES (web, worker
// or web,worker; unset means both) and stops them on SIGTERM. Every line is
// one JSON object on stdout through the redacting sink in src/log.ts, with
// `service` naming the part that wrote it: ujira-server, ujira-mcp-http (the
// web role, the name the HTTP server has always logged as) or ujira-worker.
// A failure to start is one plain line on stderr.
//
// Before any role starts, the pending database migrations run, when
// UJIRA_DB_MIGRATOR_URL is set (src/db/migrate-start.ts). A failed run exits 1
// before the web role listens, so a deploy with a bad migration never passes
// its health check and the previous release keeps serving.

import { DatabaseConfigError, migrateBeforeStart, MigrationStartError } from '../db/index.js';
import { EngineError } from '../errors.js';
import { jsonLog } from '../log.js';
import { startWorker } from '../worker/index.js';
import { parseRoles } from './roles.js';
import { runServer, type RoleHandle } from './run.js';
import { ListenError, startWeb } from './web.js';
import { payoutTasksFromEnv } from './worker-tasks.js';

const prefixed = (service: string) =>
  jsonLog({ service, write: (json) => process.stdout.write(`${json}\n`) });
const log = prefixed('ujira-server');

function failed(error: unknown): never {
  // These messages name a setting or a code, never a value or a URL.
  const message =
    error instanceof EngineError ||
    error instanceof ListenError ||
    error instanceof DatabaseConfigError ||
    error instanceof MigrationStartError
      ? error.message
      : 'failed to start';
  process.stderr.write(`ujira-server: ${message}\n`);
  process.exit(1);
}

try {
  const roles = parseRoles(process.env['UJIRA_ROLES']);
  await migrateBeforeStart(process.env, { log });
  const workerLog = prefixed('ujira-worker');
  await runServer({
    roles,
    factories: {
      web: () => startWeb(process.env, prefixed('ujira-mcp-http')),
      worker: async (): Promise<RoleHandle> => ({
        role: 'worker',
        ...(await startWorker(process.env, workerLog, {
          tasksFor: () => payoutTasksFromEnv(process.env, workerLog),
        })),
      }),
    },
    proc: process,
    log,
  });
} catch (error) {
  failed(error);
}
