// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The deep health check: which part failing makes the service degraded and
// which makes it down, that every probe is bounded and shared, that an
// answer never carries an error message, and that /healthz is untouched.

import { createHash } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { Keypair } from '@stellar/stellar-sdk';
import { afterEach, describe, expect, it } from 'vitest';

import { ChainError } from '../src/chain/adapter.js';
import { loadSettings, type Wiring } from '../src/config.js';
import { DatabaseUnavailableError } from '../src/db/index.js';
import { createHttpServer } from '../src/mcp/http.js';
import { DEFAULT_MAX_AMOUNT, type HttpSettings } from '../src/mcp/public.js';
import {
  DeepHealth,
  ProbeFailure,
  databaseProbeFromEnv,
  type DeepHealthOptions,
  type HealthReport,
} from '../src/server/health.js';
import { observabilityFromEnv } from '../src/server/observability.js';
import { Heartbeats, RECONCILE_MAX_AGE_MS, WORKER_MAX_AGE_MS } from '../src/worker/heartbeat.js';
import { MANDATE } from './fake-rpc.js';

const healthyRpc = () => Promise.resolve({ ok: true, latestLedger: 123 });
const healthyDb = () => Promise.resolve();

function health(over: Partial<DeepHealthOptions> = {}, now = () => 1_000_000) {
  const lines: string[] = [];
  const check = new DeepHealth({
    database: healthyDb,
    rpc: healthyRpc,
    heartbeats: new Heartbeats(now),
    log: (line) => lines.push(line),
    cacheMs: 0,
    now,
    ...over,
  });
  return { check, lines };
}

describe('the deep health states', () => {
  it('is ok when every configured part answers', async () => {
    const { check, lines } = health();
    const report = await check.check();
    expect(report.status).toBe('ok');
    expect(report.checks.database).toMatchObject({ status: 'ok' });
    expect(report.checks.rpc).toMatchObject({ status: 'ok', latestLedger: 123 });
    expect(report.checks.worker.status).toBe('not_configured');
    expect(report.checks.reconcile.status).toBe('not_configured');
    expect(lines).toEqual([]);
  });

  it('answers degraded, not down, when only the RPC fails', async () => {
    for (const rpc of [
      () => Promise.resolve({ ok: false, latestLedger: 0 }),
      () => Promise.reject(new ChainError('UNAVAILABLE', 'the RPC refused')),
      () => Promise.reject(new ChainError('TIMEOUT', 'the RPC did not answer')),
    ]) {
      const { check, lines } = health({ rpc });
      const report = await check.check();
      expect(report.status).toBe('degraded');
      expect(report.checks.database.status).toBe('ok');
      expect(report.checks.rpc.status).toBe('failing');
      expect(['UNAVAILABLE', 'TIMEOUT']).toContain(report.checks.rpc.code);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(/^event=health_degraded level=warn status=degraded /);
    }
  });

  it('answers down when the database fails, whatever the RPC says', async () => {
    const { check, lines } = health({
      database: () => Promise.reject(new DatabaseUnavailableError('ECONNREFUSED')),
      rpc: () => Promise.resolve({ ok: false, latestLedger: 0 }),
    });
    const report = await check.check();
    expect(report.status).toBe('down');
    expect(report.checks.database).toMatchObject({ status: 'failing', code: 'ECONNREFUSED' });
    expect(lines[0]).toMatch(/level=error status=down database=failing databaseCode=ECONNREFUSED/);
  });

  it('is ok with no database and no chain configured, since this process uses neither', async () => {
    const check = new DeepHealth({ heartbeats: new Heartbeats() });
    const report = await check.check();
    expect(report.status).toBe('ok');
    expect(report.checks.database.status).toBe('not_configured');
    expect(report.checks.rpc.status).toBe('not_configured');
  });

  it('is degraded when the worker or the reconcile sweep is late', async () => {
    let t = 0;
    const heartbeats = new Heartbeats(() => t);
    const { check } = health({ heartbeats }, () => t);
    heartbeats.expect('worker', WORKER_MAX_AGE_MS);
    heartbeats.expect('reconcile', RECONCILE_MAX_AGE_MS);
    expect((await check.check()).status).toBe('ok');

    t = WORKER_MAX_AGE_MS + 1;
    let report = await check.check();
    expect(report.status).toBe('degraded');
    expect(report.checks.worker).toMatchObject({ status: 'stale', lastAt: null, ageSeconds: 60 });
    expect(report.checks.reconcile.status).toBe('ok');

    heartbeats.beat('worker');
    t = RECONCILE_MAX_AGE_MS + 1;
    report = await check.check();
    expect(report.checks.worker.status).toBe('stale');
    expect(report.checks.reconcile.status).toBe('stale');

    heartbeats.beat('worker');
    heartbeats.beat('reconcile');
    report = await check.check();
    expect(report.status).toBe('ok');
    expect(report.checks.reconcile).toMatchObject({
      status: 'ok',
      lastAt: new Date(RECONCILE_MAX_AGE_MS + 1).toISOString(),
      ageSeconds: 0,
      maxAgeSeconds: 360,
    });

    heartbeats.forget('worker');
    expect((await check.check()).checks.worker.status).toBe('not_configured');
  });

  it('bounds a probe that never answers', async () => {
    const { check } = health({
      rpc: () => new Promise(() => undefined),
      timeoutMs: 20,
      now: Date.now,
    });
    const report = await check.check();
    expect(report.status).toBe('degraded');
    expect(report.checks.rpc).toMatchObject({ status: 'failing', code: 'TIMEOUT' });
  });

  it('never carries an error message, a host or a URL', async () => {
    const leak = 'postgres://ujira_app:hunter2@db.internal:6543 timed out';
    const { check, lines } = health({
      database: () => Promise.reject(new Error(leak)),
      rpc: () => Promise.reject(new TypeError(`fetch https://rpc.internal failed: ${leak}`)),
    });
    const report = await check.check();
    const text = JSON.stringify(report) + lines.join('\n');
    expect(text).not.toContain('hunter2');
    expect(text).not.toContain('internal');
    expect(report.checks.database.code).toBe('Error');
    expect(report.checks.rpc.code).toBe('TypeError');
  });

  it('shares one round of probes between checks inside the cache window', async () => {
    let t = 0;
    let calls = 0;
    const check = new DeepHealth({
      rpc: () => {
        calls += 1;
        return healthyRpc();
      },
      heartbeats: new Heartbeats(() => t),
      cacheMs: 5_000,
      now: () => t,
    });
    await Promise.all([check.check(), check.check()]);
    t = 4_999;
    await check.check();
    expect(calls).toBe(1);
    t = 5_000;
    await check.check();
    expect(calls).toBe(2);
  });
});

describe('the database probe from the environment', () => {
  it('is unset with no database URL', async () => {
    const probe = databaseProbeFromEnv({});
    expect(probe.probe).toBeUndefined();
    await probe.close();
  });

  it('fails with config_invalid, without stopping the server, when the configuration is refused', async () => {
    const probe = databaseProbeFromEnv({ UJIRA_DB_APP_URL: 'postgres://u:p@db.example:6543/x' });
    await expect(probe.probe?.()).rejects.toBeInstanceOf(ProbeFailure);
    await expect(probe.probe?.()).rejects.toMatchObject({ code: 'config_invalid' });
    const { check } = health({ ...(probe.probe === undefined ? {} : { database: probe.probe }) });
    expect((await check.check()).checks.database).toMatchObject({
      status: 'failing',
      code: 'config_invalid',
    });
    await probe.close();
  });

  it('probes through the app login, and reports a database that refuses connections as failing', async () => {
    const url = 'postgres://ujira_app:not-a-real-password@127.0.0.1:1/postgres';
    const probe = databaseProbeFromEnv({
      UJIRA_DB_TLS: 'off',
      UJIRA_DB_APP_URL: url,
      UJIRA_DB_WORKER_URL: url,
      UJIRA_DB_MIGRATOR_URL: url,
    });
    expect(probe.probe).toBeDefined();
    const { check, lines } = health({
      ...(probe.probe === undefined ? {} : { database: probe.probe }),
      now: Date.now,
    });
    const report = await check.check();
    expect(report.status).toBe('down');
    expect(report.checks.database.status).toBe('failing');
    expect(JSON.stringify(report) + lines.join('\n')).not.toContain('not-a-real-password');
    await probe.close();
  });
});

function settings(): HttpSettings {
  return {
    port: 0,
    host: '127.0.0.1',
    maxBodyBytes: 16 * 1024,
    requestTimeoutMs: 10_000,
    allowedOrigins: [],
    clientIp: { trustProxy: false },
    limits: { maxAmount: DEFAULT_MAX_AMOUNT, payoutsPerHour: 5, toolCallsPerMinute: 120 },
  };
}

const open: Server[] = [];

afterEach(async () => {
  await Promise.all(
    open.splice(0).map(
      (s) =>
        new Promise<void>((resolve) => {
          s.closeAllConnections();
          s.close(() => {
            resolve();
          });
        }),
    ),
  );
});

async function serve(deepHealth?: () => Promise<HealthReport>) {
  const server = createHttpServer({
    settings: settings(),
    ...(deepHealth === undefined ? {} : { deepHealth }),
  });
  open.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
}

describe('/healthz/deep over HTTP', () => {
  it('answers 200 with the report when degraded, and 503 only when down', async () => {
    let db: () => Promise<void> = healthyDb;
    const check = new DeepHealth({
      database: () => db(),
      rpc: () => Promise.resolve({ ok: false, latestLedger: 0 }),
      heartbeats: new Heartbeats(),
      cacheMs: 0,
    });
    const base = await serve(() => check.check());

    const degraded = await fetch(`${base}/healthz/deep`);
    expect(degraded.status).toBe(200);
    expect(degraded.headers.get('cache-control')).toBe('no-store');
    const body = (await degraded.json()) as HealthReport;
    expect(body.status).toBe('degraded');
    expect(body.checks.rpc.status).toBe('failing');

    db = () => Promise.reject(new DatabaseUnavailableError('connection'));
    const down = await fetch(`${base}/healthz/deep`);
    expect(down.status).toBe(503);
    expect(((await down.json()) as HealthReport).status).toBe('down');

    expect((await fetch(`${base}/healthz/deep`, { method: 'HEAD' })).status).toBe(503);
    const post = await fetch(`${base}/healthz/deep`, { method: 'POST' });
    expect(post.status).toBe(405);
    expect(post.headers.get('allow')).toBe('GET');
  });

  it('leaves /healthz shallow and as it was, even when the deep check is down', async () => {
    let deepCalls = 0;
    const base = await serve(() => {
      deepCalls += 1;
      return new DeepHealth({
        database: () => Promise.reject(new Error('down')),
        heartbeats: new Heartbeats(),
      }).check();
    });
    const shallow = await fetch(`${base}/healthz`);
    expect(shallow.status).toBe(200);
    expect(await shallow.json()).toEqual({ status: 'ok' });
    expect(shallow.headers.get('ujira-request-id')).toBeNull();
    expect(deepCalls).toBe(0);
  });

  it('is a plain 404 when the server has no deep check', async () => {
    const base = await serve();
    expect((await fetch(`${base}/healthz/deep`)).status).toBe(404);
  });
});

describe('the composed observability', () => {
  it('serves the deep check from the adapter and the heartbeats, and stops cleanly', async () => {
    const key = Keypair.fromRawEd25519Seed(createHash('sha256').update('observe').digest());
    const settings = loadSettings({ UJIRA_MANDATE_ID: MANDATE, UJIRA_AGENT_SECRET: key.secret() });
    const wiring = {
      adapter: {
        health: () => Promise.resolve({ ok: true, latestLedger: 7 }),
      } as unknown as Wiring['adapter'],
      network: {
        account: () => Promise.resolve({ exists: true, xlm: '1000.0000000', usdc: null }),
      } as unknown as Wiring['network'],
    };
    const observe = observabilityFromEnv({ env: {}, settings, wiring, log: () => undefined });
    const report = await observe.deepHealth();
    expect(report.status).toBe('ok');
    expect(report.checks.rpc).toMatchObject({ status: 'ok', latestLedger: 7 });
    expect(report.checks.database.status).toBe('not_configured');
    observe.heartbeats.expect('worker', WORKER_MAX_AGE_MS);
    observe.start();
    await observe.stop();
  });
});
