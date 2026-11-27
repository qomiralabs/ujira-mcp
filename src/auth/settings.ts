// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// Whether wallet sign in is served. Off unless UJIRA_SIGN_IN=on, so turning
// it on is one deliberate change to the environment, and the dashboard only
// asks people to sign in once the server can actually take them.

import { EngineError } from '../errors.js';

type Env = Readonly<Record<string, string | undefined>>;

export type SignInSettings =
  | { readonly enabled: false }
  | {
      readonly enabled: true;
      /** The origin the console is served from; challenges name it and session writes must come from it. */
      readonly origin: string;
    };

function value(env: Env, name: string): string | undefined {
  const v = env[name]?.trim();
  return v === undefined || v === '' ? undefined : v;
}

function isLoopback(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

/** UJIRA_SIGN_IN on its own, for code that only needs to say whether sign in is on. */
export function signInEnabled(env: Env = process.env): boolean {
  const flag = value(env, 'UJIRA_SIGN_IN');
  if (flag === undefined || flag === 'off') return false;
  if (flag === 'on') return true;
  throw new EngineError('config_invalid', 'UJIRA_SIGN_IN must be on or off');
}

export function loadSignInSettings(env: Env = process.env): SignInSettings {
  if (!signInEnabled(env)) return { enabled: false };
  const raw = value(env, 'UJIRA_PUBLIC_ORIGIN');
  const refuse = () =>
    new EngineError(
      'config_invalid',
      'UJIRA_SIGN_IN=on needs UJIRA_PUBLIC_ORIGIN set to the https origin the console is served from',
    );
  if (raw === undefined || !URL.canParse(raw)) throw refuse();
  const url = new URL(raw);
  // Plain http only for a developer's own machine: the session cookie is Secure.
  const schemeOk =
    url.protocol === 'https:' || (url.protocol === 'http:' && isLoopback(url.hostname));
  if (!schemeOk || url.origin !== raw.replace(/\/$/, '')) throw refuse();
  return { enabled: true, origin: url.origin };
}
