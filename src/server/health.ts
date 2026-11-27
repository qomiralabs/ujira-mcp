// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The deep health check at /healthz/deep. /healthz stays shallow and fast,
// since the platform restarts the service when it fails; this one asks the
// parts the service depends on and says how each answered.
//
//   ok        every configured part answers
//   degraded  the chain RPC fails, or the worker or the reconcile sweep is late;
//             /v1 still takes payouts, and jobs wait and retry
//   down      the database fails: nothing that moves money can be recorded
//
// A part this process does not use is `not_configured` and never lowers the
// status. Every probe is bounded, results are shared for a few seconds so a
// burst of checks costs one round of probes, and an answer names only error
// codes, never a message, a host or a URL.

import { callOptions, type CallOptions } from '../chain/adapter.js';
import {
  createDatabase,
  DatabaseConfigError,
  loadDatabaseConfig,
  type Database,
} from '../db/index.js';
import { errorCode, logLine, type Log } from '../log.js';
import type { HeartbeatName, HeartbeatState, Heartbeats } from '../worker/heartbeat.js';

export type HealthStatus = 'ok' | 'degraded' | 'down';

export interface ProbeReport {
  readonly status: 'ok' | 'failing' | 'not_configured';
  readonly ms?: number;
  readonly code?: string;
}

export interface RpcReport extends ProbeReport {
  readonly latestLedger?: number;
}

export interface HealthReport {
  readonly status: HealthStatus;
  readonly checkedAt: string;
  readonly checks: {
    readonly database: ProbeReport;
    readonly rpc: RpcReport;
    readonly worker: HeartbeatState;
    readonly reconcile: HeartbeatState;
  };
}

export interface DeepHealthOptions {
  /** Resolves when the database answers. Unset, the database is not configured. */
  readonly database?: () => Promise<void>;
  /** The chain adapter's health call. Unset, the chain is not configured. */
  readonly rpc?: (o: CallOptions) => Promise<{ ok: boolean; latestLedger: number }>;
  readonly heartbeats: Heartbeats;
  readonly log?: Log;
  /** Per probe. */
  readonly timeoutMs?: number;
  /** How long one round of probes answers every check. */
  readonly cacheMs?: number;
  readonly now?: () => number;
}

export const PROBE_TIMEOUT_MS = 2_000;
export const HEALTH_CACHE_MS = 5_000;

class ProbeTimeout extends Error {
  readonly code = 'TIMEOUT';
}

/** A probe that failed for a known reason, such as configuration the database cannot start from. */
export class ProbeFailure extends Error {
  readonly code: string;

  constructor(code: string) {
    super('the probe failed');
    this.name = 'ProbeFailure';
    this.code = code;
  }
}

/** The work, or a timeout after `ms`, whichever comes first. The timer never holds the process. */
function bounded<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new ProbeTimeout('the probe did not answer in time'));
    }, ms);
    timer.unref();
  });
  work.catch(() => undefined);
  return Promise.race([work, late]).finally(() => {
    clearTimeout(timer);
  });
}

function failureCode(error: unknown): string {
  const reason: unknown =
    error instanceof Error ? (error as { reason?: unknown }).reason : undefined;
  // The database's unavailable error carries a SQLSTATE or socket code as its reason.
  if (typeof reason === 'string' && /^[A-Za-z0-9_]{1,48}$/.test(reason)) return reason;
  return errorCode(error);
}

export class DeepHealth {
  private readonly o: DeepHealthOptions;
  private readonly now: () => number;
  private cached: { readonly at: number; readonly report: Promise<HealthReport> } | undefined;

  constructor(options: DeepHealthOptions) {
    this.o = options;
    this.now = options.now ?? Date.now;
  }

  private async timed<T>(
    work: () => Promise<T>,
  ): Promise<{ ok: true; value: T; ms: number } | { ok: false; code: string; ms: number }> {
    const started = this.now();
    try {
      const value = await bounded(work(), this.o.timeoutMs ?? PROBE_TIMEOUT_MS);
      return { ok: true, value, ms: this.now() - started };
    } catch (error) {
      return { ok: false, code: failureCode(error), ms: this.now() - started };
    }
  }

  private async database(): Promise<ProbeReport> {
    const probe = this.o.database;
    if (probe === undefined) return { status: 'not_configured' };
    const result = await this.timed(probe);
    return result.ok
      ? { status: 'ok', ms: result.ms }
      : { status: 'failing', ms: result.ms, code: result.code };
  }

  private async rpc(): Promise<RpcReport> {
    const probe = this.o.rpc;
    if (probe === undefined) return { status: 'not_configured' };
    const timeoutMs = this.o.timeoutMs ?? PROBE_TIMEOUT_MS;
    const result = await this.timed(() => probe(callOptions('health', timeoutMs)));
    if (!result.ok) return { status: 'failing', ms: result.ms, code: result.code };
    if (!result.value.ok) return { status: 'failing', ms: result.ms, code: 'UNAVAILABLE' };
    return { status: 'ok', ms: result.ms, latestLedger: result.value.latestLedger };
  }

  private heartbeat(name: HeartbeatName): HeartbeatState {
    return this.o.heartbeats.state(name);
  }

  private async run(): Promise<HealthReport> {
    const [database, rpc] = await Promise.all([this.database(), this.rpc()]);
    const worker = this.heartbeat('worker');
    const reconcile = this.heartbeat('reconcile');
    const status: HealthStatus =
      database.status === 'failing'
        ? 'down'
        : rpc.status === 'failing' || worker.status === 'stale' || reconcile.status === 'stale'
          ? 'degraded'
          : 'ok';
    const report: HealthReport = {
      status,
      checkedAt: new Date(this.now()).toISOString(),
      checks: { database, rpc, worker, reconcile },
    };
    if (status !== 'ok') {
      this.o.log?.(
        logLine('health_degraded', {
          level: status === 'down' ? 'error' : 'warn',
          status,
          database: database.status,
          databaseCode: database.code,
          rpc: rpc.status,
          rpcCode: rpc.code,
          worker: worker.status,
          reconcile: reconcile.status,
        }),
      );
    }
    return report;
  }

  /** One round of probes, shared by every check within the cache window. */
  check(): Promise<HealthReport> {
    const at = this.now();
    const cached = this.cached;
    if (cached !== undefined && at - cached.at < (this.o.cacheMs ?? HEALTH_CACHE_MS)) {
      return cached.report;
    }
    const report = this.run();
    this.cached = { at, report };
    return report;
  }
}

type Env = Readonly<Record<string, string | undefined>>;

export interface DatabaseProbe {
  /** Unset when this process has no database configured. */
  readonly probe?: () => Promise<void>;
  readonly close: () => Promise<void>;
}

/**
 * The database probe from the environment. With no `UJIRA_DB_APP_URL` the
 * process has no database and the probe is unset. With configuration the
 * database refuses, the server still starts, since it serves more than the
 * database, and the probe fails with `config_invalid` so the deep check
 * says why. The probe is an empty transaction on the app login, the same
 * path a request takes.
 */
export function databaseProbeFromEnv(env: Env): DatabaseProbe {
  const url = env['UJIRA_DB_APP_URL'];
  if (url === undefined || url.trim() === '') return { close: () => Promise.resolve() };
  let db: Database;
  try {
    db = createDatabase(loadDatabaseConfig(env));
  } catch (error) {
    if (!(error instanceof DatabaseConfigError)) throw error;
    return {
      probe: () => Promise.reject(new ProbeFailure('config_invalid')),
      close: () => Promise.resolve(),
    };
  }
  return {
    probe: () => db.unscoped(() => Promise.resolve()),
    close: () => db.close(),
  };
}
