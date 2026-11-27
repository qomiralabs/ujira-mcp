// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { Agent, createServer, request, type IncomingMessage, type Server } from 'node:http';
import { createServer as createTcpServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { issueToken } from '../src/auth/token.js';
import { Recycler } from '../src/demo/recycler.js';
import { closeServer, ListenError, startWeb } from '../src/server/web.js';
import { MandateKeepAlive } from '../src/worker/keep-alive.js';
import { keypair } from './console-helpers.js';
import { MANDATE } from './fake-rpc.js';
import { freePort, tryConnect } from './server-helpers.js';

const cleanup: (() => unknown)[] = [];

afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
  vi.restoreAllMocks();
});

function get(port: number, path: string, agent?: Agent): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port, path, agent: agent ?? false },
      (res: IncomingMessage) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (body += chunk));
        res.on('end', () => {
          resolve({ status: res.statusCode ?? 0, body });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

function getWithHeaders(
  port: number,
  path: string,
): Promise<{ status: number; body: string; headers: IncomingMessage['headers'] }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, agent: false }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => (body += chunk));
      res.on('end', () => {
        resolve({ status: res.statusCode ?? 0, body, headers: res.headers });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function listening(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

describe('closeServer', () => {
  it('stops taking connections at once and lets the request in flight finish', async () => {
    let release = () => undefined as unknown;
    let arrived = () => undefined as unknown;
    const inFlight = new Promise<void>((resolve) => (arrived = resolve));
    const server = createServer((_req, res) => {
      arrived();
      release = () => res.end('done');
    });
    const port = await listening(server);

    const answer = get(port, '/slow');
    await inFlight;
    let closed = false;
    const stopping = closeServer(server, 5_000).then(() => (closed = true));

    expect(await tryConnect(port)).toBe('ECONNREFUSED');
    expect(closed).toBe(false);
    release();
    expect(await answer).toEqual({ status: 200, body: 'done' });
    await stopping;
    expect(closed).toBe(true);
  });

  it('does not wait out the keep alive timeout of an idle connection', async () => {
    const server = createServer((_req, res) => res.end('ok'));
    server.keepAliveTimeout = 75_000;
    const port = await listening(server);
    const agent = new Agent({ keepAlive: true });
    cleanup.push(() => {
      agent.destroy();
    });

    expect((await get(port, '/', agent)).status).toBe(200);
    const started = Date.now();
    await closeServer(server, 5_000);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('closes a request that outlives the grace', async () => {
    const server = createServer(() => undefined);
    const port = await listening(server);
    const answer = get(port, '/hang').then(
      () => 'answered',
      (error: unknown) => (error as NodeJS.ErrnoException).code,
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    const started = Date.now();
    await closeServer(server, 200);
    expect(Date.now() - started).toBeGreaterThanOrEqual(150);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(await answer).toBe('ECONNRESET');
  });
});

describe('startWeb', () => {
  async function env(): Promise<Record<string, string>> {
    const dir = mkdtempSync(join(tmpdir(), 'ujira-web-'));
    cleanup.push(() => {
      rmSync(dir, { recursive: true, force: true });
    });
    return {
      UJIRA_MANDATE_ID: MANDATE,
      UJIRA_AGENT_SECRET: keypair('web-role-agent').secret(),
      UJIRA_RECEIPTS_FILE: join(dir, 'receipts.json'),
      UJIRA_DATA_DIR: dir,
      UJIRA_CONSOLE_DIR: join(dir, 'console'),
      UJIRA_SITE_DIR: join(dir, 'site'),
      UJIRA_HTTP_HOST: '127.0.0.1',
      PORT: String(await freePort()),
    };
  }

  it('serves /healthz and /v1/ping, runs the keep alive, and stops both on stop', async () => {
    const keepStart = vi.spyOn(MandateKeepAlive.prototype, 'start');
    const keepStop = vi.spyOn(MandateKeepAlive.prototype, 'stop');
    const vars = await env();
    const port = Number(vars['PORT']);
    const lines: string[] = [];
    const web = await startWeb(vars, (line) => lines.push(line), 1_000);
    cleanup.push(() => web.stop());

    expect(web.role).toBe('web');
    expect(await get(port, '/healthz')).toEqual({ status: 200, body: '{"status":"ok"}' });
    const ping = await get(port, '/v1/ping');
    expect(ping.status).toBe(200);
    expect(JSON.parse(ping.body)).toEqual({ status: 'ok' });
    // The public demo MCP is the demo's, so with the demo off /mcp is unknown.
    expect((await get(port, '/mcp')).status).toBe(404);
    expect(lines).toEqual(
      expect.arrayContaining([
        'demo off',
        'keep alive: on',
        expect.stringMatching(/^ready on testnet at 127\.0\.0\.1:\d+, mandate C/),
      ]),
    );
    expect(lines.join('\n')).not.toContain(vars['UJIRA_AGENT_SECRET']);
    expect(keepStart).toHaveBeenCalledTimes(1);
    expect(keepStop).not.toHaveBeenCalled();

    await web.stop();
    expect(await tryConnect(port)).toBe('ECONNREFUSED');
    expect(keepStop).toHaveBeenCalledTimes(1);
  });

  it('serves the embed widget and its Albedo chunk under /embed/v1/ to any page', async () => {
    const vars = await env();
    const embedDir = join(vars['UJIRA_DATA_DIR'] ?? '', 'embed');
    mkdirSync(embedDir);
    writeFileSync(join(embedDir, 'ujira-embed.js'), 'customElements.define("ujira-onboarding")');
    writeFileSync(join(embedDir, 'ujira-embed-albedo-0f3a9c.js'), 'export {}');
    const port = Number(vars['PORT']);
    const web = await startWeb({ ...vars, UJIRA_EMBED_DIR: embedDir }, () => undefined, 1_000);
    cleanup.push(() => web.stop());

    const main = await getWithHeaders(port, '/embed/v1/ujira-embed.js');
    expect(main.status).toBe(200);
    expect(main.body).toBe('customElements.define("ujira-onboarding")');
    expect(main.headers['access-control-allow-origin']).toBe('*');
    expect(main.headers['cross-origin-resource-policy']).toBe('cross-origin');
    expect(main.headers['cache-control']).toBe(
      'public, max-age=86400, stale-while-revalidate=604800',
    );
    expect((await get(port, '/embed/v1/ujira-embed-albedo-0f3a9c.js')).status).toBe(200);
    expect((await get(port, '/embed/v1/Ujira-Embed.js')).status).toBe(404);
    expect((await get(port, '/embed/v2/ujira-embed.js')).status).toBe(404);
  });

  it('with the demo on, serves the public /mcp and runs the recycler until stop', async () => {
    const recycleStart = vi.spyOn(Recycler.prototype, 'start');
    const recycleStop = vi.spyOn(Recycler.prototype, 'stop');
    const vars: Record<string, string> = {
      ...(await env()),
      UJIRA_NETWORK: 'testnet',
      UJIRA_DEMO_FEATURES: 'on',
      UJIRA_TREASURY_SECRET: keypair('web-role-treasury').secret(),
      UJIRA_KEEPALIVE: 'off',
    };
    const port = Number(vars['PORT']);
    const lines: string[] = [];
    const web = await startWeb(vars, (line) => lines.push(line), 1_000);
    cleanup.push(() => web.stop());

    expect((await get(port, '/mcp')).status).toBe(405);
    expect((await get(port, '/v1/ping')).status).toBe(200);
    expect(lines).toEqual(
      expect.arrayContaining([
        'demo on: faucet on, sdp off, recycler every 300s',
        'keep alive: off',
      ]),
    );
    expect(lines.join('\n')).not.toContain(vars['UJIRA_TREASURY_SECRET']);
    expect(recycleStart).toHaveBeenCalledExactlyOnceWith(300_000);
    expect(recycleStop).not.toHaveBeenCalled();

    await web.stop();
    expect(await tryConnect(port)).toBe('ECONNREFUSED');
    expect(recycleStop).toHaveBeenCalledTimes(1);
  });

  it('rejects with the system code when the port is taken, and stops its timers', async () => {
    const keepStop = vi.spyOn(MandateKeepAlive.prototype, 'stop');
    const vars = await env();
    const taken = createTcpServer();
    await new Promise<void>((resolve) => taken.listen(Number(vars['PORT']), '127.0.0.1', resolve));
    cleanup.push(() => new Promise((resolve) => taken.close(resolve)));

    const failure = startWeb(vars, () => undefined);
    await expect(failure).rejects.toBeInstanceOf(ListenError);
    await expect(failure).rejects.toMatchObject({
      code: 'EADDRINUSE',
      message: 'cannot listen (EADDRINUSE)',
    });
    expect(keepStop).toHaveBeenCalledTimes(1);
  });

  it('serves no sign in and tells the dashboard so, unless UJIRA_SIGN_IN is on', async () => {
    const vars: Record<string, string> = { ...(await env()), UJIRA_KEEPALIVE: 'off' };
    const port = Number(vars['PORT']);
    const lines: string[] = [];
    const web = await startWeb(vars, (line) => lines.push(line), 1_000);
    cleanup.push(() => web.stop());
    expect(lines).toContain('sign in: off');
    expect(JSON.parse((await get(port, '/api/config')).body)).toMatchObject({ signIn: false });
    expect((await get(port, '/v1/me')).status).toBe(404);
    expect((await get(port, '/v1/projects')).status).toBe(404);
  });

  it('with UJIRA_SIGN_IN on, mounts the sign in routes on the database', async () => {
    // Nothing listens on this port, so every query meets a refused connection.
    const db = `postgresql://ujira_app:unused@127.0.0.1:${String(await freePort())}/ujira`;
    const vars: Record<string, string> = {
      ...(await env()),
      UJIRA_KEEPALIVE: 'off',
      UJIRA_SIGN_IN: 'on',
      UJIRA_PUBLIC_ORIGIN: 'http://127.0.0.1',
      UJIRA_DB_TLS: 'off',
      UJIRA_DB_APP_URL: db,
      UJIRA_DB_WORKER_URL: db,
      UJIRA_DB_MIGRATOR_URL: db,
      UJIRA_DB_READER_URL: db,
    };
    const port = Number(vars['PORT']);
    const lines: string[] = [];
    const web = await startWeb(vars, (line) => lines.push(line), 1_000);
    cleanup.push(() => web.stop());
    expect(lines).toContain('sign in: on');
    expect(JSON.parse((await get(port, '/api/config')).body)).toMatchObject({ signIn: true });
    const res = await fetch(`http://127.0.0.1:${String(port)}/v1/auth/challenge`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ address: keypair('web-role-member').publicKey() }),
    });
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('DB_UNAVAILABLE');
    // The project routes come with sign in. Without a cookie they refuse
    // before any query, so they answer even with no database behind them.
    expect((await get(port, '/v1/projects')).status).toBe(401);
    // So do the key routes.
    const keys = await fetch(`http://127.0.0.1:${String(port)}/v1/api-keys`);
    expect(keys.status).toBe(401);
    expect(((await keys.json()) as { error: { code: string } }).error.code).toBe('SESSION_INVALID');
    const byKey = await fetch(`http://127.0.0.1:${String(port)}/v1/api-keys`, {
      headers: { authorization: `Bearer ${issueToken('test').token}` },
    });
    // Keys cannot manage keys, so this is refused before the database is asked.
    expect(byKey.status).toBe(403);
    // No key encryption key, so no recipients, and the log says why.
    expect(lines).toContain('recipients: off');
    expect(lines).toContain('event=recipients_off level=warn reason=key_encryption_key_missing');
    expect((await get(port, '/v1/recipients')).status).toBe(404);
    expect(lines.join('\n')).not.toContain('unused');
    await web.stop();
    expect(await tryConnect(port)).toBe('ECONNREFUSED');
  });

  it('mounts the recipient routes once the key encryption key is set, and never logs it', async () => {
    const db = `postgresql://ujira_app:unused@127.0.0.1:${String(await freePort())}/ujira`;
    const kek = randomBytes(32).toString('base64');
    const vars: Record<string, string> = {
      ...(await env()),
      UJIRA_KEEPALIVE: 'off',
      UJIRA_SIGN_IN: 'on',
      UJIRA_PUBLIC_ORIGIN: 'http://127.0.0.1',
      UJIRA_DB_TLS: 'off',
      UJIRA_DB_APP_URL: db,
      UJIRA_DB_WORKER_URL: db,
      UJIRA_DB_MIGRATOR_URL: db,
      UJIRA_DB_READER_URL: db,
      UJIRA_KEY_ENCRYPTION_KEY: kek,
    };
    const port = Number(vars['PORT']);
    const lines: string[] = [];
    const web = await startWeb(vars, (line) => lines.push(line), 1_000);
    cleanup.push(() => web.stop());
    expect(lines).toContain('recipients: on');
    // Mounted: without a session or a key they refuse before any query.
    const list = await get(port, '/v1/recipients');
    expect(list.status).toBe(401);
    expect((JSON.parse(list.body) as { error: { code: string } }).error.code).toBe(
      'SESSION_INVALID',
    );
    expect(lines.join('\n')).not.toContain(kek);
    await web.stop();
  });

  it('keeps serving without recipients when the key encryption key is not usable', async () => {
    const db = `postgresql://ujira_app:unused@127.0.0.1:${String(await freePort())}/ujira`;
    const vars: Record<string, string> = {
      ...(await env()),
      UJIRA_KEEPALIVE: 'off',
      UJIRA_SIGN_IN: 'on',
      UJIRA_PUBLIC_ORIGIN: 'http://127.0.0.1',
      UJIRA_DB_TLS: 'off',
      UJIRA_DB_APP_URL: db,
      UJIRA_DB_WORKER_URL: db,
      UJIRA_DB_MIGRATOR_URL: db,
      UJIRA_DB_READER_URL: db,
      UJIRA_KEY_ENCRYPTION_KEY: 'not-a-key',
    };
    const port = Number(vars['PORT']);
    const lines: string[] = [];
    const web = await startWeb(vars, (line) => lines.push(line), 1_000);
    cleanup.push(() => web.stop());
    expect(lines).toContain('event=recipients_off level=warn reason=key_encryption_key_invalid');
    expect(lines).toContain('recipients: off');
    expect((await get(port, '/v1/recipients')).status).toBe(404);
    expect((await get(port, '/v1/projects')).status).toBe(401);
    expect(lines.join('\n')).not.toContain('not-a-key');
    await web.stop();
  });

  it('refuses sign in without its database or its origin, before it listens', async () => {
    const vars: Record<string, string> = {
      ...(await env()),
      UJIRA_SIGN_IN: 'on',
      UJIRA_PUBLIC_ORIGIN: 'https://ujira.co',
    };
    await expect(startWeb(vars, () => undefined)).rejects.toMatchObject({
      name: 'EngineError',
      message: expect.stringContaining('UJIRA_DB_APP_URL') as unknown,
    });
    const noOrigin = { ...(await env()), UJIRA_SIGN_IN: 'on' };
    await expect(startWeb(noOrigin, () => undefined)).rejects.toThrow('UJIRA_PUBLIC_ORIGIN');
    expect(await tryConnect(Number(vars['PORT']))).toBe('ECONNREFUSED');
  });

  it('refuses to start without the mandate, before it listens', async () => {
    const vars = await env();
    delete vars['UJIRA_MANDATE_ID'];
    await expect(startWeb(vars, () => undefined)).rejects.toThrow('set UJIRA_MANDATE_ID');
    expect(await tryConnect(Number(vars['PORT']))).toBe('ECONNREFUSED');
  });
});
