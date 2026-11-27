// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

import { EventEmitter } from 'node:events';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Role } from '../src/server/roles.js';
import {
  STOP_BUDGET_MS,
  runServer,
  stopRoles,
  type RoleFactory,
  type RoleHandle,
} from '../src/server/run.js';

/** A process stand in: signals are emitted by the test, exits are recorded. */
class FakeProcess extends EventEmitter {
  readonly exits: number[] = [];
  exit(code: number): void {
    this.exits.push(code);
  }
}

interface Stand {
  readonly events: string[];
  readonly factories: { readonly web: RoleFactory; readonly worker: RoleFactory };
}

/** Roles that record when they start and stop. `stop` may be replaced per role. */
function stands(stops: Partial<Record<Role, () => Promise<void>>> = {}): Stand {
  const events: string[] = [];
  const make = (role: Role) => (): Promise<RoleHandle> => {
    events.push(`start ${role}`);
    return Promise.resolve({
      role,
      stop: () => {
        events.push(`stop ${role}`);
        return stops[role]?.() ?? Promise.resolve();
      },
    });
  };
  return { events, factories: { web: make('web'), worker: make('worker') } };
}

const never = () => new Promise<void>(() => undefined);

describe('runServer', () => {
  let proc: FakeProcess;
  let lines: string[];
  const log = (line: string) => {
    lines.push(line);
  };

  beforeEach(() => {
    proc = new FakeProcess();
    lines = [];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts only the chosen roles, so the worker role never builds the web server', async () => {
    const { events, factories } = stands();
    const web = vi.fn(factories.web);
    await runServer({ roles: ['worker'], factories: { ...factories, web }, proc, log });
    expect(web).not.toHaveBeenCalled();
    expect(events).toEqual(['start worker']);
    expect(lines).toContain('running worker');
  });

  it('starts the worker before the web role takes traffic', async () => {
    const { events, factories } = stands();
    await runServer({ roles: ['web', 'worker'], factories, proc, log });
    expect(events).toEqual(['start worker', 'start web']);
  });

  it('on SIGTERM stops the web role first, then the worker, then exits 0', async () => {
    const { events, factories } = stands();
    await runServer({ roles: ['web', 'worker'], factories, proc, log });
    proc.emit('SIGTERM');
    await vi.waitFor(() => {
      expect(proc.exits).toEqual([0]);
    });
    expect(events).toEqual(['start worker', 'start web', 'stop web', 'stop worker']);
    expect(lines).toEqual([
      'running web,worker',
      'SIGTERM: stopping web,worker',
      'web stopped',
      'worker stopped',
    ]);
  });

  it('waits for the web role to finish stopping before it stops the worker', async () => {
    let release: () => void = () => undefined;
    const { events, factories } = stands({
      web: () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    });
    await runServer({ roles: ['web', 'worker'], factories, proc, log });
    proc.emit('SIGTERM');
    await vi.waitFor(() => {
      expect(events).toContain('stop web');
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(events).not.toContain('stop worker');
    release();
    await vi.waitFor(() => {
      expect(proc.exits).toEqual([0]);
    });
    expect(events.slice(-2)).toEqual(['stop web', 'stop worker']);
  });

  it('stops once, however many signals arrive', async () => {
    const { events, factories } = stands();
    await runServer({ roles: ['web', 'worker'], factories, proc, log });
    proc.emit('SIGINT');
    proc.emit('SIGTERM');
    await vi.waitFor(() => {
      expect(proc.exits).toEqual([0]);
    });
    expect(events.filter((e) => e.startsWith('stop'))).toEqual(['stop web', 'stop worker']);
    expect(lines).toContain('SIGINT: stopping web,worker');
    expect(lines.some((l) => l.startsWith('SIGTERM'))).toBe(false);
  });

  it('exits 1 within the 20 s budget when a role never finishes stopping', async () => {
    vi.useFakeTimers();
    expect(STOP_BUDGET_MS).toBe(20_000);
    const { events, factories } = stands({ web: never });
    await runServer({ roles: ['web', 'worker'], factories, proc, log });
    proc.emit('SIGTERM');
    await vi.advanceTimersByTimeAsync(STOP_BUDGET_MS - 1);
    expect(proc.exits).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(proc.exits).toEqual([1]);
    // The worker is still asked to stop, with what is left of the budget.
    expect(events).toContain('stop worker');
    expect(lines).toContain('web did not stop in time');
  });

  it('shares one budget across the roles, so the worker gets only what the web role left', async () => {
    vi.useFakeTimers();
    const { factories } = stands({
      web: () => new Promise<void>((resolve) => setTimeout(resolve, 15_000)),
      worker: never,
    });
    await runServer({ roles: ['web', 'worker'], factories, proc, log });
    proc.emit('SIGTERM');
    await vi.advanceTimersByTimeAsync(STOP_BUDGET_MS);
    expect(proc.exits).toEqual([1]);
    expect(lines).toEqual(expect.arrayContaining(['web stopped', 'worker did not stop in time']));
  });

  it('exits 1 when a role fails to stop, after still stopping the others', async () => {
    const { events, factories } = stands({
      web: () => Promise.reject(Object.assign(new Error('boom'), { code: 'EPIPE' })),
    });
    await runServer({ roles: ['web', 'worker'], factories, proc, log });
    proc.emit('SIGTERM');
    await vi.waitFor(() => {
      expect(proc.exits).toEqual([1]);
    });
    expect(events).toContain('stop worker');
    expect(lines).toContain('web failed to stop (EPIPE)');
  });

  it('stops what already started when a later role fails to start, and throws', async () => {
    const { events, factories } = stands();
    const broken = Object.assign(new Error('port taken'), { code: 'EADDRINUSE' });
    await expect(
      runServer({
        roles: ['web', 'worker'],
        factories: { ...factories, web: () => Promise.reject(broken) },
        proc,
        log,
      }),
    ).rejects.toBe(broken);
    expect(events).toEqual(['start worker', 'stop worker']);
    expect(proc.listenerCount('SIGTERM')).toBe(0);
    expect(proc.exits).toEqual([]);
  });

  it('refuses a role the entry point cannot run', async () => {
    const { factories } = stands();
    await expect(
      runServer({ roles: ['worker'], factories: { web: factories.web }, proc, log }),
    ).rejects.toThrow('no worker role in this entry point');
  });
});

describe('stopRoles', () => {
  it('orders the handles web first whatever order they come in', async () => {
    const order: string[] = [];
    const handle = (role: Role): RoleHandle => ({
      role,
      stop: () => {
        order.push(role);
        return Promise.resolve();
      },
    });
    const clean = await stopRoles([handle('worker'), handle('web')], { log: () => undefined });
    expect(clean).toBe(true);
    expect(order).toEqual(['web', 'worker']);
  });
});
