// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// Sign in with a wallet, sign out, and who is signed in. The session secret
// travels only in the Set-Cookie header, HttpOnly, Secure and SameSite=Lax,
// so page scripts never see it, and only its hash is stored.

import { deleteCookie, setCookie } from 'hono/cookie';
import { z } from 'zod';

import { SESSION_COOKIE, SESSION_COOKIE_PATH } from '../../auth/session-token.js';
import type { SignIn } from '../../auth/sign-in.js';
import type { V1Context } from '../context.js';
import { defineRoute, type Route } from '../route.js';
import { clientOf, requireAppOrigin, requireSession, signInCall } from '../session.js';

export interface AuthRouteOptions {
  readonly signIn: SignIn;
  /** The app origin, such as https://ujira.co. */
  readonly origin: string;
  readonly now?: () => Date;
}

const address = z.string().min(1).max(128);

const challengeBody = z.object({ address }).strict();
const challengeResponse = z
  .object({ challengeId: z.string(), message: z.string(), expiresAt: z.string() })
  .strict();

const sessionBody = z
  .object({
    challengeId: z.uuid(),
    address,
    // A 64 byte signature in base64 or hex; the verifier checks which.
    signature: z.string().min(1).max(256),
  })
  .strict();

const principalView = z.object({ id: z.string(), name: z.string(), role: z.string() }).strict();

/** Who is signed in and the principals they may act for, as the console reads it. */
export const sessionInfoSchema = z
  .object({
    member: z.object({ id: z.string(), address: z.string() }).strict(),
    principals: z.array(principalView),
  })
  .strict();

const COOKIE_BASE = {
  path: SESSION_COOKIE_PATH,
  httpOnly: true,
  secure: true,
  sameSite: 'Lax',
} as const;

function principalsView(list: readonly { principalId: string; name: string; role: string }[]) {
  return list.map((p) => ({ id: p.principalId, name: p.name, role: p.role }));
}

function requestIdOf(c: V1Context): string {
  return c.get('requestId');
}

export function authRoutes(o: AuthRouteOptions): Route[] {
  const now = o.now ?? (() => new Date());
  const session = { signIn: o.signIn, origin: o.origin };

  const challenge = defineRoute({
    method: 'post',
    path: '/v1/auth/challenge',
    operationId: 'createSignInChallenge',
    summary: 'Get a one time message for a wallet to sign',
    description:
      'The message names this site and lapses after 10 minutes. It can be traded for a session once.',
    tags: ['auth'],
    body: challengeBody,
    status: 201,
    response: challengeResponse,
    errors: ['RATE_LIMITED', 'DB_UNAVAILABLE'],
    handler: ({ body }, c) => signInCall(() => o.signIn.challenge(body.address, clientOf(c))),
  });

  const start = defineRoute({
    method: 'post',
    path: '/v1/auth/session',
    operationId: 'startSession',
    summary: 'Trade a signed challenge for a session',
    description:
      'Sets the ujira_session cookie. A reused, lapsed or wrongly signed challenge answers SESSION_INVALID.',
    tags: ['auth'],
    body: sessionBody,
    response: sessionInfoSchema,
    errors: ['SESSION_INVALID', 'ORIGIN_NOT_ALLOWED', 'RATE_LIMITED', 'DB_UNAVAILABLE'],
    handler: async ({ body }, c) => {
      // Signing someone in from another site is a write too: it would put a
      // browser in an account the attacker chose.
      requireAppOrigin(c, o.origin);
      const started = await signInCall(() =>
        o.signIn.startSession(body, clientOf(c), requestIdOf(c)),
      );
      const maxAge = Math.floor((started.absoluteExpiresAt.getTime() - now().getTime()) / 1000);
      setCookie(c, SESSION_COOKIE, started.token, { ...COOKIE_BASE, maxAge });
      return {
        member: { id: started.memberId, address: started.address },
        principals: principalsView(started.principals),
      };
    },
  });

  const end = defineRoute({
    method: 'delete',
    path: '/v1/auth/session',
    operationId: 'endSession',
    summary: 'Sign out',
    description: 'Ends the session for good and clears the cookie.',
    tags: ['auth'],
    response: z.object({ signedOut: z.literal(true) }).strict(),
    errors: ['SESSION_INVALID', 'ORIGIN_NOT_ALLOWED', 'DB_UNAVAILABLE'],
    handler: async (_input, c) => {
      const active = await requireSession(c, session, { write: true });
      await signInCall(() => o.signIn.signOut(active, requestIdOf(c)));
      deleteCookie(c, SESSION_COOKIE, COOKIE_BASE);
      return { signedOut: true as const };
    },
  });

  const me = defineRoute({
    method: 'get',
    path: '/v1/me',
    operationId: 'getMe',
    summary: 'Who is signed in',
    tags: ['auth'],
    response: sessionInfoSchema,
    errors: ['SESSION_INVALID', 'DB_UNAVAILABLE'],
    handler: async (_input, c) => {
      const active = await requireSession(c, session, { write: false });
      const principals = await o.signIn.principals(active);
      return {
        member: { id: active.memberId, address: active.walletAddress },
        principals: principalsView(principals),
      };
    },
  });

  return [challenge, start, end, me];
}
