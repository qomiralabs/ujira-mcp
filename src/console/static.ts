// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// Serves the built console UI. Any GET that is not a file and does not look
// like one gets index.html, so the app's own routes survive a reload. Paths
// are resolved inside the console directory and nothing outside it is ever
// read.

import { readFile, stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, normalize, sep } from 'node:path';

const TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json',
  '.webmanifest': 'application/manifest+json',
};

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'strict-origin-when-cross-origin',
};

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/** The file a URL path names inside `root`, or undefined when it would leave it. */
export function resolveInside(root: string, urlPath: string): string | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return undefined;
  }
  if (decoded.includes('\0') || decoded.includes('\\')) return undefined;
  const target = normalize(join(root, decoded));
  const base = root.endsWith(sep) ? root : `${root}${sep}`;
  return target === root || target.startsWith(base) ? target : undefined;
}

export function createStatic(root: string) {
  return async (req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean> => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;
    const index = join(root, 'index.html');
    let file = path === '/' ? index : resolveInside(root, path);
    if (file === undefined) return false;
    if (!(await isFile(file))) {
      // A missing asset is a 404; a missing page is the app's to route.
      if (extname(path) !== '') return false;
      file = index;
      if (!(await isFile(file))) return false;
    }
    const body = await readFile(file);
    const immutable = path.startsWith('/assets/') && file !== index;
    res.writeHead(200, {
      'content-type': TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
      'content-length': String(body.length),
      'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
      ...SECURITY_HEADERS,
    });
    res.end(req.method === 'HEAD' ? undefined : body);
    return true;
  };
}
