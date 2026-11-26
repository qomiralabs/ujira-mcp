// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The one domain: every row of the URL map, the old links, path traversal,
// and the canonical host on and off. Requests go out through node:http, not
// fetch, so a path reaches the server exactly as written (fetch would fold
// `..` away) and the Host header can be set.

import { request, type IncomingHttpHeaders } from 'node:http';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { afterEach, describe, expect, it } from 'vitest';

import { loadConsoleSettings } from '../src/console/settings.js';
import { consoleSettings, startConsole, stop, type World } from './console-helpers.js';
import { MANDATE } from './fake-rpc.js';

const open: World[] = [];

afterEach(async () => {
  await Promise.all(open.splice(0).map((w) => stop(w.server)));
});

async function start(canonicalHost?: string) {
  const settings = consoleSettings(canonicalHost === undefined ? {} : { canonicalHost });
  const w = await startConsole({ settings });
  open.push(w);
  return w;
}

interface Answer {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

function raw(
  base: string,
  path: string,
  options: { method?: string; host?: string } = {},
): Promise<Answer> {
  const url = new URL(base);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: url.hostname,
        port: url.port,
        path,
        method: options.method ?? 'GET',
        headers: options.host === undefined ? {} : { host: options.host },
        agent: false,
        timeout: 5_000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error(`timed out on ${path}`)));
    req.on('error', reject);
    req.end();
  });
}

async function mcpTools(url: string): Promise<number> {
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(url)) as Transport);
  const { tools } = await client.listTools();
  await client.close();
  return tools.length;
}

describe('one domain: pages', () => {
  it('serves the marketing site at the root and the proof page at /instaward', async () => {
    const { base } = await start();
    const home = await raw(base, '/');
    expect(home.status).toBe(200);
    expect(home.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(home.headers['cache-control']).toBe('no-cache');
    expect(home.headers['x-content-type-options']).toBe('nosniff');
    expect(home.headers['x-frame-options']).toBe('DENY');
    expect(home.body).toContain('UJIRA website');
    const proof = await raw(base, '/instaward');
    expect(proof.status).toBe(200);
    expect(proof.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(proof.body).toContain('UJIRA proof');
  });

  it('serves site images with a short cache and evidence data with none', async () => {
    const { base } = await start();
    const image = await raw(base, '/assets/sky.jpg');
    expect(image.status).toBe(200);
    expect(image.headers['content-type']).toBe('image/jpeg');
    expect(image.headers['cache-control']).toBe('public, max-age=3600');
    const data = await raw(base, '/data/page.json');
    expect(data.status).toBe(200);
    expect(data.headers['content-type']).toBe('application/json');
    expect(data.headers['cache-control']).toBe('no-cache');
    expect(JSON.parse(data.body)).toEqual({ mcp_url: 'https://ujira.co/mcp' });
  });

  it('serves the dashboard under /app, with its own index for every page path', async () => {
    const { base } = await start();
    for (const path of [
      '/app',
      '/app/',
      '/app/mandates',
      '/app/mandates/new',
      `/app/mandates/${MANDATE}`,
      '/app/approvals',
      '/app/payouts',
      '/app/receipts',
      '/app/recipients',
      '/app/developers',
    ]) {
      const page = await raw(base, path);
      expect(page.status, path).toBe(200);
      expect(page.headers['content-type'], path).toBe('text/html; charset=utf-8');
      expect(page.headers['cache-control'], path).toBe('no-cache');
      expect(page.body, path).toContain('UJIRA Console');
    }
    const script = await raw(base, '/app/assets/app.js');
    expect(script.status).toBe(200);
    expect(script.headers['content-type']).toBe('text/javascript; charset=utf-8');
    expect(script.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    const icon = await raw(base, '/app/favicon.svg');
    expect(icon.headers['content-type']).toBe('image/svg+xml');
    expect(icon.headers['cache-control']).toBe('public, max-age=3600');
  });

  it('answers a missing file with the 404 page, never with an app page', async () => {
    const { base } = await start();
    for (const path of [
      '/nope',
      '/assets/missing.png',
      '/data/missing.json',
      '/app/assets/missing.js',
      '/app/missing.png',
      '/robots.txt',
      '/apps',
      '/instaward/x',
    ]) {
      const res = await raw(base, path);
      expect(res.status, path).toBe(404);
      expect(res.headers['content-type'], path).toBe('text/html; charset=utf-8');
      expect(res.body, path).toContain('Page not found');
    }
  });

  it('never lists a folder', async () => {
    const { base } = await start();
    for (const path of ['/assets/', '/data/', '/assets', '/app/assets/', '/data']) {
      const res = await raw(base, path);
      expect(res.status, path).toBe(404);
      expect(res.body, path).not.toContain('sky.jpg');
      expect(res.body, path).not.toContain('app.js');
    }
  });

  it('never reads outside the site or the app folder', async () => {
    const { base } = await start();
    for (const path of [
      '/assets/../../secret.txt',
      '/app/../../secret.txt',
      '/app/assets/../../../secret.txt',
      '/data/../../secret.txt',
      '/assets/..%2f..%2fsecret.txt',
      '/assets/%2e%2e/%2e%2e/secret.txt',
      '/app/assets/%2E%2E%2F%2E%2E%2F%2E%2E%2Fsecret.txt',
      '/..%5c..%5csecret.txt',
      '/assets/%252e%252e/%252e%252e/secret.txt',
      '/assets/..%00/secret.txt',
      '/.env',
      '/data/..%2f.env',
      '/assets/%2e%2e/index.html',
    ]) {
      const res = await raw(base, path);
      expect(res.status, path).toBe(404);
      expect(res.body, path).not.toContain('outside the console');
      expect(res.body, path).not.toContain('hidden');
      expect(res.body, path).not.toContain('UJIRA website');
    }
  });

  it('answers HEAD with the headers only', async () => {
    const { base } = await start();
    const head = await raw(base, '/', { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(head.body).toBe('');
    expect(Number(head.headers['content-length'])).toBe(
      Buffer.byteLength('<!doctype html><title>UJIRA website</title>'),
    );
    expect((await raw(base, '/nope', { method: 'HEAD' })).status).toBe(404);
  });

  it('leaves other methods on a page path to the server, which says 404', async () => {
    const { base } = await start();
    const post = await raw(base, '/', { method: 'POST' });
    expect(post.status).toBe(404);
    expect(JSON.parse(post.body)).toEqual({ error: 'not found' });
  });
});

describe('one domain: the embed widget', () => {
  it('serves the widget at a versioned path, cached long and loadable from any page', async () => {
    const { base } = await start();
    const script = await raw(base, '/embed/v1/ujira-embed.js');
    expect(script.status).toBe(200);
    expect(script.headers['content-type']).toBe('text/javascript; charset=utf-8');
    expect(script.headers['cache-control']).toBe(
      'public, max-age=86400, stale-while-revalidate=604800',
    );
    // A module script from another origin needs CORS, and the page that
    // loads it is never ours.
    expect(script.headers['access-control-allow-origin']).toBe('*');
    expect(script.headers['cross-origin-resource-policy']).toBe('cross-origin');
    expect(script.headers['x-content-type-options']).toBe('nosniff');
    expect(script.body).toContain('ujira-onboarding');
    const head = await raw(base, '/embed/v1/ujira-embed.js', { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(head.body).toBe('');
  });

  it('answers any other embed path with the 404 page', async () => {
    const { base } = await start();
    for (const path of [
      '/embed',
      '/embed/',
      '/embed/v1',
      '/embed/v1/',
      '/embed/v2/ujira-embed.js',
      '/embed/ujira-embed.js',
      '/embed/v1/missing.js',
      '/embed/v1/../v1/ujira-embed.js',
      '/embed/v1/%2e%2e/%2e%2e/secret.txt',
      '/embed/v1/.hidden.js',
    ]) {
      const res = await raw(base, path);
      expect(res.status, path).toBe(404);
      expect(res.body, path).not.toContain('ujira-onboarding');
      expect(res.body, path).not.toContain('outside the console');
    }
  });

  it('serves the widget on every host, never through a redirect', async () => {
    const { base } = await start('ujira.co');
    const script = await raw(base, '/embed/v1/ujira-embed.js', { host: 'old.example' });
    expect(script.status).toBe(200);
    expect(script.body).toContain('ujira-onboarding');
    const page = await raw(base, '/', { host: 'old.example' });
    expect(page.status).toBe(301);
  });

  it('reads the widget folder from the environment', () => {
    expect(loadConsoleSettings({}).embedDir.endsWith('/embed/dist')).toBe(true);
    expect(loadConsoleSettings({ UJIRA_EMBED_DIR: '/srv/embed' }).embedDir).toBe('/srv/embed');
  });
});

describe('one domain: old links', () => {
  it('moves every old page to where it lives now, query included', async () => {
    const { base } = await start();
    const cases: [string, string][] = [
      ['/instaward.html', '/instaward'],
      ['/instaward.html?from=x', '/instaward?from=x'],
      ['/index.html', '/'],
      ['/app.html', '/app'],
      ['/?mock=1', '/app?mock=1'],
      ['/new', '/app/mandates/new'],
      [`/mandates/${MANDATE}`, `/app/mandates/${MANDATE}`],
      ['/mandates', '/app/mandates'],
      ['/approvals', '/app/approvals'],
      ['/payouts?mock=1', '/app/payouts?mock=1'],
      ['/receipts', '/app/receipts'],
      ['/recipients', '/app/recipients'],
      ['/developers', '/app/developers'],
    ];
    for (const [from, to] of cases) {
      const res = await raw(base, from);
      expect(res.status, from).toBe(301);
      expect(res.headers.location, from).toBe(to);
    }
    // The marketing page keeps its own query.
    expect((await raw(base, '/?utm_source=x')).status).toBe(200);
  });
});

describe('one domain: API and MCP stay as they were', () => {
  it('keeps /api, /healthz, /mcp and /m/<id>/mcp answering', async () => {
    const { base } = await start();
    const config = await raw(base, '/api/config');
    expect(config.status).toBe(200);
    expect(config.headers['content-type']).toBe('application/json');
    expect(JSON.parse(config.body)).toMatchObject({ network: 'testnet' });
    const missing = await raw(base, '/api/nothing');
    expect(JSON.parse(missing.body)).toEqual({
      error: { code: 'not_found', message: 'There is no such API route' },
    });
    expect(JSON.parse((await raw(base, '/healthz')).body)).toEqual({ status: 'ok' });
    expect((await raw(base, '/mcp')).status).toBe(405);
    expect((await raw(base, `/m/${MANDATE}/mcp`)).status).toBe(405);
    expect(await mcpTools(`${base}/mcp`)).toBe(4);
    expect(await mcpTools(`${base}/m/${MANDATE}/mcp`)).toBe(4);
  });
});

describe('one domain: canonical host', () => {
  it('is off by default: every host gets the pages', async () => {
    const { base } = await start();
    for (const host of ['ujira-mcp-production.up.railway.app', 'www.ujira.co', 'ujira.co']) {
      const res = await raw(base, '/', { host });
      expect(res.status, host).toBe(200);
    }
  });

  it('moves pages on any other host to the canonical one in one hop', async () => {
    const { base } = await start('ujira.co');
    const old = 'ujira-mcp-production.up.railway.app';
    const cases: [string, string, string][] = [
      [old, '/', 'https://ujira.co/'],
      [old, '/instaward', 'https://ujira.co/instaward'],
      [old, '/instaward.html?x=1', 'https://ujira.co/instaward?x=1'],
      [old, '/?mock=1', 'https://ujira.co/app?mock=1'],
      [old, `/app/mandates/${MANDATE}?mock=1`, `https://ujira.co/app/mandates/${MANDATE}?mock=1`],
      [old, '/assets/sky.jpg', 'https://ujira.co/assets/sky.jpg'],
      ['www.ujira.co', '/', 'https://ujira.co/'],
      ['www.ujira.co', '/app', 'https://ujira.co/app'],
    ];
    for (const [host, from, to] of cases) {
      const res = await raw(base, from, { host });
      expect(res.status, `${host}${from}`).toBe(301);
      expect(res.headers.location, `${host}${from}`).toBe(to);
    }
    const head = await raw(base, '/app', { method: 'HEAD', host: old });
    expect(head.status).toBe(301);
    expect(head.headers.location).toBe('https://ujira.co/app');
  });

  it('never sends a page to a host the server did not choose', async () => {
    const { base } = await start('ujira.co');
    for (const path of ['//evil.example/x', '///evil.example', '/%2f%2fevil.example', '/.env']) {
      const res = await raw(base, path, { host: 'evil.example' });
      expect(res.status, path).toBe(301);
      const location = String(res.headers.location);
      expect(new URL(location).host, path).toBe('ujira.co');
      expect(location.startsWith('https://ujira.co/'), path).toBe(true);
    }
  });

  it('serves the pages on the canonical host itself', async () => {
    const { base } = await start('ujira.co');
    for (const host of ['ujira.co', 'UJIRA.CO', 'ujira.co.', 'ujira.co:443']) {
      const res = await raw(base, '/', { host });
      expect(res.status, host).toBe(200);
      expect(res.body, host).toContain('UJIRA website');
    }
    const moved = await raw(base, '/app.html', { host: 'ujira.co' });
    expect(moved.headers.location).toBe('/app');
  });

  it('keeps the API and MCP answering on every host', async () => {
    const { base } = await start('ujira.co');
    const old = 'ujira-mcp-production.up.railway.app';
    expect((await raw(base, '/api/config', { host: old })).status).toBe(200);
    expect((await raw(base, '/healthz', { host: old })).status).toBe(200);
    expect((await raw(base, '/mcp', { host: old })).status).toBe(405);
    expect((await raw(base, `/m/${MANDATE}/mcp`, { host: old })).status).toBe(405);
    expect((await raw(base, '/', { method: 'POST', host: old })).status).toBe(404);
    // fetch sends Host 127.0.0.1:<port>, which is not the canonical host either.
    expect(await mcpTools(`${base}/mcp`)).toBe(4);
    expect(await mcpTools(`${base}/m/${MANDATE}/mcp`)).toBe(4);
  });
});
