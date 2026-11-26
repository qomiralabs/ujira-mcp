// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// Wallet sign in and dashboard sessions, inside db.unscoped(), since a
// session is how a tenant context is found. Each call is one security
// definer function: no service role can read either table, and a session is
// reached only through the hash of its secret. The secret itself never comes
// here, and neither does a signature: the caller checks it between spending
// a challenge and creating the session.

import { sql, type Kysely } from 'kysely';

import type { Schema } from '../schema.js';

type Tx = Kysely<Schema>;

export interface NewChallenge {
  readonly walletAddress: string;
  // The exact text the wallet will sign.
  readonly message: string;
  // At most 600; the database refuses longer, 22023.
  readonly ttlSeconds: number;
}

export interface CreatedChallenge {
  readonly challengeId: string;
  readonly expiresAt: Date;
}

export interface NewSession {
  // SHA-256 of the cookie's secret, 32 bytes.
  readonly tokenSha256: Buffer;
  // The wallet whose signature the caller has checked.
  readonly walletAddress: string;
  readonly idleSeconds: number;
  readonly absoluteSeconds: number;
}

export interface CreatedSession {
  readonly sessionId: string;
  readonly memberId: string;
  readonly idleExpiresAt: Date;
  readonly absoluteExpiresAt: Date;
}

// What a project a request names resolves to for this person. Present only
// when they are an active member of the principal that owns it.
export interface ProjectAccess {
  readonly principalId: string;
  readonly projectId: string;
  readonly role: string;
}

export interface ResolvedSession {
  readonly sessionId: string;
  readonly memberId: string;
  readonly walletAddress: string;
  readonly idleExpiresAt: Date;
  readonly absoluteExpiresAt: Date;
  // Null when no project was named, or the person may not act in it: a
  // caller cannot tell an unknown project from another tenant's, and has no
  // need to.
  readonly access: ProjectAccess | null;
}

export interface SessionPrincipal {
  readonly principalId: string;
  readonly name: string;
  // A string rather than the member role type: a role added later still
  // signs in.
  readonly role: string;
}

export interface SessionProject {
  readonly projectId: string;
  readonly principalId: string;
  readonly name: string;
  readonly createdAt: Date;
}

export const authChallenges = {
  create: async (db: Tx, challenge: NewChallenge): Promise<CreatedChallenge> => {
    const result = await sql<{ challenge_id: string; expires_at: Date }>`
      select challenge_id, expires_at
        from ujira.auth_challenge_create(
          ${challenge.walletAddress}, ${challenge.message}, ${challenge.ttlSeconds}::integer
        )
    `.execute(db);
    const row = result.rows[0];
    if (row === undefined) throw new Error('auth_challenge_create returned no row');
    return { challengeId: row.challenge_id, expiresAt: row.expires_at };
  },

  // Spends the challenge and returns the text the wallet was asked to sign.
  // Undefined when it is unknown, spent, lapsed or another wallet's. Spent
  // either way, so a signature that then fails its check has used it up.
  consume: async (
    db: Tx,
    challengeId: string,
    walletAddress: string,
  ): Promise<string | undefined> => {
    const result = await sql<{ message: string | null }>`
      select ujira.auth_challenge_consume(${challengeId}::uuid, ${walletAddress}) as message
    `.execute(db);
    return result.rows[0]?.message ?? undefined;
  },
};

export const sessions = {
  create: async (db: Tx, session: NewSession): Promise<CreatedSession> => {
    const result = await sql<{
      session_id: string;
      member_id: string;
      idle_expires_at: Date;
      absolute_expires_at: Date;
    }>`
      select session_id, member_id, idle_expires_at, absolute_expires_at
        from ujira.session_create(
          ${session.tokenSha256}, ${session.walletAddress},
          ${session.idleSeconds}::integer, ${session.absoluteSeconds}::integer
        )
    `.execute(db);
    const row = result.rows[0];
    if (row === undefined) throw new Error('session_create returned no row');
    return {
      sessionId: row.session_id,
      memberId: row.member_id,
      idleExpiresAt: row.idle_expires_at,
      absoluteExpiresAt: row.absolute_expires_at,
    };
  },

  // The live session behind a secret, checked against the project a request
  // names, if it names one. Undefined when the session is revoked, lapsed or
  // never existed.
  resolve: async (
    db: Tx,
    tokenSha256: Buffer,
    projectId: string | null,
  ): Promise<ResolvedSession | undefined> => {
    const result = await sql<{
      session_id: string;
      member_id: string;
      wallet_address: string;
      idle_expires_at: Date;
      absolute_expires_at: Date;
      principal_id: string | null;
      project_id: string | null;
      member_role: string | null;
    }>`
      select session_id, member_id, wallet_address, idle_expires_at, absolute_expires_at,
             principal_id, project_id, member_role
        from ujira.session_resolve(${tokenSha256}, ${projectId}::uuid)
    `.execute(db);
    const row = result.rows[0];
    if (row === undefined) return undefined;
    return {
      sessionId: row.session_id,
      memberId: row.member_id,
      walletAddress: row.wallet_address,
      idleExpiresAt: row.idle_expires_at,
      absoluteExpiresAt: row.absolute_expires_at,
      access:
        row.principal_id === null || row.project_id === null || row.member_role === null
          ? null
          : { principalId: row.principal_id, projectId: row.project_id, role: row.member_role },
    };
  },

  // The principals the person may act for, oldest first. Empty for a session
  // that is not live.
  principals: async (db: Tx, tokenSha256: Buffer): Promise<SessionPrincipal[]> => {
    const result = await sql<{ principal_id: string; name: string; role: string }>`
      select principal_id, name, role from ujira.session_principals(${tokenSha256})
    `.execute(db);
    return result.rows.map((row) => ({
      principalId: row.principal_id,
      name: row.name,
      role: row.role,
    }));
  },

  // Every project of those principals. Empty for a session that is not live.
  projects: async (db: Tx, tokenSha256: Buffer): Promise<SessionProject[]> => {
    const result = await sql<{
      project_id: string;
      principal_id: string;
      name: string;
      created_at: Date;
    }>`
      select project_id, principal_id, name, created_at from ujira.session_projects(${tokenSha256})
    `.execute(db);
    return result.rows.map((row) => ({
      projectId: row.project_id,
      principalId: row.principal_id,
      name: row.name,
      createdAt: row.created_at,
    }));
  },

  // The new idle expiry, or undefined when the session is not live.
  touch: async (db: Tx, tokenSha256: Buffer, idleSeconds: number): Promise<Date | undefined> => {
    const result = await sql<{ extended: Date | null }>`
      select ujira.session_touch(${tokenSha256}, ${idleSeconds}::integer) as extended
    `.execute(db);
    return result.rows[0]?.extended ?? undefined;
  },

  // False when there was nothing live to revoke. The reason is a short
  // lower case code, such as signed_out.
  revoke: async (db: Tx, tokenSha256: Buffer, reason: string): Promise<boolean> => {
    const result = await sql<{ revoked: boolean }>`
      select ujira.session_revoke(${tokenSha256}, ${reason}) as revoked
    `.execute(db);
    return result.rows[0]?.revoked === true;
  },
};

// The daily prune, as the worker. Each call removes one batch and says how
// many, so the job calls again until it says none.
export const authRetention = {
  deleteExpiredChallenges: async (db: Tx, batchSize: number): Promise<number> => {
    const result = await sql<{ removed: number }>`
      select ujira.auth_challenges_delete_expired(${batchSize}::integer)::integer as removed
    `.execute(db);
    return result.rows[0]?.removed ?? 0;
  },

  deleteExpiredSessions: async (db: Tx, batchSize: number): Promise<number> => {
    const result = await sql<{ removed: number }>`
      select ujira.sessions_delete_expired(${batchSize}::integer)::integer as removed
    `.execute(db);
    return result.rows[0]?.removed ?? 0;
  },
};
