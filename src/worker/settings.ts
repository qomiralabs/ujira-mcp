// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The worker role's own settings. The database settings are read by src/db;
// this decides whether the queue runs at all, and how many jobs run at once.

import { z } from 'zod';

import { EngineError } from '../errors.js';

type Env = Readonly<Record<string, string | undefined>>;

export interface WorkerSettings {
  /**
   * Off until the deployment has a database. The role then starts and stops
   * as before and runs nothing, so an image that ships the queue can deploy
   * ahead of the database it needs.
   */
  readonly queue: boolean;
  /** Jobs at once across every queue; one queue still runs one job at a time. */
  readonly concurrency: number;
}

export const DEFAULT_CONCURRENCY = 4;

// Each running job can hold a connection, and the worker's share of the
// database's connections is small, so the ceiling is low on purpose.
const MAX_CONCURRENCY = 16;

const schema = z.object({
  UJIRA_DB_WORKER_URL: z.string().optional(),
  UJIRA_WORKER_CONCURRENCY: z
    .string()
    .regex(/^[1-9][0-9]?$/)
    .transform((value) => Number.parseInt(value, 10))
    .pipe(z.int().min(1).max(MAX_CONCURRENCY))
    .optional(),
});

export function loadWorkerSettings(env: Env): WorkerSettings {
  const parsed = schema.safeParse({
    UJIRA_DB_WORKER_URL: env['UJIRA_DB_WORKER_URL'],
    UJIRA_WORKER_CONCURRENCY: env['UJIRA_WORKER_CONCURRENCY'],
  });
  if (!parsed.success) {
    // Names the variable only: a value here could be anything pasted.
    throw new EngineError(
      'config_invalid',
      `UJIRA_WORKER_CONCURRENCY must be a whole number from 1 to ${String(MAX_CONCURRENCY)}`,
    );
  }
  const url = parsed.data.UJIRA_DB_WORKER_URL;
  return {
    queue: url !== undefined && url.trim() !== '',
    concurrency: parsed.data.UJIRA_WORKER_CONCURRENCY ?? DEFAULT_CONCURRENCY,
  };
}
