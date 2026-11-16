// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

import { afterEach, describe, expect, it } from 'vitest';

import {
  BASE_PATH,
  hrefFor,
  legacyHashPath,
  migrateLegacyHash,
  parsePath,
  pathOf,
  type Route,
} from './routes';

const ID = `C${'A'.repeat(55)}`;

describe('dashboard routes', () => {
  afterEach(() => {
    history.replaceState(null, '', '/app');
  });

  it('builds under /app', () => {
    expect(BASE_PATH).toBe('/app');
  });

  it.each<[string, Route]>([
    ['/app', { name: 'overview' }],
    ['/app/', { name: 'overview' }],
    ['/app/index.html', { name: 'overview' }],
    ['/app/mandates', { name: 'mandates' }],
    ['/app/mandates/', { name: 'mandates' }],
    ['/app/mandates/new', { name: 'new' }],
    [`/app/mandates/${ID}`, { name: 'mandate', id: ID }],
    ['/app/approvals', { name: 'approvals' }],
    ['/app/payouts', { name: 'payouts' }],
    ['/app/receipts', { name: 'receipts' }],
    ['/app/recipients', { name: 'recipients' }],
    ['/app/developers', { name: 'developers' }],
    ['/app/local-currency', { name: 'local-currency' }],
    ['/app/team', { name: 'team' }],
    ['/app/activity', { name: 'activity' }],
    ['/app/mandates/not-an-id', { name: 'not-found' }],
    ['/app/nothing-here', { name: 'not-found' }],
  ])('reads %s', (path, route) => {
    expect(parsePath(path, '/app')).toEqual(route);
  });

  it('does not mistake a longer prefix for the base', () => {
    expect(parsePath('/application', '/app')).toEqual({ name: 'not-found' });
  });

  it('works when served from the root', () => {
    expect(parsePath('/', '')).toEqual({ name: 'overview' });
    expect(parsePath('/approvals', '')).toEqual({ name: 'approvals' });
    expect(hrefFor('/', '', '')).toBe('/');
    expect(hrefFor('/payouts', '', '')).toBe('/payouts');
  });

  it('round trips every route through its path', () => {
    const routes: Route[] = [
      { name: 'overview' },
      { name: 'mandates' },
      { name: 'new' },
      { name: 'mandate', id: ID },
      { name: 'approvals' },
      { name: 'payouts' },
      { name: 'receipts' },
      { name: 'recipients' },
      { name: 'developers' },
      { name: 'local-currency' },
      { name: 'team' },
      { name: 'activity' },
    ];
    for (const r of routes) expect(parsePath(hrefFor(pathOf(r), ''), '/app')).toEqual(r);
  });

  it('keeps mock mode in every link and drops other query values', () => {
    expect(hrefFor('/', '?mock=1')).toBe('/app?mock=1');
    expect(hrefFor('/approvals', '?mock=1&x=2')).toBe('/app/approvals?mock=1');
    expect(hrefFor('/approvals', '?x=2')).toBe('/app/approvals');
  });

  it('turns old hash links into paths', () => {
    expect(legacyHashPath(`#/m/${ID}`)).toBe(`/mandates/${ID}`);
    expect(legacyHashPath('#/new')).toBe('/mandates/new');
    expect(legacyHashPath('#/')).toBe('/');
    expect(legacyHashPath('#main')).toBeNull();
    expect(legacyHashPath('')).toBeNull();
    expect(legacyHashPath('#/m/short')).toBeNull();
  });

  it('rewrites an old hash link in the address bar', () => {
    history.replaceState(null, '', `/app?mock=1#/m/${ID}`);
    migrateLegacyHash();
    expect(location.pathname).toBe(`/app/mandates/${ID}`);
    expect(location.search).toBe('?mock=1');
    expect(location.hash).toBe('');
  });
});
