// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// Starts the chosen roles and stops them on SIGTERM or SIGINT. Kept free of
// the roles themselves, so the order and the time limits are tested with
// stand ins and the process entry points stay a few lines long.

import type { Role } from './roles.js';

/** A running role. `stop` finishes or hands back what is in flight and resolves when done. */
export interface RoleHandle {
  readonly role: Role;
  stop(): Promise<void>;
}

export type RoleFactory = () => Promise<RoleHandle>;
export type RoleFactories = { readonly [R in Role]?: RoleFactory };

/** The whole stop, every role together. Hosts send SIGKILL some time after SIGTERM. */
export const STOP_BUDGET_MS = 20_000;

/**
 * Web first: once it stops listening, the load balancer sends new requests
 * elsewhere, and only then does the worker give its jobs back.
 */
export const STOP_ORDER: readonly Role[] = ['web', 'worker'];

/** Starting runs the other way, so the web role takes traffic only once the rest is up. */
const START_ORDER: readonly Role[] = [...STOP_ORDER].reverse();

export interface ServerProcess {
  once(signal: 'SIGTERM' | 'SIGINT', listener: () => void): unknown;
  exit(code: number): void;
}

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const realTimers: Timers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

export interface StopOptions {
  readonly log: (line: string) => void;
  readonly budgetMs?: number;
  readonly now?: () => number;
  readonly timers?: Timers;
}

const TIMED_OUT = Symbol('timed out');

function within<T>(work: Promise<T>, ms: number, timers: Timers): Promise<T | typeof TIMED_OUT> {
  let handle: unknown;
  const late = new Promise<typeof TIMED_OUT>((resolve) => {
    handle = timers.setTimeout(() => {
      resolve(TIMED_OUT);
    }, ms);
  });
  return Promise.race([work, late]).finally(() => {
    timers.clearTimeout(handle);
  });
}

function codeOf(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' ? code : error.name;
  }
  return 'unknown';
}

/**
 * Stops every handle in `STOP_ORDER`, one after the other, inside one shared
 * budget. A role that throws or runs past the budget is reported and the
 * next one is still stopped. Resolves true only when every role stopped
 * cleanly in time.
 */
export async function stopRoles(
  handles: readonly RoleHandle[],
  options: StopOptions,
): Promise<boolean> {
  const now = options.now ?? Date.now;
  const timers = options.timers ?? realTimers;
  const deadline = now() + (options.budgetMs ?? STOP_BUDGET_MS);
  const ordered = [...handles].sort(
    (a, b) => STOP_ORDER.indexOf(a.role) - STOP_ORDER.indexOf(b.role),
  );
  let clean = true;
  for (const handle of ordered) {
    const left = Math.max(0, deadline - now());
    try {
      const result = await within(handle.stop(), left, timers);
      if (result === TIMED_OUT) {
        clean = false;
        options.log(`${handle.role} did not stop in time`);
      } else {
        options.log(`${handle.role} stopped`);
      }
    } catch (error) {
      clean = false;
      options.log(`${handle.role} failed to stop (${codeOf(error)})`);
    }
  }
  return clean;
}

export interface RunOptions extends StopOptions {
  readonly roles: readonly Role[];
  readonly factories: RoleFactories;
  readonly proc: ServerProcess;
}

/**
 * Starts the roles and arms the signal handlers. When a role fails to start,
 * the ones already running are stopped and the error is thrown, so the
 * caller reports it and exits non zero. After a signal the process exits 0
 * when every role stopped cleanly, else 1.
 */
export async function runServer(options: RunOptions): Promise<readonly RoleHandle[]> {
  const { roles, factories, proc, log } = options;
  const missing = roles.find((role) => factories[role] === undefined);
  if (missing !== undefined) throw new Error(`no ${missing} role in this entry point`);

  const handles: RoleHandle[] = [];
  for (const role of START_ORDER) {
    const factory = factories[role];
    if (!roles.includes(role) || factory === undefined) continue;
    try {
      handles.push(await factory());
    } catch (error) {
      await stopRoles(handles, options);
      throw error;
    }
  }

  let stopping = false;
  const stop = (signal: string) => () => {
    if (stopping) return;
    stopping = true;
    log(`${signal}: stopping ${roles.join(',')}`);
    void stopRoles(handles, options).then((clean) => {
      proc.exit(clean ? 0 : 1);
    });
  };
  proc.once('SIGTERM', stop('SIGTERM'));
  proc.once('SIGINT', stop('SIGINT'));
  log(`running ${roles.join(',')}`);
  return handles;
}
