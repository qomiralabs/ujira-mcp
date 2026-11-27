// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// Runs the real entry point in a child process, so the role switch, the
// signal handling and the exit codes are checked as a host would see them.

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { keypair } from './console-helpers.js';
import { MANDATE } from './fake-rpc.js';
import { freePort, tryConnect } from './server-helpers.js';

const ROOT = join(import.meta.dirname, '..');
const children: ChildProcess[] = [];
const dirs: string[] = [];

afterEach(() => {
  for (const child of children.splice(0)) if (child.exitCode === null) child.kill('SIGKILL');
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Run {
  readonly child: ChildProcess;
  readonly out: () => string;
  readonly err: () => string;
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

function start(env: Record<string, string>): Run {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/server/main.ts'], {
    cwd: ROOT,
    // Only what the test names, so a developer's own UJIRA_ settings cannot leak in.
    env: { PATH: process.env['PATH'] ?? '', HOME: tmpdir(), ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  let out = '';
  let err = '';
  child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')));
  child.stderr.on('data', (chunk: Buffer) => (err += chunk.toString('utf8')));
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once('exit', (code, signal) => {
      resolve({ code, signal });
    });
  });
  return { child, out: () => readable(out), err: () => err, exited };
}

/** Each JSON log line as `service: message`, the way the lines read before they were JSON. */
function readable(out: string): string {
  return out
    .split('\n')
    .map((line) => {
      if (!line.startsWith('{')) return line;
      const record = JSON.parse(line) as { service?: unknown; message?: unknown };
      return `${String(record.service)}: ${String(record.message)}`;
    })
    .join('\n');
}

async function until(check: () => boolean, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function webEnv(): Promise<Record<string, string>> {
  const dir = mkdtempSync(join(tmpdir(), 'ujira-main-'));
  dirs.push(dir);
  return {
    UJIRA_MANDATE_ID: MANDATE,
    UJIRA_AGENT_SECRET: keypair('main-agent').secret(),
    UJIRA_RECEIPTS_FILE: join(dir, 'receipts.json'),
    UJIRA_DATA_DIR: dir,
    UJIRA_CONSOLE_DIR: join(dir, 'console'),
    UJIRA_SITE_DIR: join(dir, 'site'),
    UJIRA_HTTP_HOST: '127.0.0.1',
    PORT: String(await freePort()),
  };
}

async function healthz(port: number): Promise<number> {
  const res = await fetch(`http://127.0.0.1:${String(port)}/healthz`);
  return res.status;
}

describe('src/server/main.ts', { timeout: 60_000 }, () => {
  it('refuses an unknown role with a clear message and exit code 1', async () => {
    const run = start({ UJIRA_ROLES: 'web,jobs' });
    expect(await run.exited).toEqual({ code: 1, signal: null });
    expect(run.err()).toBe(
      'ujira-server: UJIRA_ROLES must be web, worker or web,worker; "jobs" is not a role\n',
    );
  });

  it('runs the worker alone with no listener and none of the web settings, and stops on SIGTERM', async () => {
    const port = await freePort();
    const run = start({ UJIRA_ROLES: 'worker', PORT: String(port) });
    await until(() => run.out().includes('ujira-server: running worker'), 15_000);
    expect(run.out()).toContain('ujira-worker: ready, queue off: UJIRA_DB_WORKER_URL is not set');
    expect(await tryConnect(port)).toBe('ECONNREFUSED');

    const sent = Date.now();
    run.child.kill('SIGTERM');
    expect(await run.exited).toEqual({ code: 0, signal: null });
    expect(Date.now() - sent).toBeLessThan(20_000);
    expect(run.out()).toContain('ujira-server: worker stopped');
    expect(run.err()).toBe('');
  });

  it('names a bad database setting of the worker without its value, and exits 1', async () => {
    const run = start({
      UJIRA_ROLES: 'worker',
      UJIRA_DB_WORKER_URL: 'postgresql://login:not-shown@127.0.0.1:54329/ujira',
    });
    expect(await run.exited).toEqual({ code: 1, signal: null });
    expect(run.err()).toBe('ujira-server: UJIRA_DB_APP_URL is required\n');
    expect(run.out()).not.toContain('not-shown');
  });

  it('skips the migrations when no database is configured, before any role starts', async () => {
    const run = start({ UJIRA_ROLES: 'worker' });
    await until(() => run.out().includes('ujira-server: running worker'), 15_000);
    const lines = run.out().split('\n');
    const skipped = lines.indexOf(
      'ujira-server: migrations skipped: UJIRA_DB_MIGRATOR_URL is not set',
    );
    expect(skipped).toBeGreaterThan(-1);
    expect(skipped).toBeLessThan(lines.indexOf('ujira-server: running worker'));
    run.child.kill('SIGTERM');
    expect(await run.exited).toEqual({ code: 0, signal: null });
  });

  it('exits 1 without listening when the migrations fail, and never prints the password', async () => {
    const env = await webEnv();
    const port = Number(env['PORT']);
    const password = 'migrator-password-not-real-9c1e';
    // Nothing listens on this port, so the run fails to connect.
    const database = await freePort();
    const run = start({
      ...env,
      UJIRA_DB_TLS: 'off',
      UJIRA_DB_MIGRATOR_URL: `postgresql://ujira_migrator:${password}@127.0.0.1:${String(database)}/ujira`,
    });
    expect(await run.exited).toEqual({ code: 1, signal: null });
    expect(run.err()).toMatch(/^ujira-server: migrations failed: .+\n$/);
    expect(run.out()).toContain('ujira-server: migrations starting, under the migrator login');
    expect(run.out()).not.toContain('running');
    expect(run.out() + run.err()).not.toContain(password);
    expect(await tryConnect(port)).toBe('ECONNREFUSED');
  });

  it('refuses a migrator URL on the PgBouncer port before connecting', async () => {
    const run = start({
      UJIRA_ROLES: 'worker',
      UJIRA_DB_MIGRATOR_URL: 'postgresql://ujira_migrator:secret@db.example.test:6432/ujira',
    });
    expect(await run.exited).toEqual({ code: 1, signal: null });
    expect(run.err()).toBe(
      'ujira-server: migrations refused: UJIRA_DB_MIGRATOR_URL must not use the transaction pooler port 6432: the migration lock is held in the session, so connect directly on 5432\n',
    );
    expect(run.out()).not.toContain('running');
  });

  it('runs web and worker when UJIRA_ROLES is unset, answers /healthz, and stops web first', async () => {
    const env = await webEnv();
    const port = Number(env['PORT']);
    const run = start(env);
    await until(() => run.out().includes('ujira-server: running web,worker'), 15_000);
    expect(await healthz(port)).toBe(200);

    const sent = Date.now();
    run.child.kill('SIGTERM');
    expect(await run.exited).toEqual({ code: 0, signal: null });
    expect(Date.now() - sent).toBeLessThan(20_000);
    const lines = run.out().split('\n');
    const web = lines.indexOf('ujira-server: web stopped');
    const worker = lines.indexOf('ujira-server: worker stopped');
    expect(web).toBeGreaterThan(-1);
    expect(worker).toBeGreaterThan(web);
    // The bind address reads [redacted]: the log sink takes every IP address out.
    expect(run.out()).toContain('ujira-mcp-http: ready on testnet at ');
    expect(run.out()).not.toContain(env['UJIRA_AGENT_SECRET']);
    expect(run.err()).toBe('');
  });

  it('runs the web role alone and reports a bad setting without starting', async () => {
    const env = await webEnv();
    const port = Number(env['PORT']);
    const ok = start({ ...env, UJIRA_ROLES: 'web' });
    await until(() => ok.out().includes('ujira-server: running web'), 15_000);
    expect(await healthz(port)).toBe(200);
    expect(ok.out()).not.toContain('ujira-worker');
    ok.child.kill('SIGTERM');
    expect(await ok.exited).toEqual({ code: 0, signal: null });

    const missing: Record<string, string> = { ...env, UJIRA_ROLES: 'web' };
    delete missing['UJIRA_MANDATE_ID'];
    const bad = start(missing);
    expect(await bad.exited).toEqual({ code: 1, signal: null });
    expect(bad.err()).toMatch(/^ujira-server: set UJIRA_MANDATE_ID/);
  });
});
