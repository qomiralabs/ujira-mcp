// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// Embed sessions, the pages a project lets the widget run on, and the one
// lookup that finds a session by its token before any tenant is known. As
// everywhere, no tenant method takes a tenant id: the transaction's context is
// the only tenant any query here runs under.

import { sql, type Kysely } from 'kysely';

import type { Schema } from '../schema.js';
import { PAGE_TIME, olderThan, pageKey } from './newest-first.js';
import { checkedLimit, pageOf, type Page, type PageRequest } from './page.js';
import { RepositoryInputError } from './values.js';

type Tx = Kysely<Schema>;

const CURRENT_PRINCIPAL = sql<string>`ujira.current_principal_id()`;
const CURRENT_PROJECT = sql<string>`ujira.current_project_id()`;

/** The bounds the database holds a session's lifetime to, in seconds. */
export const EMBED_SESSION_MIN_SECONDS = 5 * 60;
export const EMBED_SESSION_MAX_SECONDS = 7 * 24 * 60 * 60;

/** The most origins a project may list, as the database holds it. */
export const MAX_EMBED_ORIGINS = 10;

export interface EmbedSession {
  readonly id: string;
  readonly projectId: string;
  readonly recipientId: string;
  readonly expiresAt: Date;
  readonly revokedAt: Date | null;
  readonly createdAt: Date;
}

export interface NewEmbedSession {
  readonly recipientId: string;
  // SHA-256 of the token's secret, 32 bytes. The token itself never comes here.
  readonly tokenSha256: Buffer;
  // Counted from the database's clock, so the expiry and the creation time
  // come from one clock.
  readonly lifetimeSeconds: number;
}

export interface EmbedSessionFilter extends PageRequest {
  readonly recipientId?: string | undefined;
}

/** A live session as its token finds it, before any tenant is known. */
export interface ResolvedEmbedSession {
  readonly sessionId: string;
  readonly principalId: string;
  readonly projectId: string;
  readonly recipientId: string;
  readonly expiresAt: Date;
  readonly allowedOrigins: readonly string[];
}

const columns = [
  'id',
  'project_id',
  'recipient_id',
  'expires_at',
  'revoked_at',
  'created_at',
] as const;

function toSession(row: {
  id: string;
  project_id: string;
  recipient_id: string;
  expires_at: Date;
  revoked_at: Date | null;
  created_at: Date;
}): EmbedSession {
  return {
    id: row.id,
    projectId: row.project_id,
    recipientId: row.recipient_id,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    createdAt: row.created_at,
  };
}

export const embedSessions = {
  // A recipient outside the transaction's project fails its key, 23503. A
  // lifetime outside the bounds is refused here, before the row's check would.
  create: async (db: Tx, input: NewEmbedSession): Promise<EmbedSession> => {
    const seconds = input.lifetimeSeconds;
    if (
      !Number.isSafeInteger(seconds) ||
      seconds < EMBED_SESSION_MIN_SECONDS ||
      seconds > EMBED_SESSION_MAX_SECONDS
    ) {
      throw new RepositoryInputError('lifetimeSeconds');
    }
    if (input.tokenSha256.length !== 32) throw new RepositoryInputError('tokenSha256');
    const row = await db
      .insertInto('ujira.embed_sessions')
      .values({
        principal_id: CURRENT_PRINCIPAL,
        project_id: CURRENT_PROJECT,
        recipient_id: input.recipientId,
        token_sha256: input.tokenSha256,
        expires_at: sql<Date>`now() + make_interval(secs => ${seconds}::integer)`,
      })
      .returning(columns)
      .executeTakeFirstOrThrow();
    return toSession(row);
  },

  get: async (db: Tx, id: string): Promise<EmbedSession | undefined> => {
    const row = await db
      .selectFrom('ujira.embed_sessions')
      .select(columns)
      .where('id', '=', id)
      .executeTakeFirst();
    return row === undefined ? undefined : toSession(row);
  },

  // Newest first, optionally of one recipient.
  list: async (db: Tx, filter: EmbedSessionFilter): Promise<Page<EmbedSession>> => {
    const limit = checkedLimit(filter.limit);
    let query = db
      .selectFrom('ujira.embed_sessions')
      .select([...columns, PAGE_TIME.as('page_time')])
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(limit + 1);
    if (filter.recipientId !== undefined) {
      query = query.where('recipient_id', '=', filter.recipientId);
    }
    if (filter.after !== undefined) query = query.where(olderThan(filter.after));
    const rows = await query.execute();
    const page = pageOf(rows, limit, pageKey);
    return { items: page.items.map(toSession), next: page.next };
  },

  // The session after the call: revoked now, or as it was when it was already
  // revoked, so a repeat changes nothing. Undefined when there is no such
  // session in the transaction's project.
  revoke: async (db: Tx, id: string): Promise<EmbedSession | undefined> => {
    const row = await db
      .updateTable('ujira.embed_sessions')
      .set({ revoked_at: sql<Date>`now()` })
      .where('id', '=', id)
      .where('revoked_at', 'is', null)
      .returning(columns)
      .executeTakeFirst();
    if (row !== undefined) return toSession(row);
    return embedSessions.get(db, id);
  },
};

export const embedSettings = {
  // The pages the project lists, oldest entry first. Empty when it lists none.
  allowedOrigins: async (db: Tx): Promise<string[]> => {
    const row = await db
      .selectFrom('ujira.embed_settings')
      .select('allowed_origins')
      .executeTakeFirst();
    return row === undefined ? [] : [...row.allowed_origins];
  },

  // Replaces the whole list. One the database's check refuses is 23514; more
  // than it holds is refused here first.
  setAllowedOrigins: async (db: Tx, origins: readonly string[]): Promise<string[]> => {
    if (origins.length > MAX_EMBED_ORIGINS) throw new RepositoryInputError('origins');
    const list = sql<string[]>`${[...origins]}::text[]`;
    const row = await db
      .insertInto('ujira.embed_settings')
      .values({
        principal_id: CURRENT_PRINCIPAL,
        project_id: CURRENT_PROJECT,
        allowed_origins: list,
      })
      .onConflict((conflict) =>
        conflict
          .columns(['principal_id', 'project_id'])
          .doUpdateSet((eb) => ({ allowed_origins: eb.ref('excluded.allowed_origins') })),
      )
      .returning('allowed_origins')
      .executeTakeFirstOrThrow();
    return [...row.allowed_origins];
  },
};

// The lookup, inside db.unscoped(), since the token is how the tenant is found.
export const embedTokens = {
  resolve: async (db: Tx, secretSha256: Buffer): Promise<ResolvedEmbedSession | undefined> => {
    const result = await sql<{
      session_id: string;
      principal_id: string;
      project_id: string;
      recipient_id: string;
      expires_at: Date;
      allowed_origins: string[];
    }>`
      select session_id, principal_id, project_id, recipient_id, expires_at, allowed_origins
        from ujira.embed_session_resolve(${secretSha256})
    `.execute(db);
    const row = result.rows[0];
    if (row === undefined) return undefined;
    return {
      sessionId: row.session_id,
      principalId: row.principal_id,
      projectId: row.project_id,
      recipientId: row.recipient_id,
      expiresAt: row.expires_at,
      allowedOrigins: row.allowed_origins,
    };
  },
};

// The daily prune, as the worker. Each call removes one batch and says how
// many, so the job calls again until it says none.
export const embedRetention = {
  deleteExpired: async (db: Tx, batchSize: number): Promise<number> => {
    const result = await sql<{ removed: number }>`
      select ujira.embed_sessions_delete_expired(${batchSize}::integer)::integer as removed
    `.execute(db);
    return result.rows[0]?.removed ?? 0;
  },
};

// For the cross-tenant matrix, which requires a case for each method here.
export const embedRepositories = { embedSessions, embedSettings } as const;
