// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// Every page on the one domain: the marketing site at the root, the
// Instaward proof page, the dashboard app under /app, and the embed widget
// under /embed/v1/. The API and the MCP routes are answered before a request
// gets here, so nothing below can change them.
//
// Links to where these pages used to live keep working through permanent
// redirects. With a canonical host set, a page asked for on any other host
// (the platform URL, www) moves to the canonical one, while the API, MCP and
// the widget keep answering everywhere so connectors and pages already
// pointed at an old host do not break.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join } from 'node:path';

import {
  CACHE_EMBED,
  CACHE_IMMUTABLE,
  CACHE_REVALIDATE,
  CACHE_SHORT,
  EMBED_HEADERS,
  SECURITY_HEADERS,
  cleanPath,
  fileIn,
  isFile,
  sendFile,
} from './static.js';

export interface WebOptions {
  /** The marketing site: index.html, instaward.html, assets/, data/, 404.html. */
  readonly siteDir: string;
  /** The built dashboard app, served under /app. */
  readonly appDir: string;
  /** The built embed widget, ujira-embed.js, served under /embed/v1/. */
  readonly embedDir: string;
  /** Pages on any other host redirect here; unset leaves every host as it is. */
  readonly canonicalHost?: string;
}

export const APP_BASE = '/app';

/** The widget's path carries its major version; a breaking change is v2, beside v1. */
export const EMBED_BASE = '/embed/v1/';

/** One script file name directly under the versioned folder, nothing deeper. */
const EMBED_FILE = /^[a-z0-9][a-z0-9-]*\.js$/;

/** Site folders served as they are. Everything else at the root is a named page or 404. */
const SITE_FOLDERS = ['/assets/', '/data/'];
const SITE_ROOT_FILES = new Set(['/favicon.svg', '/favicon.ico', '/robots.txt']);
/** Dashboard sections, in case anyone linked one at the root. */
const DASHBOARD_SECTION =
  /^\/(?:mandates|approvals|payouts|receipts|recipients|developers)(?:\/.*)?$/;

const FALLBACK_404 =
  '<!doctype html><html lang="en"><meta charset="utf-8"><title>Page not found | UJIRA</title>' +
  '<h1>Page not found</h1><p><a href="/">UJIRA</a> | <a href="/app">Dashboard</a></p></html>';

/**
 * Where an old link now lives, as a path with no query, or undefined when the
 * path is current. Only fixed prefixes are ever produced, so a redirect never
 * leaves this origin.
 */
export function movedTo(path: string, query: URLSearchParams): string | undefined {
  switch (path) {
    case '/index.html':
      return '/';
    case '/instaward.html':
    case '/instaward/':
      return '/instaward';
    case '/app.html':
      return APP_BASE;
    case '/new':
      return `${APP_BASE}/mandates/new`;
    case '/':
      // The console used to live at the root, and its mock mode with it.
      return query.has('mock') ? APP_BASE : undefined;
    default:
      return DASHBOARD_SECTION.test(path) ? `${APP_BASE}${path}` : undefined;
  }
}

/** The host a request was sent to, lower case, without a trailing dot. */
function requestHost(req: IncomingMessage): string {
  return (req.headers.host ?? '')
    .trim()
    .toLowerCase()
    .replace(/\.(?=:\d+$|$)/, '');
}

export function isCanonicalHost(host: string, canonical: string): boolean {
  if (host === canonical) return true;
  // A canonical name without a port matches that name on any port.
  return !canonical.includes(':') && host.replace(/:\d{1,5}$/, '') === canonical;
}

/** Percent encodes anything outside printable ASCII, so it can go in a Location header. */
function headerSafe(raw: string): string {
  return raw.replace(/[^\x21-\x7e]/g, (c) => encodeURIComponent(c));
}

/** The raw query with its leading `?`, or an empty string. */
function queryOf(rawUrl: string): string {
  const at = rawUrl.indexOf('?');
  const query = at === -1 ? '' : headerSafe(rawUrl.slice(at + 1));
  return query === '' ? '' : `?${query}`;
}

function redirect(res: ServerResponse, location: string): void {
  res.writeHead(301, {
    location,
    'content-length': '0',
    // Short, so turning the canonical host off later takes effect for browsers within a day.
    'cache-control': 'public, max-age=86400',
    ...SECURITY_HEADERS,
  });
  res.end();
}

export function createWeb(o: WebOptions) {
  const appIndex = join(o.appDir, 'index.html');

  async function notFound(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const page = join(o.siteDir, '404.html');
    if (await isFile(page)) {
      await sendFile(req, res, page, CACHE_REVALIDATE, 404);
      return;
    }
    res.writeHead(404, {
      'content-type': 'text/html; charset=utf-8',
      'content-length': String(Buffer.byteLength(FALLBACK_404)),
      'cache-control': CACHE_REVALIDATE,
      ...SECURITY_HEADERS,
    });
    res.end(req.method === 'HEAD' ? undefined : FALLBACK_404);
  }

  /** A file from one folder with the given cache policy, or the 404 page. */
  async function fileOr404(
    req: IncomingMessage,
    res: ServerResponse,
    root: string,
    path: string,
    cache: string,
  ): Promise<void> {
    const file = fileIn(root, path);
    if (file === undefined || !(await isFile(file))) {
      await notFound(req, res);
      return;
    }
    await sendFile(req, res, file, cache);
  }

  /** The dashboard: real files as they are, any other page path to its index.html. */
  async function app(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
    const inner = path.slice(APP_BASE.length);
    const file = inner === '' || inner === '/' ? undefined : fileIn(o.appDir, inner);
    if (file !== undefined && (await isFile(file))) {
      const cache = inner.startsWith('/assets/')
        ? CACHE_IMMUTABLE
        : extname(file) === '.html'
          ? CACHE_REVALIDATE
          : CACHE_SHORT;
      await sendFile(req, res, file, cache);
      return;
    }
    // A missing script or image is a 404, never the app's HTML under the wrong type.
    if (inner.startsWith('/assets/') || extname(inner) !== '') {
      await notFound(req, res);
      return;
    }
    if (!(await isFile(appIndex))) {
      await notFound(req, res);
      return;
    }
    await sendFile(req, res, appIndex, CACHE_REVALIDATE);
  }

  /** The widget script, for a page on any origin; anything else under /embed is a 404. */
  async function embed(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
    const name = path.startsWith(EMBED_BASE) ? path.slice(EMBED_BASE.length) : '';
    const file = EMBED_FILE.test(name) ? fileIn(o.embedDir, `/${name}`) : undefined;
    if (file === undefined || !(await isFile(file))) {
      await notFound(req, res);
      return;
    }
    await sendFile(req, res, file, CACHE_EMBED, 200, EMBED_HEADERS);
  }

  return async (req: IncomingMessage, res: ServerResponse, rawPath: string): Promise<boolean> => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;
    const rawUrl = req.url ?? rawPath;
    const query = queryOf(rawUrl);
    const path = cleanPath(rawPath);
    // Before the canonical host: a page elsewhere that loads the widget from
    // an old host keeps working, and a script is never sent through a redirect.
    if (path !== undefined && (path === '/embed' || path.startsWith('/embed/'))) {
      await embed(req, res, path);
      return true;
    }
    const moved = path === undefined ? undefined : movedTo(path, new URLSearchParams(query));
    const canonical = o.canonicalHost;
    if (canonical !== undefined && !isCanonicalHost(requestHost(req), canonical)) {
      // One hop: an old link on an old host lands on its new page directly.
      // The host is ours and the path starts with a slash, so the redirect stays on it.
      const target = moved ?? (rawPath.startsWith('/') ? headerSafe(rawPath) : '/');
      redirect(res, `https://${canonical}${target}${query}`);
      return true;
    }
    if (path === undefined) {
      await notFound(req, res);
      return true;
    }
    if (moved !== undefined) {
      redirect(res, `${moved}${query}`);
      return true;
    }
    if (path === APP_BASE || path.startsWith(`${APP_BASE}/`)) {
      await app(req, res, path);
      return true;
    }
    if (path === '/') {
      await fileOr404(req, res, o.siteDir, '/index.html', CACHE_REVALIDATE);
      return true;
    }
    if (path === '/instaward') {
      await fileOr404(req, res, o.siteDir, '/instaward.html', CACHE_REVALIDATE);
      return true;
    }
    if (SITE_FOLDERS.some((f) => path.startsWith(f)) || SITE_ROOT_FILES.has(path)) {
      // Evidence files change with every run; images and scripts rarely do.
      const cache = path.startsWith('/data/') ? CACHE_REVALIDATE : CACHE_SHORT;
      await fileOr404(req, res, o.siteDir, path, cache);
      return true;
    }
    await notFound(req, res);
    return true;
  };
}
