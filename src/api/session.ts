// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The session side of /v1 authentication: the cookie, the origin check on
// writes, the project a request names and the role it holds there, and the
// mapping of sign in refusals onto the error envelope.
//
// A write that carries the session cookie must come from the app's own
// origin. SameSite=Lax already keeps the cookie off most cross site requests;
// this is the second lock, and it runs before the session is looked up, so a
// forged request costs no database call.

import { getCookie } from 'hono/cookie';

import { SignInError, type ActiveSession, type SignIn } from '../auth/sign-in.js';
import { SESSION_COOKIE } from '../auth/session-token.js';
import type { ProjectContext } from '../db/index.js';
import { can, type Permission } from '../tenancy/roles.js';
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

/** The header a session request names its project in. Hono reads headers case blind. */
export const PROJECT_HEADER = 'Ujira-Project';

// Any case on the wire, one spelling inside: the tenant context accepts only
// lower case, and two spellings of one id must not look like two projects.
const PROJECT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Who is asking, in which project, with which role, as a session route sees them. */
export interface ProjectCaller extends ProjectContext {
  readonly memberId: string;
  readonly role: string;
  readonly session: ActiveSession;
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

/**
 * The session and the project the request names in Ujira-Project, checked
 * against the person's membership and role before any handler runs. The
 * handler then opens its tenant transaction with the context this returns.
 *
 * In order: a write from another origin is 403, no live session is 401, a
 * missing or malformed header is 400, a project the person cannot reach is
 * 404 whether or not it exists, and a role without the permission is 403.
 * The session is looked up before the header is judged, so a caller who is
 * not signed in always gets the same answer.
 */
export async function requireProjectSession(
  c: V1Context,
  o: SessionOptions,
  options: { readonly write: boolean; readonly permission: Permission },
): Promise<ProjectCaller> {
  const raw = c.req.header(PROJECT_HEADER)?.trim();
  const projectId = raw !== undefined && PROJECT_ID.test(raw) ? raw.toLowerCase() : null;
  const session = await requireSession(c, o, { write: options.write, projectId });
  if (projectId === null) {
    throw new ApiError('INVALID_REQUEST', 'Name a project in the Ujira-Project header', {
      details: [
        { path: 'header.ujira-project', issue: raw === undefined ? 'required' : 'invalid' },
      ],
    });
  }
  const access = session.access;
  if (access?.projectId !== projectId) throw new ApiError('NOT_FOUND', 'No such project');
  if (!can(access.role, options.permission)) {
    throw new ApiError('FORBIDDEN', 'Your role cannot do this in this project');
  }
  return {
    principalId: access.principalId,
    projectId: access.projectId,
    memberId: session.memberId,
    role: access.role,
    session,
  };
}

/**
 * The `authenticate` of a session write defined with defineIdempotentRoute:
 * the key is stored under the project this finds, and only after these
 * checks pass.
 */
export function sessionAuthenticator(
  o: SessionOptions,
  permission: Permission = 'write',
): (c: V1Context) => Promise<ProjectCaller> {
  return (c) => requireProjectSession(c, o, { write: true, permission });
}
