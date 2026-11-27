// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// Measures the database from wherever it runs, with the service's own
// configuration, so the numbers are the ones the app will see. Run it on the
// app's host:
//
//   node dist/db/spike-cli.js [--samples N]
//
// It reads UJIRA_DB_APP_URL, UJIRA_DB_WORKER_URL and UJIRA_DB_MIGRATOR_URL
// (and UJIRA_DB_TLS) exactly as the services do, through loadDatabaseConfig,
// and reports:
//
//   - each connection path: its port, the login, whether the server end is
//     on TLS, the time to connect, and the round trip of `select 1`;
//   - a tenant transaction, the unit every request and job pays: `begin`
//     with the tenant context, one statement that reads the context back,
//     and `commit`, through createDatabase, for the app on the pooler and
//     for the worker on its direct connection;
//   - LISTEN on the worker's connection, with the notification sent through
//     the app's pooler, which must arrive within 10 s;
//   - LISTEN through the pooler, which a transaction pooler is expected not
//     to deliver, recorded as measured rather than assumed.
//
// It writes nothing: the only statements are reads, LISTEN and NOTIFY on a
// channel named for the run. No URL, host or password is printed.

import { randomBytes, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';

import { sql } from 'kysely';
import pg from 'pg';

import { loadDatabaseConfig, type DatabaseConfig, type DatabaseEnvironment } from './config.js';
import { createDatabase, type DatabaseRole } from './database.js';

export interface SpikeOutput {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

export interface Summary {
  readonly n: number;
  readonly p50: number;
  readonly p95: number;
  readonly max: number;
}

// Nearest rank: the smallest sample with at least p percent of the samples
// at or below it. Exact for the small counts a spike takes, and never an
// interpolated value nobody measured.
export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) throw new RangeError('no samples');
  if (p <= 0 || p > 100) throw new RangeError('p must be in (0, 100]');
  const rank = Math.ceil((p / 100) * sorted.length);
  const value = sorted[rank - 1];
  if (value === undefined) throw new RangeError('rank outside the samples');
  return value;
}

export function summarise(samples: readonly number[]): Summary {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    n: sorted.length,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    max: percentile(sorted, 100),
  };
}

export function formatSummary(summary: Summary): string {
  return `p50=${summary.p50.toFixed(2)}ms p95=${summary.p95.toFixed(2)}ms max=${summary.max.toFixed(2)}ms n=${String(summary.n)}`;
}

export const DEFAULT_SAMPLES = 200;
const WARM_UP = 10;
const LISTEN_LIMIT_MS = 10_000;
const POOLER_LISTEN_WAIT_MS = 3_000;
// Above this the ADR asks for the database or the app to move.
export const TENANT_P50_LIMIT_MS = 20;

export function parseSamples(argv: readonly string[]): number | string {
  if (argv.length === 0) return DEFAULT_SAMPLES;
  const [flag, value, ...rest] = argv;
  if (flag !== '--samples' || value === undefined || rest.length > 0) {
    return 'usage: node dist/db/spike-cli.js [--samples N]';
  }
  if (!/^[1-9][0-9]{0,4}$/.test(value))
    return 'the sample count must be a whole number from 1 to 99999';
  return Number.parseInt(value, 10);
}

// Errors are reported by code and message with every configured host taken
// out, since a driver message can name the host it failed to reach.
function describeError(error: unknown, hosts: readonly string[]): string {
  if (!(error instanceof Error)) return 'unknown error';
  const code = (error as { code?: unknown }).code;
  let message = error.message;
  for (const host of hosts) message = message.split(host).join('[host]');
  return typeof code === 'string' ? `${code}: ${message}` : message;
}

type PathRole = Extract<DatabaseRole, 'app' | 'worker' | 'migration'>;
const PATH_ROLES: readonly PathRole[] = ['app', 'worker', 'migration'];

function clientFor(config: DatabaseConfig, role: PathRole): pg.Client {
  return new pg.Client({
    connectionString: config[role].url.reveal(),
    ...(config.tlsOptions === undefined ? {} : { ssl: config.tlsOptions }),
  });
}

function portOf(config: DatabaseConfig, role: PathRole): string {
  return new URL(config[role].url.reveal()).port || '5432';
}

async function timed(work: () => Promise<unknown>): Promise<number> {
  const started = performance.now();
  await work();
  return performance.now() - started;
}

async function measurePath(
  config: DatabaseConfig,
  role: PathRole,
  samples: number,
  output: SpikeOutput,
): Promise<Summary> {
  const client = clientFor(config, role);
  const connectMs = await timed(() => client.connect());
  try {
    const { rows } = await client.query<{ login: string; ssl: boolean | null; version: string }>(
      `select current_user as login,
              (select ssl from pg_catalog.pg_stat_ssl where pid = pg_catalog.pg_backend_pid()) as ssl,
              current_setting('server_version') as version`,
    );
    const info = rows[0];
    for (let i = 0; i < WARM_UP; i += 1) await client.query('select 1');
    const times: number[] = [];
    for (let i = 0; i < samples; i += 1) times.push(await timed(() => client.query('select 1')));
    const summary = summarise(times);
    output.out(
      `spike: path ${role} port=${portOf(config, role)} login=${info?.login ?? '?'} server_ssl=${String(info?.ssl ?? false)} postgres=${info?.version ?? '?'} connect=${connectMs.toFixed(2)}ms select1 ${formatSummary(summary)}`,
    );
    return summary;
  } finally {
    await client.end();
  }
}

async function measureTenant(
  config: DatabaseConfig,
  role: 'app' | 'worker',
  samples: number,
  output: SpikeOutput,
): Promise<Summary> {
  const db = createDatabase(config);
  const context = { principalId: randomUUID(), projectId: randomUUID(), scope: 'project' } as const;
  const once = async (): Promise<string> =>
    db.withTenant(role, context, async (k) => {
      const { rows } = await sql<{
        project: string;
      }>`select ujira.current_project_id() as project`.execute(k);
      return rows[0]?.project ?? '';
    });
  try {
    // The context must have reached the server, or the number means nothing.
    const seen = await once();
    if (seen !== context.projectId) throw new Error('the tenant context did not reach the server');
    for (let i = 0; i < WARM_UP; i += 1) await once();
    const times: number[] = [];
    for (let i = 0; i < samples; i += 1) times.push(await timed(once));
    const summary = summarise(times);
    output.out(`spike: tenant ${role} port=${portOf(config, role)} ${formatSummary(summary)}`);
    return summary;
  } finally {
    await db.close();
  }
}

// Listens on one connection, notifies from another, and resolves with the
// delivery time, or null when nothing arrives within the wait.
async function measureListen(
  config: DatabaseConfig,
  listenOn: PathRole,
  notifyFrom: PathRole,
  waitMs: number,
): Promise<number | null> {
  const channel = `ujira_spike_${randomBytes(6).toString('hex')}`;
  const listener = clientFor(config, listenOn);
  const sender = clientFor(config, notifyFrom);
  await listener.connect();
  await sender.connect();
  try {
    await listener.query(`listen ${channel}`);
    let sentAt = 0;
    const arrived = new Promise<number>((resolve) => {
      listener.on('notification', (message) => {
        if (message.channel === channel) resolve(performance.now() - sentAt);
      });
    });
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => {
        resolve(null);
      }, waitMs);
    });
    sentAt = performance.now();
    await sender.query('select pg_catalog.pg_notify($1, $2)', [channel, 'spike']);
    const result = await Promise.race([arrived, timeout]);
    clearTimeout(timer);
    return result;
  } finally {
    await listener.end();
    await sender.end();
  }
}

export interface SpikeResult {
  readonly ok: boolean;
  readonly tenantAppP50Ms: number | null;
}

export async function runSpike(
  env: DatabaseEnvironment,
  samples: number,
  output: SpikeOutput,
): Promise<SpikeResult> {
  const config = loadDatabaseConfig(env);
  const hosts = PATH_ROLES.map((role) => new URL(config[role].url.reveal()).hostname);
  let ok = true;
  // Written inside the attempts below, so held in an object rather than a
  // variable the compiler would narrow to its first value.
  const measured: { tenantAppP50Ms: number | null } = { tenantAppP50Ms: null };
  const attempt = async (label: string, work: () => Promise<void>): Promise<void> => {
    try {
      await work();
    } catch (error) {
      ok = false;
      output.err(`spike: ${label} failed: ${describeError(error, hosts)}`);
    }
  };

  for (const role of PATH_ROLES) {
    await attempt(`path ${role}`, async () => {
      await measurePath(config, role, samples, output);
    });
  }
  await attempt('tenant app', async () => {
    measured.tenantAppP50Ms = (await measureTenant(config, 'app', samples, output)).p50;
  });
  await attempt('tenant worker', async () => {
    await measureTenant(config, 'worker', samples, output);
  });
  await attempt('listen worker', async () => {
    const ms = await measureListen(config, 'worker', 'app', LISTEN_LIMIT_MS);
    output.out(
      ms === null
        ? `spike: listen worker port=${portOf(config, 'worker')} delivered=false within ${String(LISTEN_LIMIT_MS)}ms`
        : `spike: listen worker port=${portOf(config, 'worker')} delivered=true in ${ms.toFixed(2)}ms`,
    );
    if (ms === null) throw new Error(`no notification within ${String(LISTEN_LIMIT_MS)} ms`);
  });
  await attempt('listen app', async () => {
    const ms = await measureListen(config, 'app', 'worker', POOLER_LISTEN_WAIT_MS);
    output.out(
      `spike: listen app port=${portOf(config, 'app')} delivered=${String(ms !== null)}${ms === null ? ` within ${String(POOLER_LISTEN_WAIT_MS)}ms` : ` in ${ms.toFixed(2)}ms`}`,
    );
  });

  const p50 = measured.tenantAppP50Ms;
  if (p50 !== null) {
    output.out(
      p50 > TENANT_P50_LIMIT_MS
        ? `spike: verdict tenant p50 ${p50.toFixed(2)}ms is above ${String(TENANT_P50_LIMIT_MS)}ms: move the database or the app so they share a region`
        : `spike: verdict tenant p50 ${p50.toFixed(2)}ms is within ${String(TENANT_P50_LIMIT_MS)}ms`,
    );
  }
  return { ok, tenantAppP50Ms: p50 };
}

// Returns the exit code: 0 when every path connected, the tenant
// transactions ran and the worker received its notification in time.
export async function main(
  argv: readonly string[],
  env: DatabaseEnvironment,
  output: SpikeOutput,
): Promise<number> {
  const samples = parseSamples(argv);
  if (typeof samples === 'string') {
    output.err(`spike: ${samples}`);
    return 1;
  }
  try {
    return (await runSpike(env, samples, output)).ok ? 0 : 1;
  } catch (error) {
    // A configuration error names variables, never values.
    output.err(`spike: ${error instanceof Error ? error.message : 'the spike failed'}`);
    return 1;
  }
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  process.exitCode = await main(process.argv.slice(2), process.env, {
    out: (line) => {
      process.stdout.write(`${line}\n`);
    },
    err: (line) => {
      process.stderr.write(`${line}\n`);
    },
  });
}
