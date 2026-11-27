// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// Screens move from /api to /v1 one at a time. The build names the ones that
// have moved in VITE_V1_SCREENS, a comma list such as "payouts,receipts", or
// "all". Every other screen stays on /api, so ujira.co keeps working while
// the server grows its /v1 routes. A moved screen also needs a signed in
// session, because /v1 answers nothing without one.

import type { V1Api } from '../lib/v1';
import { useApp } from './context';
import { useSession } from './session';

export const V1_SCREENS = [
  'overview',
  'mandates',
  'payouts',
  'approvals',
  'receipts',
  'recipients',
  'developers',
] as const;

export type V1Screen = (typeof V1_SCREENS)[number];

function isScreen(name: string): name is V1Screen {
  return (V1_SCREENS as readonly string[]).includes(name);
}

/** The screens a build moves to /v1. Names it does not know are left on /api. */
export function parseV1Screens(raw: string | undefined): ReadonlySet<V1Screen> {
  const names = (raw ?? '')
    .split(',')
    .map((n) => n.trim().toLowerCase())
    .filter((n) => n !== '');
  if (names.includes('all')) return new Set(V1_SCREENS);
  return new Set(names.filter(isScreen));
}

/**
 * The screens for this page load. In mock mode, where every client is a fake,
 * `?v1=mandates` adds screens too, so the browser flows can walk both paths
 * in one build. A live build only ever reads the build flag.
 */
export function v1ScreensFor(
  raw: string | undefined,
  mock: boolean,
  search: string = location.search,
): ReadonlySet<V1Screen> {
  const extra = mock ? (new URLSearchParams(search).get('v1') ?? '') : '';
  return parseV1Screens([raw ?? '', extra].join(','));
}

/** The /v1 client when this screen has moved and someone is signed in; null means use /api. */
export function useV1(screen: V1Screen): V1Api | null {
  const { v1, v1Screens } = useApp();
  const session = useSession();
  return v1 !== null && session !== null && v1Screens.has(screen) ? v1 : null;
}
