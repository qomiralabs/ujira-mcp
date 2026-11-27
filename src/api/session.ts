// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The session side of /v1 authentication: the cookie, the origin check on
// writes, and the mapping of sign in refusals onto the error envelope.
//
// A write that carries the session cookie must come from the app's own
// origin. SameSite=Lax already keeps the cookie off most cross site requests;
// this is the second lock, and it runs before the session is looked up, so a
// forged request costs no database call.

import { getCookie } from 'hono/cookie';

import { SignInError, type ActiveSession, type SignIn } from '../auth/sign-in.js';
import { SESSION_COOKIE } from '../auth/session-token.js';
import type { V1Bindings, V1Context } from './context.js';
import { ApiError } from './errors.js';

/** A rate limited caller may try again after this many seconds; buckets refill every second. */
const RETRY_AFTER_SECONDS = '1';

export function toApiError(error: unknown): unknown {
  if (!(error instanceof SignInError)) return error;
  switch (error.code) {
    case 'ADDRESS_INVALID':
      return new ApiError('INVALID_REQUEST', 'The request does not match the schema', {
        details: [{ path: 'body.address', issue: 'invalid_address' }],
      });
    case 'RATE_LIMITED':
      return new ApiError('RATE_LIMITED', 'Too many sign in attempts; try again shortly', {
        headers: { 'retry-after': RETRY_AFTER_SECONDS },
      });
    case 'SESSION_INVALID':
      return new ApiError('SESSION_INVALID', 'Sign in again');
  }
}

/** Runs sign in work and answers its refusals as /v1 errors. */
export async function signInCall<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw toApiError(error);
  }
}

/** The caller's rate limit key from the Node server, or one shared key when run without it. */
export function clientOf(c: V1Context): string {
  const env = c.env as V1Bindings | undefined;
  return env?.client ?? 'unknown';
}

/** Refuses a request whose Origin is not the app's. Browsers send Origin on every write. */
export function requireAppOrigin(c: V1Context, origin: string): void {
  if (c.req.header('origin') !== origin) {
    throw new ApiError('ORIGIN_NOT_ALLOWED', 'This request must come from the UJIRA app');
  }
}

export interface SessionOptions {
  readonly signIn: SignIn;
  readonly origin: string;
}

/**
 * The live session behind the request's cookie. Writes check the origin
 * first. `projectId` is the project the request names, or null for routes
 * about the person rather than a project.
 */
export async function requireSession(
  c: V1Context,
  o: SessionOptions,
  options: { readonly write: boolean; readonly projectId?: string | null },
): Promise<ActiveSession> {
  if (options.write) requireAppOrigin(c, o.origin);
  return signInCall(() =>
    o.signIn.resolve(getCookie(c, SESSION_COOKIE), options.projectId ?? null),
  );
}
