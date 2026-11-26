// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The ways in that run before a tenant context exists, inside db.unscoped().
// Each calls one security definer function owned by its own narrow role;
// nothing else is readable or writable in that transaction.

import { sql, type Kysely } from 'kysely';

import type { Schema } from '../schema.js';

type Tx = Kysely<Schema>;

export interface NewPrincipal {
  readonly name: string;
  readonly projectName: string;
  // The wallet of the person who becomes the owner, as the chain adapter
  // writes it.
  readonly ownerWallet: string;
  // An IANA zone; UTC when left out.
  readonly reportingTimeZone?: string;
}

export interface CreatedPrincipal {
  readonly principalId: string;
  readonly projectId: string;
  // The owner's member id, the same one every other principal of that wallet
  // knows them by.
  readonly memberId: string;
}

export interface TokenRecord {
  readonly tokenId: string;
  readonly principalId: string;
  readonly projectId: string;
  readonly secretSha256: Buffer;
  readonly scopes: readonly string[];
  readonly expiresAt: Date;
  readonly revokedAt: Date | null;
}

export const entryPoints = {
  // The principal, its first project and its owner, all or none.
  createPrincipal: async (db: Tx, input: NewPrincipal): Promise<CreatedPrincipal> => {
    const result = await sql<{ principal_id: string; project_id: string; member_id: string }>`
      select principal_id, project_id, member_id
        from ujira.create_principal(
          ${input.name}, ${input.projectName}, ${input.ownerWallet}, ${input.reportingTimeZone ?? 'UTC'}
        )
    `.execute(db);
    const row = result.rows[0];
    if (row === undefined) throw new Error('create_principal returned no row');
    return { principalId: row.principal_id, projectId: row.project_id, memberId: row.member_id };
  },

  // The token the prefix names, whatever its tenant, or undefined. The
  // caller compares the secret's hash in constant time and checks expiry
  // and revocation before trusting the tenant it names.
  authenticateToken: async (db: Tx, prefix: string): Promise<TokenRecord | undefined> => {
    const result = await sql<{
      token_id: string;
      principal_id: string;
      project_id: string;
      secret_sha256: Buffer;
      scopes: string[];
      expires_at: Date;
      revoked_at: Date | null;
    }>`
      select token_id, principal_id, project_id, secret_sha256, scopes, expires_at, revoked_at
        from ujira.authenticate_token(${prefix})
    `.execute(db);
    const row = result.rows[0];
    if (row === undefined) return undefined;
    return {
      tokenId: row.token_id,
      principalId: row.principal_id,
      projectId: row.project_id,
      secretSha256: row.secret_sha256,
      scopes: row.scopes,
      expiresAt: row.expires_at,
      revokedAt: row.revoked_at,
    };
  },
};
