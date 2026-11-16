// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// Reads files for the web pages. A URL path is decoded exactly once and
// checked before it is joined to a folder, and the joined path is checked
// again, so nothing outside the folder is ever read.

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
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml',
  '.map': 'application/json',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.webmanifest': 'application/manifest+json',
};

export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'strict-origin-when-cross-origin',
};

/** Hashed build output: the name changes whenever the content does. */
export const CACHE_IMMUTABLE = 'public, max-age=31536000, immutable';
/** Pages and data: always ask the server whether they changed. */
export const CACHE_REVALIDATE = 'no-cache';
/** Unhashed images and scripts: fresh within the hour after a deploy. */
export const CACHE_SHORT = 'public, max-age=3600';

export function contentType(file: string): string {
  return TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream';
}

export async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/**
 * The decoded form of a URL path, or undefined when it is not one a page may
 * have: bad escapes, a NUL, a backslash, or any segment starting with a dot
 * (so `..`, `.` and hidden files such as `.env` are all refused).
 */
export function cleanPath(urlPath: string): string | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return undefined;
  }
  if (!decoded.startsWith('/') || decoded.includes('\0') || decoded.includes('\\')) {
    return undefined;
  }
  return decoded.split('/').some((s) => s.startsWith('.')) ? undefined : decoded;
}

/** `decoded` joined to `root`, or undefined when that would leave it. Never decodes. */
export function fileIn(root: string, decoded: string): string | undefined {
  const target = normalize(join(root, decoded));
  const base = root.endsWith(sep) ? root : `${root}${sep}`;
  return target.startsWith(base) && target !== base ? target : undefined;
}

/** Writes one file, or a HEAD's headers for it, with the status and cache policy given. */
export async function sendFile(
  req: IncomingMessage,
  res: ServerResponse,
  file: string,
  cache: string,
  status = 200,
): Promise<void> {
  const body = await readFile(file);
  res.writeHead(status, {
    'content-type': contentType(file),
    'content-length': String(body.length),
    'cache-control': cache,
    ...SECURITY_HEADERS,
  });
  res.end(req.method === 'HEAD' ? undefined : body);
}
