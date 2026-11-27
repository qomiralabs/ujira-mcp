// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// Transactions prepared for a principal's wallet, kept until the signed copy
// comes back. The row is the server's own record of what it asked to be
// signed, so a signed envelope is compared with this and never with what the
// client says it was asked to sign.

import { sql, type Kysely } from 'kysely';

import type { Schema } from '../schema.js';
import { bytesHex32, hex32Bytes, RepositoryInputError, type AccountParser } from './values.js';

type Tx = Kysely<Schema>;

const CURRENT_PRINCIPAL = sql<string>`ujira.current_principal_id()`;
const CURRENT_PROJECT = sql<string>`ujira.current_project_id()`;

export const SIGNING_ACTIONS = [
  'create',
  'fund',
  'allow_recipients',
  'pause',
  'resume',
  'revoke',
  'approve',
  'reject',
  'withdraw',
] as const;
export type SigningAction = (typeof SIGNING_ACTIONS)[number];

export interface StoredSigningRequest {
  readonly id: string;
  readonly projectId: string;
  // Null for the request that creates a mandate.
  readonly mandateId: string | null;
  readonly action: SigningAction;
  readonly network: string;
  readonly signer: string;
  // The unsigned envelope, base64.
  readonly envelope: string;
  readonly summary: string;
  readonly expiresAt: Date;
  // What a create carries for its mandate row; null for any other action.
  readonly mandateName: string | null;
  readonly agentKeyId: string | null;
  // 64 lowercase hex digits once a signed copy was sent, else null.
  readonly submittedTxHash: string | null;
  readonly submittedAt: Date | null;
  readonly createdAt: Date;
}

export interface NewSigningRequest {
  readonly mandateId: string | null;
  readonly action: SigningAction;
  readonly network: string;
  readonly signer: string;
  readonly envelope: string;
  readonly summary: string;
  readonly expiresAt: Date;
  // A create only; the row's check refuses them on any other action, 23514.
  readonly mandateName?: string | null;
  readonly agentKeyId?: string | null;
}

const ACTIONS: ReadonlySet<string> = new Set<string>(SIGNING_ACTIONS);

function signingAction(value: string): SigningAction {
  if (!ACTIONS.has(value)) {
    throw new Error('a signing request row holds an action this code does not know');
  }
  return value as SigningAction;
}

const columns = [
  'id',
  'project_id',
  'mandate_id',
  'action',
  'network',
  'signer',
  'envelope',
  'summary',
  'expires_at',
  'mandate_name',
  'agent_key_id',
  'submitted_tx_hash',
  'submitted_at',
  'created_at',
] as const;

function toSigningRequest(row: {
  id: string;
  project_id: string;
  mandate_id: string | null;
  action: string;
  network: string;
  signer: string;
  envelope: string;
  summary: string;
  expires_at: Date;
  mandate_name: string | null;
  agent_key_id: string | null;
  submitted_tx_hash: Buffer | null;
  submitted_at: Date | null;
  created_at: Date;
}): StoredSigningRequest {
  return {
    id: row.id,
    projectId: row.project_id,
    mandateId: row.mandate_id,
    action: signingAction(row.action),
    network: row.network,
    signer: row.signer,
    envelope: row.envelope,
    summary: row.summary,
    expiresAt: row.expires_at,
    mandateName: row.mandate_name,
    agentKeyId: row.agent_key_id,
    submittedTxHash: row.submitted_tx_hash === null ? null : bytesHex32(row.submitted_tx_hash),
    submittedAt: row.submitted_at,
    createdAt: row.created_at,
  };
}

export const signingRequests = {
  // A mandate outside the transaction's project fails its key, 23503. A create
  // that names a mandate, or any other action that names none, is refused by
  // the row's check, 23514.
  create: async (
    db: Tx,
    input: NewSigningRequest,
    accounts: AccountParser,
  ): Promise<StoredSigningRequest> => {
    if (!ACTIONS.has(input.action)) throw new RepositoryInputError('action');
    const row = await db
      .insertInto('ujira.signing_requests')
      .values({
        principal_id: CURRENT_PRINCIPAL,
        project_id: CURRENT_PROJECT,
        mandate_id: input.mandateId,
        action: input.action,
        network: input.network,
        signer: accounts.parseAccount(input.signer),
        envelope: input.envelope,
        summary: input.summary,
        expires_at: input.expiresAt,
        mandate_name: input.mandateName ?? null,
        agent_key_id: input.agentKeyId ?? null,
      })
      .returning(columns)
      .executeTakeFirstOrThrow();
    return toSigningRequest(row);
  },

  get: async (db: Tx, id: string): Promise<StoredSigningRequest | undefined> => {
    const row = await db
      .selectFrom('ujira.signing_requests')
      .select(columns)
      .where('id', '=', id)
      .executeTakeFirst();
    return row === undefined ? undefined : toSigningRequest(row);
  },

  // True when this call recorded the transaction. A request already answered
  // is left as it is and the call says so; the database refuses to move it,
  // UJ006, should anything try.
  markSubmitted: async (db: Tx, id: string, txHash: string): Promise<boolean> => {
    const result = await db
      .updateTable('ujira.signing_requests')
      .set({ submitted_tx_hash: hex32Bytes(txHash, 'txHash'), submitted_at: sql<Date>`now()` })
      .where('id', '=', id)
      .where('submitted_tx_hash', 'is', null)
      .executeTakeFirst();
    return result.numUpdatedRows > 0n;
  },
};

// For the cross-tenant matrix, which requires a case for each method here.
export const signingRequestRepositories = { signingRequests } as const;
