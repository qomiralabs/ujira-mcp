// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// Serves the built widget on a plain HTML page for the browser tests, the
// way an integrator loads it: one script tag at /embed/v1/ujira-embed.js and
// one element with a token. The same origin answers the widget's /v1/embed
// routes from the fake API, so the browser runs the real HTTP client against
// the contract with no UJIRA server behind it.
//
// The token names the scenario: ujes_test_wallet, ujes_test_no-trustline,
// ujes_test_closed. Anything else is refused as an expired token.
//
//   npm run build && node tools/serve.ts [port]

import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { join } from 'node:path';

import { createServer as createVite } from 'vite';

import type * as Client from '../src/api/client.ts';
import type * as Fake from '../src/api/fake.ts';

export const DEFAULT_PORT = 4178;
export const BUNDLE_PATH = '/embed/v1/ujira-embed.js';

const PAGES: Readonly<Record<string, string>> = {
  '/': 'e2e/host.html',
  '/host.html': 'e2e/host.html',
};

const SCENARIOS: Readonly<Record<string, Partial<Fake.FakeScenario>>> = {
  wallet: {},
  'no-trustline': { receivability: 'NO_TRUSTLINE' },
  closed: { methods: [] },
};

export interface Running {
  url: string;
  close: () => Promise<void>;
}

function send(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
  });
  response.end(text);
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  return text === '' ? undefined : JSON.parse(text);
}

export async function startServer(root: string, port = DEFAULT_PORT): Promise<Running> {
  const bundle = readFileSync(join(root, 'dist', 'ujira-embed.js'), 'utf8');
  // Vite loads the fake from source, so it runs exactly as the unit tests do.
  const vite = await createVite({
    root,
    configFile: false,
    logLevel: 'warn',
    appType: 'custom',
    server: { middlewareMode: true, hmr: false, ws: false },
  });
  const fake = (await vite.ssrLoadModule('/src/api/fake.ts')) as typeof Fake;
  const { problemOf } = (await vite.ssrLoadModule('/src/api/client.ts')) as typeof Client;
  const clients = new Map<string, Fake.FakeClient>();

  function clientFor(request: IncomingMessage): Fake.FakeClient | undefined {
    const token = /^Bearer (ujes_test_[a-z-]+)$/.exec(request.headers.authorization ?? '')?.[1];
    const scenario = token === undefined ? undefined : SCENARIOS[token.slice('ujes_test_'.length)];
    if (token === undefined || scenario === undefined) return undefined;
    let client = clients.get(token);
    if (client === undefined) {
      client = fake.fakeClient(scenario);
      clients.set(token, client);
    }
    return client;
  }

  async function api(request: IncomingMessage, response: ServerResponse, path: string) {
    const client = clientFor(request);
    if (client === undefined) {
      send(response, 401, { error: { code: 'TOKEN_INVALID', message: 'Token invalid' } });
      return;
    }
    const body = request.method === 'POST' ? await readBody(request) : undefined;
    const parts = path.split('/').map((part) => decodeURIComponent(part));
    // ['', 'v1', 'embed', 'recipients', id, 'methods', methodId, action]
    const [, , , kind, id = '', , methodId = '', action] = parts;
    try {
      if (request.method === 'GET' && path === '/v1/embed/onboarding') {
        send(response, 200, await client.session());
      } else if (kind === 'recipients' && parts.length === 6) {
        send(response, 201, await client.addMethod(id, body as never));
      } else if (action === 'wallet-challenges') {
        send(response, 201, await client.createWalletChallenge(id, methodId));
      } else if (action === 'wallet-proofs') {
        send(response, 201, await client.submitWalletProof(id, methodId, body as never));
      } else {
        send(response, 404, { error: { code: 'NOT_FOUND', message: 'Not found' } });
      }
    } catch (error) {
      const problem = problemOf(error);
      if (problem === undefined) throw error;
      const { status, code, reason, requestId } = problem;
      send(response, status, {
        error: { code, message: code, requestId, ...(reason === undefined ? {} : { reason }) },
      });
    }
  }

  const server: Server = createServer((request, response) => {
    const path = (request.url ?? '/').split('?')[0] ?? '/';
    if (path.startsWith('/v1/embed/')) {
      api(request, response, path).catch(() => {
        send(response, 500, { error: { code: 'INTERNAL', message: 'Internal' } });
      });
      return;
    }
    if (path === BUNDLE_PATH) {
      response.writeHead(200, {
        'content-type': 'text/javascript; charset=utf-8',
        'cache-control': 'no-store',
      });
      response.end(bundle);
      return;
    }
    const page = PAGES[path];
    if (page === undefined) {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('not found');
      return;
    }
    response.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
    });
    response.end(readFileSync(join(root, page), 'utf8'));
  });
  await new Promise<void>((resolve) => {
    server.listen(port, '127.0.0.1', resolve);
  });
  return {
    url: `http://127.0.0.1:${String(port)}`,
    close: async () => {
      await vite.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    },
  };
}

const entry = process.argv[1] ?? '';
if (entry.endsWith('serve.ts')) {
  const argument = process.argv[2];
  const port = argument === undefined ? DEFAULT_PORT : Number.parseInt(argument, 10);
  const running = await startServer(join(import.meta.dirname, '..'), port);
  process.stdout.write(`host page on ${running.url}/host.html\n`);
}
