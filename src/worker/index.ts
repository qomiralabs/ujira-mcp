// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The worker role: runs queued payout jobs on the job queue in src/db. It never
// listens on a port.
//
// Without UJIRA_DB_WORKER_URL the queue is off and the role only keeps the
// process alive, as it did before the queue existed, so the image deploys
// ahead of its database. With it, every database setting must be valid or the
// role refuses to start. A database that is down at start does not stop the
// process: the web role in the same process keeps serving, and the queue tries
// again until it connects or the role is stopped.

import {
  createDatabase,
  DatabaseUnavailableError,
  loadDatabaseConfig,
  startJobRunner,
  type Database,
  type DatabaseConfig,
  type JobRunner,
  type JobRunnerOptions,
} from '../db/index.js';
import { errorCode, payoutJobHandler, type PayoutTaskDefinition } from './payout-jobs.js';
import { loadWorkerSettings } from './settings.js';

export {
  errorCode,
  JobTargetMissingError,
  payoutJobHandler,
  payoutJobPayload,
  type PayoutJob,
  type PayoutJobPayload,
  type PayoutTaskDefinition,
  type WorkerTransaction,
} from './payout-jobs.js';
export { DEFAULT_CONCURRENCY, loadWorkerSettings, type WorkerSettings } from './settings.js';

type Env = Readonly<Record<string, string | undefined>>;

export interface Worker {
  /** Takes no new jobs, hands back the ones in flight, and resolves when done. */
  stop(): Promise<void>;
}

/** Long, since the timer only keeps the event loop alive; it does no work. */
const KEEP_ALIVE_MS = 60 * 60 * 1000;

/** How long a queue that could not reach the database waits before it tries again. */
export const RETRY_START_MS = 10_000;

export interface WorkerDependencies {
  /** The tasks this process runs. A job of any other task waits in the queue. */
  readonly tasks?: readonly PayoutTaskDefinition[];
  /**
   * Builds the tasks over the worker's database, only once the queue is on,
   * so a deployment without a database needs none of their keys. A throw
   * refuses the role, with the database closed again.
   */
  readonly tasksFor?: (db: Database) => readonly PayoutTaskDefinition[];
  readonly openDatabase?: (config: DatabaseConfig) => Database;
  readonly startRunner?: (config: DatabaseConfig, options: JobRunnerOptions) => Promise<JobRunner>;
  readonly retryMs?: number;
}

function keepAlive(): Worker {
  const alive = setInterval(() => undefined, KEEP_ALIVE_MS);
  let stopped = false;
  return {
    stop() {
      if (!stopped) {
        stopped = true;
        clearInterval(alive);
      }
      return Promise.resolve();
    },
  };
}

export async function startWorker(
  env: Env,
  log: (line: string) => void,
  dependencies: WorkerDependencies = {},
): Promise<Worker> {
  const settings = loadWorkerSettings(env);
  if (!settings.queue) {
    log('ready, queue off: UJIRA_DB_WORKER_URL is not set');
    return keepAlive();
  }
  const config = loadDatabaseConfig(env);
  const start = dependencies.startRunner ?? startJobRunner;
  const retryMs = dependencies.retryMs ?? RETRY_START_MS;
  const db = (dependencies.openDatabase ?? createDatabase)(config);
  let tasks: readonly PayoutTaskDefinition[];
  try {
    tasks = dependencies.tasks ?? dependencies.tasksFor?.(db) ?? [];
  } catch (error) {
    await db.close();
    throw error;
  }
  const handlers = Object.fromEntries(
    tasks.map((definition) => [definition.task, payoutJobHandler(db, definition, log)]),
  );
  const options: JobRunnerOptions = { tasks: handlers, concurrency: settings.concurrency, log };
  const named = tasks.map((definition) => definition.task).join(',') || 'none';

  let runner: JobRunner | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  // The role keeps the process alive whatever the queue is doing, so a worker
  // alone never exits early while it waits for the database.
  const alive = keepAlive();

  const ready = (started: JobRunner): void => {
    runner = started;
    log(`ready, tasks ${named}, concurrency ${String(settings.concurrency)}`);
  };
  const later = (error: unknown): void => {
    log(`queue waiting for the database (${errorCode(error)}), next try in ${String(retryMs)} ms`);
    retry = setTimeout(() => {
      retry = undefined;
      void attempt();
    }, retryMs);
  };
  // Read through a call, since a stop can land while a start is awaited.
  const isStopped = (): boolean => stopped;
  const attempt = async (): Promise<void> => {
    if (isStopped()) return;
    try {
      const started = await start(config, options);
      if (isStopped()) {
        await started.stop();
        return;
      }
      ready(started);
    } catch (error) {
      if (!isStopped()) later(error);
    }
  };

  try {
    ready(await start(config, options));
  } catch (error) {
    // Anything but an outage is a fault in this deployment, which a retry
    // would only repeat, so the role refuses to start and says why.
    if (!(error instanceof DatabaseUnavailableError)) {
      await alive.stop();
      await db.close();
      throw error;
    }
    later(error);
  }

  let stopping: Promise<void> | undefined;
  return {
    stop() {
      stopping ??= (async () => {
        stopped = true;
        if (retry !== undefined) clearTimeout(retry);
        try {
          await runner?.stop();
        } finally {
          await alive.stop();
          await db.close();
        }
      })();
      return stopping;
    },
  };
}
