// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The alert lines an operator pages on, and the watches that write them.
// Each alert is one log line whose event is the alert's name; the JSON sink
// writes it at level error with `alert` set, so a log search or a log based
// alert rule matches on the name alone.
//
//   payout_dead_letter  a payout job failed its last attempt; the payout needs a person
//   fee_sponsor_low     the account that pays principals' network fees is low on XLM
//   executor_low        the account that executes approved payouts is low on XLM
//   reconcile_stale     the sweep that finds stuck payouts has not run for too long
//
// A low account is not skipped: jobs keep failing and retrying, and the alert
// repeats on every check until someone tops the account up.

import { errorCode, logLine, type AlertEvent, type Log } from '../log.js';
import type { HeartbeatName, Heartbeats } from './heartbeat.js';

export type { AlertEvent } from '../log.js';
export { ALERT_EVENTS } from '../log.js';

/** The worker writes this when a payout job fails for the last time. */
export function deadLetterLine(p: {
  readonly principalId: string;
  readonly projectId: string;
  readonly payoutId: string;
  readonly task: string;
  readonly attempts: number;
  readonly error: unknown;
}): string {
  return logLine('payout_dead_letter', {
    principalId: p.principalId,
    projectId: p.projectId,
    payoutId: p.payoutId,
    task: p.task,
    attempts: p.attempts,
    error: errorCode(p.error),
  });
}

export type BalanceAlert = Extract<AlertEvent, 'executor_low' | 'fee_sponsor_low'>;

export function lowBalanceLine(
  alert: BalanceAlert,
  p: {
    readonly account: string;
    /** Null when the account does not exist on the network. */
    readonly balanceStroops: bigint | null;
    readonly thresholdStroops: bigint;
  },
): string {
  return logLine(alert, {
    account: p.account,
    exists: p.balanceStroops !== null,
    balanceStroops: p.balanceStroops ?? 0n,
    thresholdStroops: p.thresholdStroops,
  });
}

export function reconcileStaleLine(p: {
  readonly lastRunAt: string | null;
  readonly ageSeconds: number;
  readonly maxAgeSeconds: number;
}): string {
  return logLine('reconcile_stale', {
    lastRunAt: p.lastRunAt ?? 'never',
    ageSeconds: p.ageSeconds,
    maxAgeSeconds: p.maxAgeSeconds,
  });
}

/** 50 XLM: a few thousand executions or fee bumps at testnet fees. */
export const EXECUTOR_LOW_STROOPS = 500_000_000n;
export const FEE_SPONSOR_LOW_STROOPS = 500_000_000n;

/** Horizon is asked about each account this often. */
export const BALANCE_CHECK_MS = 15 * 60_000;
/** Heartbeats are local, so they are read often. */
export const HEARTBEAT_CHECK_MS = 60_000;

export interface WatchedAccount {
  readonly alert: BalanceAlert;
  readonly account: string;
  readonly thresholdStroops: bigint;
}

export interface BalanceWatchOptions {
  readonly accounts: readonly WatchedAccount[];
  /** The account's XLM in stroops, or null when it does not exist. */
  readonly balance: (account: string) => Promise<bigint | null>;
  readonly log: Log;
  readonly intervalMs?: number;
}

/** A repeating timer that never keeps the process alive and never overlaps its own runs. */
class Repeat {
  private timer: ReturnType<typeof setInterval> | undefined;
  private first: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<void> | undefined;
  private readonly work: () => Promise<void>;
  private readonly intervalMs: number;

  constructor(work: () => Promise<void>, intervalMs: number) {
    this.work = work;
    this.intervalMs = intervalMs;
  }

  runOnce(): Promise<void> {
    if (this.running !== undefined) return this.running;
    this.running = this.work().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  start(firstDelayMs: number): void {
    if (this.timer !== undefined) return;
    const tick = () => {
      // A failed round is the next round's to retry; it must not end the process.
      this.runOnce().catch(() => undefined);
    };
    this.first = setTimeout(tick, firstDelayMs);
    this.first.unref();
    this.timer = setInterval(tick, this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.first !== undefined) clearTimeout(this.first);
    if (this.timer !== undefined) clearInterval(this.timer);
    this.first = undefined;
    this.timer = undefined;
  }
}

/** Writes executor_low or fee_sponsor_low for each watched account under its threshold. */
export class BalanceWatch {
  private readonly o: BalanceWatchOptions;
  private readonly repeat: Repeat;

  constructor(options: BalanceWatchOptions) {
    this.o = options;
    this.repeat = new Repeat(() => this.pass(), options.intervalMs ?? BALANCE_CHECK_MS);
  }

  private async pass(): Promise<void> {
    for (const watched of this.o.accounts) {
      let balance: bigint | null;
      try {
        balance = await this.o.balance(watched.account);
      } catch (error) {
        // Not an alert: the network being unreachable is the deep check's to report.
        this.o.log(
          logLine('balance_check_failed', { check: watched.alert, error: errorCode(error) }),
        );
        continue;
      }
      if (balance === null || balance < watched.thresholdStroops) {
        this.o.log(
          lowBalanceLine(watched.alert, {
            account: watched.account,
            balanceStroops: balance,
            thresholdStroops: watched.thresholdStroops,
          }),
        );
      }
    }
  }

  runOnce(): Promise<void> {
    return this.repeat.runOnce();
  }

  /** The first check comes soon after start, since a deploy restarts the process often. */
  start(firstDelayMs = 30_000): void {
    if (this.o.accounts.length > 0) this.repeat.start(firstDelayMs);
  }

  stop(): void {
    this.repeat.stop();
  }
}

export interface HeartbeatWatchOptions {
  readonly heartbeats: Heartbeats;
  readonly log: Log;
  readonly intervalMs?: number;
}

/** Writes reconcile_stale while the reconcile sweep is late, and a line when the worker is. */
export class HeartbeatWatch {
  private readonly o: HeartbeatWatchOptions;
  private readonly repeat: Repeat;

  constructor(options: HeartbeatWatchOptions) {
    this.o = options;
    this.repeat = new Repeat(() => {
      this.pass();
      return Promise.resolve();
    }, options.intervalMs ?? HEARTBEAT_CHECK_MS);
  }

  private stale(name: HeartbeatName) {
    const state = this.o.heartbeats.state(name);
    return state.status === 'stale' ? state : undefined;
  }

  private pass(): void {
    const reconcile = this.stale('reconcile');
    if (reconcile !== undefined) {
      this.o.log(
        reconcileStaleLine({
          lastRunAt: reconcile.lastAt,
          ageSeconds: reconcile.ageSeconds ?? 0,
          maxAgeSeconds: reconcile.maxAgeSeconds ?? 0,
        }),
      );
    }
    const worker = this.stale('worker');
    if (worker !== undefined) {
      this.o.log(
        logLine('worker_heartbeat_stale', {
          level: 'error',
          lastAt: worker.lastAt ?? 'never',
          ageSeconds: worker.ageSeconds,
          maxAgeSeconds: worker.maxAgeSeconds,
        }),
      );
    }
  }

  runOnce(): Promise<void> {
    return this.repeat.runOnce();
  }

  start(firstDelayMs = HEARTBEAT_CHECK_MS): void {
    this.repeat.start(firstDelayMs);
  }

  stop(): void {
    this.repeat.stop();
  }
}
