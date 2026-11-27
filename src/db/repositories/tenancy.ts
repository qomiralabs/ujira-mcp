// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// Repository methods for the tenant roots. Each runs inside a transaction
// that db.tenant() or db.principal() opened, and none of them takes a tenant
// id: what a method can see and change is decided by the row level security
// policies against the transaction's context, and a new row takes its tenant
// from that context on the server. A caller holding another tenant's id gets
// nothing back with it; cross-tenant.test.ts runs every method here that
// way.

import { randomUUID } from 'node:crypto';

import { sql, type Kysely } from 'kysely';

import type { Schema } from '../schema.js';
import { checkedLimit, pageOf, type Page, type PageRequest } from './page.js';

type Tx = Kysely<Schema>;

const CURRENT_PRINCIPAL = sql<string>`ujira.current_principal_id()`;
const CURRENT_PROJECT = sql<string>`ujira.current_project_id()`;

export interface Principal {
  readonly id: string;
  readonly name: string;
  readonly reportingTimeZone: string;
  readonly createdAt: Date;
}

export interface Project {
  readonly id: string;
  readonly principalId: string;
  readonly name: string;
  readonly createdAt: Date;
}

export type MemberRole = 'owner' | 'admin' | 'developer' | 'viewer';
export type MemberStatus = 'active' | 'suspended' | 'removed';

// A person's membership of the transaction's principal. The member id is the
// person's, the same in every principal their wallet belongs to.
export interface Member {
  readonly memberId: string;
  readonly walletAddress: string;
  readonly role: MemberRole;
  readonly status: MemberStatus;
  readonly createdAt: Date;
}

export interface ApiToken {
  readonly id: string;
  readonly projectId: string;
  // Null only on a token made before tokens had names.
  readonly name: string | null;
  readonly prefix: string;
  readonly scopes: readonly string[];
  readonly expiresAt: Date;
  readonly revokedAt: Date | null;
  // The token this one replaced, in the same project, or null for a first one.
  readonly rotatedFromId: string | null;
  readonly lastUsedAt: Date | null;
  readonly createdAt: Date;
}

export interface NewApiToken {
  readonly name?: string;
  readonly prefix: string;
  // SHA-256 of the secret, 32 bytes. The secret itself never reaches here.
  readonly secretSha256: Buffer;
  readonly scopes: readonly string[];
  // Every token expires: rotation is the only way to keep one working.
  readonly expiresAt: Date;
  readonly rotatedFromId?: string;
}

const MEMBER_ROLES: ReadonlySet<string> = new Set<MemberRole>([
  'owner',
  'admin',
  'developer',
  'viewer',
]);

const MEMBER_STATUSES: ReadonlySet<string> = new Set<MemberStatus>([
  'active',
  'suspended',
  'removed',
]);

// The column checks make these unreachable unless the lists here and in the
// migration drift apart, which is worth failing loudly on.
function memberRole(value: string): MemberRole {
  if (!MEMBER_ROLES.has(value)) {
    throw new Error('a member row holds a role this code does not know');
  }
  return value as MemberRole;
}

function memberStatus(value: string): MemberStatus {
  if (!MEMBER_STATUSES.has(value)) {
    throw new Error('a member row holds a status this code does not know');
  }
  return value as MemberStatus;
}

const principalColumns = ['id', 'name', 'reporting_time_zone', 'created_at'] as const;

function toPrincipal(row: {
  id: string;
  name: string;
  reporting_time_zone: string;
  created_at: Date;
}): Principal {
  return {
    id: row.id,
    name: row.name,
    reportingTimeZone: row.reporting_time_zone,
    createdAt: row.created_at,
  };
}

export const principals = {
  // The transaction's own principal.
  current: async (db: Tx): Promise<Principal | undefined> => {
    const row = await db
      .selectFrom('ujira.principals')
      .select(principalColumns)
      .where('id', '=', CURRENT_PRINCIPAL)
      .executeTakeFirst();
    return row === undefined ? undefined : toPrincipal(row);
  },

  get: async (db: Tx, id: string): Promise<Principal | undefined> => {
    const row = await db
      .selectFrom('ujira.principals')
      .select(principalColumns)
      .where('id', '=', id)
      .executeTakeFirst();
    return row === undefined ? undefined : toPrincipal(row);
  },

  // True when the principal was found and changed. A zone the server does
  // not know is refused by the database with 22023.
  setReportingTimeZone: async (db: Tx, id: string, zone: string): Promise<boolean> => {
    const result = await db
      .updateTable('ujira.principals')
      .set({ reporting_time_zone: zone })
      .where('id', '=', id)
      .executeTakeFirst();
    return result.numUpdatedRows > 0n;
  },
};

const projectColumns = ['id', 'principal_id', 'name', 'created_at'] as const;

function toProject(row: {
  id: string;
  principal_id: string;
  name: string;
  created_at: Date;
}): Project {
  return { id: row.id, principalId: row.principal_id, name: row.name, createdAt: row.created_at };
}

export const projects = {
  list: async (db: Tx, page: PageRequest): Promise<Page<Project>> => {
    const limit = checkedLimit(page.limit);
    let query = db
      .selectFrom('ujira.projects')
      .select(projectColumns)
      .orderBy('id')
      .limit(limit + 1);
    if (page.after !== undefined) query = query.where('id', '>', page.after);
    return pageOf((await query.execute()).map(toProject), limit, (project) => project.id);
  },

  get: async (db: Tx, id: string): Promise<Project | undefined> => {
    const row = await db
      .selectFrom('ujira.projects')
      .select(projectColumns)
      .where('id', '=', id)
      .executeTakeFirst();
    return row === undefined ? undefined : toProject(row);
  },

  // A new project of the transaction's principal. The id is made here unless
  // the caller brings one: the transaction's project scope cannot read a
  // different project back, so the insert returns nothing. A caller that
  // opened its transaction naming the new id can read it, and write the
  // project's first rows, in that same transaction.
  create: async (
    db: Tx,
    input: { readonly name: string; readonly id?: string },
  ): Promise<string> => {
    const id = input.id ?? randomUUID();
    await db
      .insertInto('ujira.projects')
      .values({ id, name: input.name, principal_id: CURRENT_PRINCIPAL })
      .execute();
    return id;
  },

  rename: async (db: Tx, id: string, name: string): Promise<boolean> => {
    const result = await db
      .updateTable('ujira.projects')
      .set({ name })
      .where('id', '=', id)
      .executeTakeFirst();
    return result.numUpdatedRows > 0n;
  },
};

const memberColumns = ['member_id', 'wallet_address', 'role', 'status', 'created_at'] as const;

function toMember(row: {
  member_id: string;
  wallet_address: string;
  role: string;
  status: string;
  created_at: Date;
}): Member {
  return {
    memberId: row.member_id,
    walletAddress: row.wallet_address,
    role: memberRole(row.role),
    status: memberStatus(row.status),
    createdAt: row.created_at,
  };
}

export const members = {
  list: async (db: Tx, page: PageRequest): Promise<Page<Member>> => {
    const limit = checkedLimit(page.limit);
    let query = db
      .selectFrom('ujira.principal_members')
      .select(memberColumns)
      .orderBy('member_id')
      .limit(limit + 1);
    if (page.after !== undefined) query = query.where('member_id', '>', page.after);
    return pageOf((await query.execute()).map(toMember), limit, (member) => member.memberId);
  },

  get: async (db: Tx, memberId: string): Promise<Member | undefined> => {
    const row = await db
      .selectFrom('ujira.principal_members')
      .select(memberColumns)
      .where('member_id', '=', memberId)
      .executeTakeFirst();
    return row === undefined ? undefined : toMember(row);
  },

  // Adds a wallet to the transaction's principal. The app cannot write the
  // person's row, so the database function finds or makes it and the
  // membership together. A wallet already in the principal is refused, 23505.
  add: async (
    db: Tx,
    input: { readonly walletAddress: string; readonly role: MemberRole },
  ): Promise<Member> => {
    const added = await sql<{ member_id: string }>`
      select ujira.add_member(${input.walletAddress}, ${input.role}) as member_id
    `.execute(db);
    const memberId = added.rows[0]?.member_id;
    if (memberId === undefined) throw new Error('add_member returned no row');
    const member = await members.get(db, memberId);
    if (member === undefined) throw new Error('a member just added cannot be read back');
    return member;
  },

  changeRole: async (db: Tx, memberId: string, role: MemberRole): Promise<boolean> => {
    const result = await db
      .updateTable('ujira.principal_members')
      .set({ role })
      .where('member_id', '=', memberId)
      .executeTakeFirst();
    return result.numUpdatedRows > 0n;
  },

  // Suspending or removing someone ends their sessions' access to this
  // principal on their next request; the row stays.
  setStatus: async (db: Tx, memberId: string, status: MemberStatus): Promise<boolean> => {
    const result = await db
      .updateTable('ujira.principal_members')
      .set({ status })
      .where('member_id', '=', memberId)
      .executeTakeFirst();
    return result.numUpdatedRows > 0n;
  },
};

const tokenColumns = [
  'id',
  'project_id',
  'name',
  'prefix',
  'scopes',
  'expires_at',
  'revoked_at',
  'rotated_from_id',
  'last_used_at',
  'created_at',
] as const;

function toToken(row: {
  id: string;
  project_id: string;
  name: string | null;
  prefix: string;
  scopes: string[];
  expires_at: Date;
  revoked_at: Date | null;
  rotated_from_id: string | null;
  last_used_at: Date | null;
  created_at: Date;
}): ApiToken {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    prefix: row.prefix,
    scopes: row.scopes,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    rotatedFromId: row.rotated_from_id,
    lastUsedAt: row.last_used_at,
    createdAt: row.created_at,
  };
}

export const apiTokens = {
  list: async (db: Tx, page: PageRequest): Promise<Page<ApiToken>> => {
    const limit = checkedLimit(page.limit);
    let query = db
      .selectFrom('ujira.api_tokens')
      .select(tokenColumns)
      .orderBy('id')
      .limit(limit + 1);
    if (page.after !== undefined) query = query.where('id', '>', page.after);
    return pageOf((await query.execute()).map(toToken), limit, (token) => token.id);
  },

  get: async (db: Tx, id: string): Promise<ApiToken | undefined> => {
    const row = await db
      .selectFrom('ujira.api_tokens')
      .select(tokenColumns)
      .where('id', '=', id)
      .executeTakeFirst();
    return row === undefined ? undefined : toToken(row);
  },

  create: async (db: Tx, input: NewApiToken): Promise<ApiToken> => {
    const row = await db
      .insertInto('ujira.api_tokens')
      .values({
        principal_id: CURRENT_PRINCIPAL,
        project_id: CURRENT_PROJECT,
        name: input.name ?? null,
        prefix: input.prefix,
        secret_sha256: input.secretSha256,
        scopes: [...input.scopes],
        expires_at: input.expiresAt,
        rotated_from_id: input.rotatedFromId ?? null,
      })
      .returning(tokenColumns)
      .executeTakeFirstOrThrow();
    return toToken(row);
  },

  // Undefined when the project already holds `limit` active tokens. A token in its
  // rotation overlap is not counted, because its successor is: rotating must work
  // at the limit, and it leaves the project with one key in use, as it had. Two
  // creates racing are put in order by the lock, so neither can count past the other.
  createWithinLimit: async (
    db: Tx,
    input: NewApiToken,
    limit: number,
  ): Promise<ApiToken | undefined> => {
    await sql`select pg_advisory_xact_lock(hashtextextended(ujira.current_project_id()::text, 178))`.execute(
      db,
    );
    const counted = await sql<{ active: number }>`
      select count(*)::integer as active
        from ujira.api_tokens as t
       where t.revoked_at is null
         and t.expires_at > now()
         and not exists (
           select 1 from ujira.api_tokens as successor where successor.rotated_from_id = t.id
         )
    `.execute(db);
    if ((counted.rows[0]?.active ?? 0) >= limit) return undefined;
    return apiTokens.create(db, input);
  },

  // Undefined when the token already has a successor, because the unique index
  // allows it only one. The caller has checked the old token is live.
  createSuccessor: async (
    db: Tx,
    input: NewApiToken & { readonly rotatedFromId: string },
  ): Promise<ApiToken | undefined> => {
    const row = await db
      .insertInto('ujira.api_tokens')
      .values({
        principal_id: CURRENT_PRINCIPAL,
        project_id: CURRENT_PROJECT,
        name: input.name ?? null,
        prefix: input.prefix,
        secret_sha256: input.secretSha256,
        scopes: [...input.scopes],
        expires_at: input.expiresAt,
        rotated_from_id: input.rotatedFromId,
      })
      .onConflict((conflict) =>
        conflict
          .columns(['principal_id', 'project_id', 'rotated_from_id'])
          .where('rotated_from_id', 'is not', null)
          .doNothing(),
      )
      .returning(tokenColumns)
      .executeTakeFirst();
    return row === undefined ? undefined : toToken(row);
  },

  successorOf: async (db: Tx, id: string): Promise<ApiToken | undefined> => {
    const row = await db
      .selectFrom('ujira.api_tokens')
      .select(tokenColumns)
      .where('rotated_from_id', '=', id)
      .executeTakeFirst();
    return row === undefined ? undefined : toToken(row);
  },

  // Only ever earlier: a rotation's overlap must not keep a token alive past the
  // expiry it was given. The token's expiry afterwards, or undefined if not found.
  shortenExpiry: async (db: Tx, id: string, expiresAt: Date): Promise<Date | undefined> => {
    const row = await db
      .updateTable('ujira.api_tokens')
      .set({ expires_at: sql<Date>`least(expires_at, ${expiresAt})` })
      .where('id', '=', id)
      .returning('expires_at')
      .executeTakeFirst();
    return row?.expires_at;
  },

  // Records use of a token, at most once per five minutes: the condition is here
  // so it holds across every instance, and a busy token costs no write. True when
  // this call was the one that wrote.
  touchLastUsed: async (db: Tx, id: string): Promise<boolean> => {
    const result = await db
      .updateTable('ujira.api_tokens')
      .set({ last_used_at: sql<Date>`now()` })
      .where('id', '=', id)
      .where((eb) =>
        eb.or([
          eb('last_used_at', 'is', null),
          eb('last_used_at', '<', sql<Date>`now() - interval '5 minutes'`),
        ]),
      )
      .executeTakeFirst();
    return result.numUpdatedRows > 0n;
  },

  // True when a live token was found and revoked. Revoking is permanent:
  // the database refuses to clear or move revoked_at once set (UJ006).
  revoke: async (db: Tx, id: string): Promise<boolean> => {
    const result = await db
      .updateTable('ujira.api_tokens')
      .set({ revoked_at: sql<Date>`now()` })
      .where('id', '=', id)
      .where('revoked_at', 'is', null)
      .executeTakeFirst();
    return result.numUpdatedRows > 0n;
  },
};

// Every tenant repository, for the cross-tenant matrix, which requires a
// case for each method listed here.
export const tenancyRepositories = {
  principals,
  projects,
  members,
  apiTokens,
} as const;
