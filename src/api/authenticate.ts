// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// One way in for every tenant route: an API key or a dashboard session, each
// resolved to exactly one principal and project. The tenant only ever comes
// from the credential. A key names its own project, so a header or a body that
// names another one changes nothing; a session names the project in
// Ujira-Project and is checked against the person's membership.
//
// A request that sends Authorization is judged as a key and nothing else: a
// bad key never falls back to a cookie the browser happened to send along.
//
// Route rules say what is needed: a scope, which a key must hold and a
// member's role must allow, or a dashboard session with a permission, for the
// routes that manage access itself and so must never be reachable with a key.

import type { ActiveSession } from '../auth/sign-in.js';
import type { ApiScope } from '../auth/scopes.js';
import type { TokenAuthenticator, TokenFailureCode } from '../auth/token-auth.js';
import type { ProjectContext } from '../db/index.js';
import { addLogContext } from '../log.js';
import type { Permission } from '../tenancy/roles.js';
import type { V1Context } from './context.js';
import { ApiError } from './errors.js';
import { requireProjectSession, type SessionOptions } from './session.js';

export interface KeyCaller extends ProjectContext {
  readonly kind: 'key';
  readonly tokenId: string;
  readonly scopes: readonly ApiScope[];
}

export interface SessionCaller extends ProjectContext {
  readonly kind: 'session';
  readonly memberId: string;
  readonly role: string;
  readonly session: ActiveSession;
}

/** Who is asking, as a tenant route's handler sees them. */
export type Caller = KeyCaller | SessionCaller;

/** A key with the scope, or a session whose role allows it; `key` refuses sessions. */
export interface ScopeAccess {
  readonly scope: ApiScope;
  readonly via?: 'either' | 'key';
}

/** A dashboard session whose role holds the permission. Keys are refused whatever they hold. */
export interface SessionAccess {
  readonly via: 'session';
  readonly permission: Permission;
}

export type Access = ScopeAccess | SessionAccess;

export interface AuthenticateOptions {
  readonly tokens: TokenAuthenticator;
  /** Left out while sign in is off; every session request is then SESSION_INVALID. */
  readonly session?: SessionOptions;
}

/** Turns an Access rule into the `authenticate` a route, idempotent or not, runs first. */
export interface Authenticate {
  (access: SessionAccess): (c: V1Context) => Promise<SessionCaller>;
  (access: Access): (c: V1Context) => Promise<Caller>;
}

const TOKEN_MESSAGES: Readonly<Record<TokenFailureCode, string>> = {
  TOKEN_MALFORMED: 'Send an API key as a Bearer token',
  TOKEN_INVALID: 'The API key is not valid',
  TOKEN_ENVIRONMENT_MISMATCH: 'This API key is for another environment',
  ORIGIN_NOT_ALLOWED: 'API keys are not accepted from a web page',
};

function isWrite(method: string): boolean {
  return method !== 'GET' && method !== 'HEAD';
}

/**
 * What a member's role must allow to act with a scope through a session, as a
 * key with that scope could. Reading is open to every member and changing
 * state is not open to viewers. Webhook endpoints decide where a project's
 * data goes, which is as sensitive as a key, so they go with managing keys.
 */
export function scopePermission(scope: ApiScope): Permission {
  if (scope.endsWith(':read')) return 'read';
  if (scope.endsWith(':manage')) return 'manage_keys';
  return 'write';
}

export function createAuthenticate(o: AuthenticateOptions): Authenticate {
  async function byKey(c: V1Context, access: Access, authorization: string): Promise<KeyCaller> {
    if (access.via === 'session') {
      throw new ApiError('FORBIDDEN', 'This takes a dashboard session, not an API key');
    }
    const result = await o.tokens.authenticate(
      { authorization, origin: c.req.header('origin') ?? null },
      c.get('requestId'),
    );
    if (!result.ok) throw new ApiError(result.code, TOKEN_MESSAGES[result.code]);
    const { tenant } = result;
    addLogContext({ principalId: tenant.principalId, projectId: tenant.projectId });
    if (!tenant.scopes.includes(access.scope)) {
      throw new ApiError('FORBIDDEN', 'This API key does not hold the scope this needs');
    }
    return {
      kind: 'key',
      principalId: tenant.principalId,
      projectId: tenant.projectId,
      tokenId: tenant.tokenId,
      scopes: tenant.scopes,
    };
  }

  // The project and role checks are the ones every session route makes, in
  // their order: origin, session, header, reach, role.
  async function bySession(c: V1Context, access: Access): Promise<SessionCaller> {
    if (access.via === 'key') throw new ApiError('TOKEN_MALFORMED', TOKEN_MESSAGES.TOKEN_MALFORMED);
    if (o.session === undefined) throw new ApiError('SESSION_INVALID', 'Sign in again');
    const caller = await requireProjectSession(c, o.session, {
      write: isWrite(c.req.method),
      permission: access.via === 'session' ? access.permission : scopePermission(access.scope),
    });
    addLogContext({ principalId: caller.principalId, projectId: caller.projectId });
    return { kind: 'session', ...caller };
  }

  function authenticate(access: SessionAccess): (c: V1Context) => Promise<SessionCaller>;
  function authenticate(access: Access): (c: V1Context) => Promise<Caller>;
  function authenticate(access: Access): (c: V1Context) => Promise<Caller> {
    return (c) => {
      const authorization = c.req.header('authorization');
      return authorization === undefined ? bySession(c, access) : byKey(c, access, authorization);
    };
  }
  return authenticate;
}
