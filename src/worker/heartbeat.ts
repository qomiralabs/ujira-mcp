// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// When the parts that run on their own last showed they were alive: the job
// worker, and the reconcile sweep that finds stuck payouts. Each part says
// how often it should beat when it starts; until it does, the deep health
// check reports it as not configured rather than as failing, so a process
// that does not run that part is not flagged for it.
//
// The record is in process. Testnet runs the web and worker roles in one
// service, so the deep check sees the worker's beats directly.

export const HEARTBEATS = ['worker', 'reconcile'] as const;
export type HeartbeatName = (typeof HEARTBEATS)[number];

/** The worker polls for jobs every few seconds, so a minute of silence means it is stuck. */
export const WORKER_MAX_AGE_MS = 60_000;

/** Reconcile runs every two minutes; three missed runs is stale. */
export const RECONCILE_MAX_AGE_MS = 6 * 60_000;

export interface HeartbeatState {
  readonly status: 'ok' | 'stale' | 'not_configured';
  /** ISO 8601, or null before the first beat. */
  readonly lastAt: string | null;
  /** Seconds since the last beat, or since the part started when it has not beaten yet. */
  readonly ageSeconds: number | null;
  readonly maxAgeSeconds: number | null;
}

interface Expected {
  readonly maxAgeMs: number;
  readonly since: number;
}

export class Heartbeats {
  private readonly expected = new Map<HeartbeatName, Expected>();
  private readonly last = new Map<HeartbeatName, number>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  /** Called once by the part when it starts. Its first beat is due within `maxAgeMs`. */
  expect(name: HeartbeatName, maxAgeMs: number): void {
    const since = this.expected.get(name)?.since ?? this.now();
    this.expected.set(name, { maxAgeMs, since });
  }

  /** Called by the part each time it finishes a round of work. */
  beat(name: HeartbeatName): void {
    this.last.set(name, this.now());
  }

  /** Called by the part when it stops on purpose, so a clean stop is not reported as stale. */
  forget(name: HeartbeatName): void {
    this.expected.delete(name);
    this.last.delete(name);
  }

  state(name: HeartbeatName): HeartbeatState {
    const expected = this.expected.get(name);
    if (expected === undefined) {
      return { status: 'not_configured', lastAt: null, ageSeconds: null, maxAgeSeconds: null };
    }
    const last = this.last.get(name);
    const age = this.now() - (last ?? expected.since);
    return {
      status: age > expected.maxAgeMs ? 'stale' : 'ok',
      lastAt: last === undefined ? null : new Date(last).toISOString(),
      ageSeconds: Math.floor(age / 1000),
      maxAgeSeconds: Math.floor(expected.maxAgeMs / 1000),
    };
  }
}
