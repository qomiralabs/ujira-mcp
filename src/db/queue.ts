// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The job queue, on Graphile Worker. This is the only file that imports the
// library: it talks to Postgres with a pool of its own, so it lives with the
// driver, and nothing outside src/db learns which queue runs the jobs. Jobs
// are added only through jobs.enqueuePayout, inside the transaction that
// writes the payout; this file runs them.
//
// Settings the queue must run with, from the monorepo's Graphile Worker spike:
//
// - The worker login over a session connection, never the transaction
//   pooler, which drops LISTEN without an error and leaves the pool polling.
// - Completions and failures written before stop resolves. Left to the
//   defaults, a job that finished during a stop could stay locked for hours.
// - No signal handlers of its own: src/server/run.ts owns SIGTERM and stops
//   the roles in order, inside one budget.
// - No crontab file read from the working directory: the schedule, when there
//   is one, is passed in code.

import { Logger, run, runMigrations, type JobHelpers, type TaskList } from 'graphile-worker';
import pg from 'pg';

import type { DatabaseConfig, QueueInstallConfig } from './config.js';
import { toUnavailable } from './unavailable.js';

/** Graphile's default schema, which the job queue migration creates. */
export const QUEUE_SCHEMA = 'graphile_worker';

/** One run of one job, with nothing of the library's in it. */
export interface QueuedJob {
  readonly id: string;
  readonly task: string;
  /** As stored: a task parses it before trusting any field. */
  readonly payload: unknown;
  /** Counts this run, so the first run is 1 and the last is `maxAttempts`. */
  readonly attempt: number;
  readonly maxAttempts: number;
  /** Aborts when the runner is stopping; a task must give up promptly. */
  readonly signal: AbortSignal;
}

/** Resolves when the job is done; a throw fails this attempt and the queue retries it. */
export type JobHandler = (job: QueuedJob) => Promise<void>;

export interface JobRunnerOptions {
  readonly tasks: Readonly<Record<string, JobHandler>>;
  /** Jobs at once across every queue. One queue still runs one job at a time. */
  readonly concurrency: number;
  readonly log: (line: string) => void;
  /** How long a stop waits before it aborts running jobs. */
  readonly abortAfterMs?: number;
  /** How often the runner looks for jobs that became due, as well as listening. */
  readonly pollIntervalMs?: number;
}

export interface JobRunner {
  /** Takes no new jobs, lets running ones finish or aborts them, and records how each ended. */
  readonly stop: () => Promise<void>;
}

/** Inside the role's stop budget, after the web role has had its share. */
export const ABORT_AFTER_MS = 5_000;

/** LISTEN finds new jobs at once; this only catches retries that became due. */
const POLL_INTERVAL_MS = 2_000;

// The library's lines name tasks, job ids and error messages. Payloads are ids
// only, and task errors carry codes, so a line here never holds a secret or a
// person's data. Debug lines are dropped: they are per poll.
function loggerFor(log: (line: string) => void): Logger {
  return new Logger(() => (level, message) => {
    if (level === 'debug') return;
    log(`queue ${level}: ${message}`);
  });
}

function poolFor(config: QueueInstallConfig, size: number, log: (line: string) => void): pg.Pool {
  const pool = new pg.Pool({
    connectionString: config.worker.url.reveal(),
    max: size,
    connectionTimeoutMillis: config.acquireTimeoutMs,
    ...(config.tlsOptions === undefined ? {} : { ssl: config.tlsOptions }),
  });
  // An idle connection the server ended is dropped by the pool and replaced
  // on demand. Without a listener it would throw from the emitter instead.
  pool.on('error', (error: Error) => {
    log(`queue connection lost (${toUnavailable(error)?.reason ?? 'unknown'})`);
  });
  return pool;
}

/**
 * Installs or upgrades the queue's tables, as the worker login. Run by the
 * migration step after the SQL migrations, before any worker starts, so pools
 * of a new version never race each other to upgrade the schema.
 */
export async function installJobQueue(
  config: QueueInstallConfig,
  log: (line: string) => void = () => undefined,
): Promise<void> {
  const pool = poolFor(config, config.worker.poolSize, log);
  try {
    await runMigrations({ pgPool: pool, schema: QUEUE_SCHEMA, logger: loggerFor(log) });
  } catch (error) {
    throw toUnavailable(error) ?? error;
  } finally {
    await pool.end();
  }
}

const CODE = /^[A-Za-z0-9_]{1,64}$/;

/**
 * What the queue keeps of a failed attempt. The library stores the message as
 * the job's last error and logs it, and a message can carry anything a
 * handler or a driver put in it, so only a code goes through.
 */
export class JobAttemptFailed extends Error {
  override readonly name = 'JobAttemptFailed';

  constructor(readonly code: string) {
    super(code);
  }
}

/** Exported for its own tests. */
export function attemptFailure(error: unknown): JobAttemptFailed {
  if (error instanceof JobAttemptFailed) return error;
  if (error instanceof Error) {
    const code: unknown = (error as { code?: unknown }).code;
    if (typeof code === 'string' && CODE.test(code)) return new JobAttemptFailed(code);
    return new JobAttemptFailed(CODE.test(error.name) ? error.name : 'Error');
  }
  return new JobAttemptFailed('unknown');
}

function taskListOf(tasks: JobRunnerOptions['tasks']): TaskList {
  const list: TaskList = {};
  for (const [name, handler] of Object.entries(tasks)) {
    list[name] = async (payload: unknown, helpers: JobHelpers) => {
      try {
        await handler({
          id: helpers.job.id,
          task: helpers.job.task_identifier,
          payload,
          attempt: helpers.job.attempts,
          maxAttempts: helpers.job.max_attempts,
          signal: helpers.abortSignal,
        });
      } catch (error) {
        throw attemptFailure(error);
      }
    };
  }
  return list;
}

/**
 * Starts running jobs for the named tasks. A job whose task is not named here
 * stays in the queue untouched, so a task can ship before its handler without
 * losing a job.
 */
export async function startJobRunner(
  config: DatabaseConfig,
  options: JobRunnerOptions,
): Promise<JobRunner> {
  // The library asks for two connections more than the jobs it runs, one for
  // LISTEN and one to complete and fail jobs while every other is busy.
  const pool = poolFor(config, options.concurrency + 2, options.log);
  let runner: Awaited<ReturnType<typeof run>>;
  try {
    runner = await run({
      pgPool: pool,
      schema: QUEUE_SCHEMA,
      taskList: taskListOf(options.tasks),
      // An empty crontab string would fall back to a crontab file in the
      // working directory; an empty list of items reads nothing.
      parsedCronItems: [],
      concurrency: options.concurrency,
      noHandleSignals: true,
      pollInterval: options.pollIntervalMs ?? POLL_INTERVAL_MS,
      gracefulShutdownAbortTimeout: options.abortAfterMs ?? ABORT_AFTER_MS,
      logger: loggerFor(options.log),
      preset: { worker: { completeJobBatchDelay: 0, failJobBatchDelay: 0 } },
    });
  } catch (error) {
    await pool.end();
    throw toUnavailable(error) ?? error;
  }
  let stopping: Promise<void> | undefined;
  return {
    stop: () => {
      stopping ??= (async () => {
        try {
          await runner.stop();
        } finally {
          await pool.end();
        }
      })();
      return stopping;
    },
  };
}
