// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The worker role around the queue, with the queue and the database stood in
// for. The real queue runs in src/worker/queue.db.test.ts.

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  DatabaseConfigError,
  DatabaseUnavailableError,
  type Database,
  type JobRunner,
  type JobRunnerOptions,
} from '../src/db/index.js';
import { EngineError } from '../src/errors.js';
import { RETRY_START_MS, startWorker, type PayoutTaskDefinition } from '../src/worker/index.js';

const LOCAL = 'postgresql://login:local-only@127.0.0.1:54329/ujira';

const DB_ENV = {
  UJIRA_DB_APP_URL: LOCAL,
  UJIRA_DB_WORKER_URL: LOCAL,
  UJIRA_DB_MIGRATOR_URL: LOCAL,
  UJIRA_DB_TLS: 'off',
};

function fakeDatabase(): Database & { readonly closed: () => number } {
  let closes = 0;
  const refuse = () => Promise.reject(new Error('not used here'));
  return {
    withTenant: refuse,
    tenant: () => ({ transaction: refuse }),
    principal: () => ({ transaction: refuse }),
    unscoped: refuse,
    close: () => {
      closes += 1;
      return Promise.resolve();
    },
    closed: () => closes,
  };
}

function fakeRunner(): JobRunner & { readonly stops: () => number } {
  let stops = 0;
  return {
    stop: () => {
      stops += 1;
      return Promise.resolve();
    },
    stops: () => stops,
  };
}

const advance: PayoutTaskDefinition = {
  task: 'payout.advance',
  run: () => Promise.resolve(),
  deadLetter: () => Promise.resolve('needs_attention'),
};

afterEach(() => {
  vi.useRealTimers();
});

describe('startWorker with the queue off', () => {
  it('keeps the process alive until it is stopped, and stops more than once safely', async () => {
    vi.useFakeTimers();
    const lines: string[] = [];
    const worker = await startWorker({}, (line) => lines.push(line));
    expect(lines).toEqual(['ready, queue off: UJIRA_DB_WORKER_URL is not set']);
    expect(vi.getTimerCount()).toBe(1);

    await worker.stop();
    expect(vi.getTimerCount()).toBe(0);
    await expect(worker.stop()).resolves.toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('treats a blank URL as unset', async () => {
    const lines: string[] = [];
    const worker = await startWorker({ UJIRA_DB_WORKER_URL: '  ' }, (line) => lines.push(line));
    expect(lines).toEqual(['ready, queue off: UJIRA_DB_WORKER_URL is not set']);
    await worker.stop();
  });

  it('still refuses a concurrency that is not a small whole number', async () => {
    for (const value of ['0', '17', '4.5', 'four', '-1', ' 4']) {
      await expect(
        startWorker({ UJIRA_WORKER_CONCURRENCY: value }, () => undefined),
      ).rejects.toThrow(EngineError);
    }
  });
});

describe('startWorker with the queue on', () => {
  it('refuses to start when the rest of the database settings are missing', async () => {
    const db = fakeDatabase();
    await expect(
      startWorker({ UJIRA_DB_WORKER_URL: LOCAL }, () => undefined, { openDatabase: () => db }),
    ).rejects.toThrow(DatabaseConfigError);
    expect(db.closed()).toBe(0);
  });

  it('starts the runner with one handler per task and the concurrency asked for', async () => {
    const db = fakeDatabase();
    const runner = fakeRunner();
    const seen: JobRunnerOptions[] = [];
    const lines: string[] = [];
    const worker = await startWorker(
      { ...DB_ENV, UJIRA_WORKER_CONCURRENCY: '3' },
      (line) => lines.push(line),
      {
        tasks: [advance],
        openDatabase: () => db,
        startRunner: (_config, options) => {
          seen.push(options);
          return Promise.resolve(runner);
        },
      },
    );
    expect(seen).toHaveLength(1);
    expect(Object.keys(seen[0]?.tasks ?? {})).toEqual(['payout.advance']);
    expect(seen[0]?.concurrency).toBe(3);
    expect(lines).toEqual(['ready, tasks payout.advance, concurrency 3']);

    await worker.stop();
    await worker.stop();
    expect(runner.stops()).toBe(1);
    expect(db.closed()).toBe(1);
  });

  it('runs with no tasks, leaving every job in the queue, at the default concurrency', async () => {
    const lines: string[] = [];
    const worker = await startWorker(DB_ENV, (line) => lines.push(line), {
      openDatabase: fakeDatabase,
      startRunner: () => Promise.resolve(fakeRunner()),
    });
    expect(lines).toEqual(['ready, tasks none, concurrency 4']);
    await worker.stop();
  });

  it('refuses to start, and closes the database, on a fault a retry would repeat', async () => {
    const db = fakeDatabase();
    const fault = Object.assign(new Error('permission denied for schema graphile_worker'), {
      code: '42501',
    });
    await expect(
      startWorker(DB_ENV, () => undefined, {
        openDatabase: () => db,
        startRunner: () => Promise.reject(fault),
      }),
    ).rejects.toBe(fault);
    expect(db.closed()).toBe(1);
  });

  it('waits for a database that is down, without stopping the process, and starts once it is up', async () => {
    vi.useFakeTimers();
    const runner = fakeRunner();
    const results: (() => Promise<JobRunner>)[] = [
      () => Promise.reject(new DatabaseUnavailableError('ECONNREFUSED')),
      () => Promise.reject(new Error('still starting')),
      () => Promise.resolve(runner),
    ];
    const lines: string[] = [];
    const worker = await startWorker(DB_ENV, (line) => lines.push(line), {
      openDatabase: fakeDatabase,
      startRunner: () => (results.shift() ?? (() => Promise.reject(new Error('extra'))))(),
    });
    expect(lines).toEqual([
      `queue waiting for the database (DatabaseUnavailableError), next try in ${String(RETRY_START_MS)} ms`,
    ]);
    await vi.advanceTimersByTimeAsync(RETRY_START_MS);
    expect(lines.at(-1)).toBe(
      `queue waiting for the database (Error), next try in ${String(RETRY_START_MS)} ms`,
    );
    await vi.advanceTimersByTimeAsync(RETRY_START_MS);
    expect(lines.at(-1)).toBe('ready, tasks none, concurrency 4');
    await worker.stop();
    expect(runner.stops()).toBe(1);
  });

  it('stops while waiting, and tries no more', async () => {
    vi.useFakeTimers();
    const db = fakeDatabase();
    let tries = 0;
    const worker = await startWorker(DB_ENV, () => undefined, {
      openDatabase: () => db,
      retryMs: 50,
      startRunner: () => {
        tries += 1;
        return Promise.reject(new DatabaseUnavailableError('57P03'));
      },
    });
    await worker.stop();
    await vi.advanceTimersByTimeAsync(500);
    expect(tries).toBe(1);
    expect(db.closed()).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stops a runner that finished starting after the stop', async () => {
    vi.useFakeTimers();
    const late = fakeRunner();
    let finish: (runner: JobRunner) => void = () => undefined;
    let tries = 0;
    const worker = await startWorker(DB_ENV, () => undefined, {
      openDatabase: fakeDatabase,
      retryMs: 50,
      startRunner: () => {
        tries += 1;
        if (tries === 1) return Promise.reject(new DatabaseUnavailableError('57P03'));
        return new Promise((resolve) => {
          finish = resolve;
        });
      },
    });
    await vi.advanceTimersByTimeAsync(50);
    expect(tries).toBe(2);
    const stopped = worker.stop();
    finish(late);
    await stopped;
    await vi.advanceTimersByTimeAsync(0);
    expect(late.stops()).toBe(1);
  });
});
