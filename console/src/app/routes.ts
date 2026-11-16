// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The dashboard lives under one path prefix (Vite's base, /app in the build)
// and routes on the path, so every page has a plain URL a person can share.

export type PageName =
  | 'overview'
  | 'mandates'
  | 'new'
  | 'mandate'
  | 'approvals'
  | 'payouts'
  | 'receipts'
  | 'recipients'
  | 'developers'
  | 'local-currency'
  | 'team'
  | 'activity'
  | 'not-found';

export type Route =
  | { readonly name: Exclude<PageName, 'mandate'> }
  | { readonly name: 'mandate'; readonly id: string };

/** "/app" in the build, "" when served from the root. Never ends in a slash. */
export const BASE_PATH = import.meta.env.BASE_URL.replace(/\/+$/, '');

const SIMPLE: Readonly<Record<string, Exclude<PageName, 'mandate' | 'not-found'>>> = {
  '/': 'overview',
  '/mandates': 'mandates',
  '/mandates/new': 'new',
  '/approvals': 'approvals',
  '/payouts': 'payouts',
  '/receipts': 'receipts',
  '/recipients': 'recipients',
  '/developers': 'developers',
  '/local-currency': 'local-currency',
  '/team': 'team',
  '/activity': 'activity',
};

const MANDATE_PATH = /^\/mandates\/([A-Z0-9]{56})$/;

/** The page for a location path, with the base prefix taken off first. */
export function parsePath(pathname: string, base: string = BASE_PATH): Route {
  let rest = pathname;
  if (base !== '' && (rest === base || rest.startsWith(`${base}/`))) rest = rest.slice(base.length);
  rest = rest.replace(/\/+$/, '');
  if (rest === '' || rest === '/index.html') rest = '/';
  const simple = SIMPLE[rest];
  if (simple !== undefined) return { name: simple };
  const m = MANDATE_PATH.exec(rest);
  if (m?.[1] !== undefined) return { name: 'mandate', id: m[1] };
  return { name: 'not-found' };
}

/** The path inside the dashboard for a route, without the base prefix. */
export function pathOf(route: Route): string {
  switch (route.name) {
    case 'overview':
    case 'not-found':
      return '/';
    case 'new':
      return '/mandates/new';
    case 'mandate':
      return `/mandates/${route.id}`;
    default:
      return `/${route.name}`;
  }
}

/** Mock mode lives in the query string, so it follows the person from page to page. */
export function keptQuery(search: string = location.search): string {
  return new URLSearchParams(search).get('mock') === '1' ? '?mock=1' : '';
}

/** The full href for a dashboard path such as "/mandates". */
export function hrefFor(path: string, search?: string, base: string = BASE_PATH): string {
  const full = path === '/' || path === '' ? (base === '' ? '/' : base) : `${base}${path}`;
  return `${full}${keptQuery(search)}`;
}

/**
 * The console used hash routes (#/new, #/m/<id>). Links shared before the
 * move keep working: this returns the path they meant, or null.
 */
export function legacyHashPath(hash: string): string | null {
  const h = hash.replace(/^#/, '');
  if (h === '' || !h.startsWith('/')) return null;
  if (h === '/') return '/';
  if (h === '/new') return '/mandates/new';
  const m = /^\/m\/([A-Z0-9]{56})\/?$/.exec(h);
  if (m?.[1] !== undefined) return `/mandates/${m[1]}`;
  return null;
}

/** Rewrites an old hash link in place, before the first render. */
export function migrateLegacyHash(): void {
  const path = legacyHashPath(location.hash);
  if (path === null) return;
  history.replaceState(null, '', hrefFor(path));
}
