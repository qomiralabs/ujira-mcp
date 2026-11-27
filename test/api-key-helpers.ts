// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// API keys on /v1 in memory: key rows that keep the database's rules (a
// project's own keys only, a limit on active keys, revoking once and for
// good, an audit entry with each change), sessions that resolve to the
// projects a person was given, and two probe routes that stand for the tenant
// routes still to come, one read and one idempotent write.

import { randomUUID } from 'node:crypto';

import { z } from 'zod';

import { createV1App, type V1App } from '../src/api/app.js';
import { createAuthenticate, type Authenticate } from '../src/api/authenticate.js';
import { memoryIdempotencyStore } from '../src/api/idempotency.js';
import { defineIdempotentRoute, defineRoute, type Route } from '../src/api/route.js';
import { apiKeyRoutes } from '../src/api/routes/api-keys.js';
import { authRoutes } from '../src/api/routes/auth.js';
import {
  API_KEY_MAX_ACTIVE,
  createApiKeyService,
  type ApiKeyRecords,
  type NewStoredKey,
  type StoredApiKey,
} from '../src/auth/api-key-service.js';
import { SESSION_COOKIE } from '../src/auth/session-token.js';
import { SignIn } from '../src/auth/sign-in.js';
import type { Tenant } from '../src/auth/scopes.js';
import {
  createTokenAuthenticator,
  type TokenAuthenticator,
  type TokenLookup,
  type TokenSecurityEvent,
  type TokenStore,
} from '../src/auth/token-auth.js';
import type { ProjectAccess, ResolvedSession } from '../src/db/index.js';
import {
  clientFor,
  MemorySignInStore,
  ORIGIN,
  signInWith,
  START,
  verifier,
  wallet,
  type Clock,
} from './sign-in-helpers.js';

interface KeyRow extends StoredApiKey {
  readonly principalId: string;
  readonly projectId: string;
  readonly secretSha256: Buffer;
  revokedAt: Date | null;
  lastUsedAt: Date | null;
  expiresAt: Date;
}

export interface AuditRow {
  readonly action: 'api_key.created' | 'api_key.revoked';
  readonly principalId: string;
  readonly projectId: string;
  readonly actorId: string;
  readonly targetId: string;
}

function inTenant(row: KeyRow, tenant: Tenant): boolean {
  return row.principalId === tenant.principalId && row.projectId === tenant.projectId;
}

function stored(row: KeyRow): StoredApiKey {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    scopes: [...row.scopes],
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
    lastUsedAt: row.lastUsedAt,
    createdAt: row.createdAt,
  };
}

export class MemoryKeys implements ApiKeyRecords, TokenStore {
  readonly rows = new Map<string, KeyRow>();
  readonly audit: AuditRow[] = [];
  readonly events: TokenSecurityEvent[] = [];
  finds = 0;
  touches = 0;
  /** When set, the lookup rejects with it, as an outage would. */
  findFails: Error | undefined;
  touchFails: Error | undefined;
  eventFails: Error | undefined;

  constructor(private readonly clock: Clock) {}

  create(tenant: Tenant, key: NewStoredKey, actorId: string): Promise<StoredApiKey | null> {
    const now = this.clock.now;
    const active = [...this.rows.values()].filter(
      (r) => inTenant(r, tenant) && r.revokedAt === null && r.expiresAt.getTime() > now,
    );
    if (active.length >= API_KEY_MAX_ACTIVE) return Promise.resolve(null);
    const row: KeyRow = {
      principalId: tenant.principalId,
      projectId: tenant.projectId,
      id: randomUUID(),
      name: key.name,
      prefix: key.prefix,
      secretSha256: key.secretSha256,
      scopes: [...key.scopes],
      expiresAt: key.expiresAt,
      revokedAt: null,
      lastUsedAt: null,
      createdAt: new Date(now),
    };
    this.rows.set(row.id, row);
    this.audit.push({ action: 'api_key.created', ...tenant, actorId, targetId: row.id });
    return Promise.resolve(stored(row));
  }

  list(
    tenant: Tenant,
    page: { readonly limit: number; readonly after?: string },
  ): Promise<{ items: StoredApiKey[]; next: string | null }> {
    const mine = [...this.rows.values()]
      .filter((r) => inTenant(r, tenant))
      .sort((a, b) => (a.id < b.id ? -1 : 1))
      .filter((r) => page.after === undefined || r.id > page.after);
    const items = mine.slice(0, page.limit);
    const last = items.at(-1);
    return Promise.resolve({
      items: items.map(stored),
      next: mine.length > page.limit && last !== undefined ? last.id : null,
    });
  }

  revoke(tenant: Tenant, id: string, actorId: string): Promise<StoredApiKey | undefined> {
    const row = this.rows.get(id);
    if (row === undefined || !inTenant(row, tenant)) return Promise.resolve(undefined);
    if (row.revokedAt === null) {
      row.revokedAt = new Date(this.clock.now);
      this.audit.push({ action: 'api_key.revoked', ...tenant, actorId, targetId: id });
    }
    return Promise.resolve(stored(row));
  }

  find(prefix: string): Promise<TokenLookup | undefined> {
    this.finds += 1;
    if (this.findFails !== undefined) return Promise.reject(this.findFails);
    const row = [...this.rows.values()].find((r) => r.prefix === prefix);
    if (row === undefined) return Promise.resolve(undefined);
    return Promise.resolve({
      tokenId: row.id,
      principalId: row.principalId,
      projectId: row.projectId,
      secretSha256: row.secretSha256,
      scopes: [...row.scopes],
      expiresAt: row.expiresAt,
      revokedAt: row.revokedAt,
    });
  }

  touchLastUsed(tenant: Tenant, tokenId: string): Promise<void> {
    this.touches += 1;
    if (this.touchFails !== undefined) return Promise.reject(this.touchFails);
    const row = this.rows.get(tokenId);
    if (row !== undefined && inTenant(row, tenant)) row.lastUsedAt = new Date(this.clock.now);
    return Promise.resolve();
  }

  recordSecurityEvent(event: TokenSecurityEvent): Promise<void> {
    if (this.eventFails !== undefined) return Promise.reject(this.eventFails);
    this.events.push(event);
    return Promise.resolve();
  }
}

/** Sessions that reach the projects a person was given, as session_resolve would. */
export class ProjectSignInStore extends MemorySignInStore {
  readonly access = new Map<string, ProjectAccess[]>();

  override async resolveSession(
    tokenSha256: Buffer,
    projectId?: string | null,
  ): Promise<ResolvedSession | undefined> {
    const resolved = await super.resolveSession(tokenSha256);
    if (resolved === undefined) return undefined;
    const reach =
      projectId === null || projectId === undefined
        ? null
        : ((this.access.get(resolved.memberId) ?? []).find((a) => a.projectId === projectId) ??
          null);
    return { ...resolved, access: reach };
  }
}

export interface Answer {
  readonly status: number;
  readonly json: Record<string, unknown> | undefined;
  readonly headers: Headers;
}

export interface RequestOptions {
  readonly body?: unknown;
  readonly cookie?: string;
  /** null sends no Origin header; left out sends the app's. */
  readonly origin?: string | null;
  readonly project?: string;
  readonly key?: string;
  readonly headers?: Readonly<Record<string, string>>;
}

export type Request = (method: string, path: string, o?: RequestOptions) => Promise<Answer>;

export function requestFor(app: V1App['app']): Request {
  return async (method, path, o = {}) => {
    const headers: Record<string, string> = { ...o.headers };
    if (o.body !== undefined) headers['content-type'] = 'application/json';
    // A platform calling with a key is a server, which sends no Origin.
    const origin = o.origin === undefined ? (o.key === undefined ? ORIGIN : null) : o.origin;
    if (origin !== null) headers['origin'] = origin;
    if (o.cookie !== undefined) headers['cookie'] = `${SESSION_COOKIE}=${o.cookie}`;
    if (o.project !== undefined) headers['ujira-project'] = o.project;
    if (o.key !== undefined) headers['authorization'] = `Bearer ${o.key}`;
    const res = await app.fetch(
      new globalThis.Request(`${ORIGIN}${path}`, {
        method,
        headers,
        ...(o.body === undefined ? {} : { body: JSON.stringify(o.body) }),
      }),
      { requestId: randomUUID(), client: '203.0.113.9' },
    );
    const text = await res.text();
    return {
      status: res.status,
      json: text === '' ? undefined : (JSON.parse(text) as Record<string, unknown>),
      headers: res.headers,
    };
  };
}

export function codeOf(answer: Answer): unknown {
  return (answer.json?.['error'] as { code?: unknown } | undefined)?.code;
}

const callerView = z
  .object({ kind: z.string(), principalId: z.string(), projectId: z.string() })
  .strict();

/** Stand ins for the tenant routes to come: one read for either credential, one key only, one idempotent write. */
export function probeRoutes(authenticate: Authenticate): Route[] {
  const view = (c: { kind: string; principalId: string; projectId: string }) => ({
    kind: c.kind,
    principalId: c.principalId,
    projectId: c.projectId,
  });
  return [
    defineRoute({
      method: 'get',
      path: '/v1/probe',
      operationId: 'probe',
      summary: 'Who is asking',
      response: callerView,
      handler: async (_input, c) => view(await authenticate({ scope: 'payouts:read' })(c)),
    }),
    defineRoute({
      method: 'get',
      path: '/v1/probe/key',
      operationId: 'probeKey',
      summary: 'Who is asking, with a key',
      response: callerView,
      handler: async (_input, c) =>
        view(await authenticate({ scope: 'payouts:read', via: 'key' })(c)),
    }),
    defineIdempotentRoute({
      method: 'post',
      path: '/v1/probe',
      operationId: 'probeWrite',
      summary: 'A write that needs payouts:write',
      body: z.object({ n: z.number() }).strict(),
      status: 202,
      response: callerView,
      idempotency: {
        store: memoryIdempotencyStore(),
        authenticate: authenticate({ scope: 'payouts:write' }),
        log: () => undefined,
      },
      handler: ({ idempotent }) => view(idempotent.caller),
    }),
  ];
}

export interface Member {
  readonly memberId: string;
  readonly principalId: string;
  readonly projectId: string;
  readonly cookie: string;
}

export interface KeysHarness {
  readonly clock: Clock;
  readonly sessions: ProjectSignInStore;
  readonly keys: MemoryKeys;
  readonly tokens: TokenAuthenticator;
  readonly lines: string[];
  readonly v1: V1App;
  readonly request: Request;
  /** A signed in member of a new project, or of `into` when given. */
  member(role: string, into?: { principalId: string; projectId: string }): Promise<Member>;
  /** Creates a key as an owner of the tenant; its whole text. */
  keyFor(
    owner: Member,
    scopes: readonly string[],
    extra?: Record<string, unknown>,
  ): Promise<string>;
}

export function keysHarness(o: { readonly environment?: 'test' | 'live' } = {}): KeysHarness {
  const clock: Clock = { now: START };
  const now = () => new Date(clock.now);
  const sessions = new ProjectSignInStore(clock);
  const keys = new MemoryKeys(clock);
  const lines: string[] = [];
  const log = (line: string) => {
    lines.push(line);
  };
  const environment = o.environment ?? 'test';
  const signIn = new SignIn({ store: sessions, verifier, origin: ORIGIN, log, now });
  const tokens = createTokenAuthenticator({ store: keys, environment, log, now });
  const service = createApiKeyService({
    records: keys,
    environment,
    onRevoked: (prefix) => {
      tokens.forget(prefix);
    },
    now,
  });
  const authenticate = createAuthenticate({ tokens, session: { signIn, origin: ORIGIN } });
  const v1 = createV1App({
    routes: [
      ...authRoutes({ signIn, origin: ORIGIN, now }),
      ...apiKeyRoutes({ keys: service, authenticate }),
      ...probeRoutes(authenticate),
    ],
    log,
  });
  const request = requestFor(v1.app);
  const call = clientFor(v1.app);

  async function member(
    role: string,
    into?: { principalId: string; projectId: string },
  ): Promise<Member> {
    const kp = wallet();
    const principalId = into?.principalId ?? randomUUID();
    const projectId = into?.projectId ?? randomUUID();
    sessions.grant(kp.publicKey(), { principalId, name: 'Acme', role });
    const memberId = sessions.members.get(kp.publicKey()) ?? '';
    sessions.access.set(memberId, [{ principalId, projectId, role }]);
    const { token } = await signInWith(call, kp, { client: randomUUID() });
    if (token === undefined) throw new Error('sign in failed in the harness');
    return { memberId, principalId, projectId, cookie: token };
  }

  async function keyFor(
    owner: Member,
    scopes: readonly string[],
    extra: Record<string, unknown> = {},
  ): Promise<string> {
    const created = await request('POST', '/v1/api-keys', {
      cookie: owner.cookie,
      project: owner.projectId,
      body: { name: 'Payroll runner', scopes, ...extra },
    });
    const secret = created.json?.['secret'];
    if (created.status !== 201 || typeof secret !== 'string') {
      throw new Error(`creating a key answered ${String(created.status)}`);
    }
    return secret;
  }

  return { clock, sessions, keys, tokens, lines, v1, request, member, keyFor };
}
