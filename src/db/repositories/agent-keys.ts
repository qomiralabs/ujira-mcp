// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// A project's agent keys. As in every repository here, no method takes a
// tenant id: the policies decide what the transaction's context reaches.
//
// The secret goes in sealed and comes out sealed. Sealing and opening belong to
// the key module, and only the worker, which signs, can read the sealed form
// back: the app's grants stop at the public columns, so a request handler that
// asked would be refused by the database, 42501.

import { sql, type Kysely } from 'kysely';

import type { Schema } from '../schema.js';
import type { AccountParser } from './values.js';

type Tx = Kysely<Schema>;

const CURRENT_PRINCIPAL = sql<string>`ujira.current_principal_id()`;
const CURRENT_PROJECT = sql<string>`ujira.current_project_id()`;

export type AgentKeyStatus = 'active' | 'retired';

export interface AgentKey {
  readonly id: string;
  readonly projectId: string;
  // The chain adapter's network id, such as stellar:testnet.
  readonly network: string;
  // The account the key signs as, which the project's mandates name as agent.
  readonly publicKey: string;
  readonly status: AgentKeyStatus;
  readonly createdAt: Date;
}

export interface NewAgentKey {
  readonly network: string;
  readonly publicKey: string;
  // AES-256-GCM output with its tag, and the 12 byte nonce it was sealed with.
  readonly secretCiphertext: Buffer;
  readonly secretNonce: Buffer;
}

export interface SealedAgentSecret {
  readonly id: string;
  readonly projectId: string;
  readonly network: string;
  readonly publicKey: string;
  readonly ciphertext: Buffer;
  readonly nonce: Buffer;
}

const STATUSES: ReadonlySet<string> = new Set<AgentKeyStatus>(['active', 'retired']);

// The column check makes this unreachable unless the two lists drift apart.
function agentKeyStatus(value: string): AgentKeyStatus {
  if (!STATUSES.has(value))
    throw new Error('an agent key row holds a status this code does not know');
  return value as AgentKeyStatus;
}

// The public columns only: these are all the app may select.
const publicColumns = [
  'id',
  'project_id',
  'network',
  'public_key',
  'status',
  'created_at',
] as const;

function toAgentKey(row: {
  id: string;
  project_id: string;
  network: string;
  public_key: string;
  status: string;
  created_at: Date;
}): AgentKey {
  return {
    id: row.id,
    projectId: row.project_id,
    network: row.network,
    publicKey: row.public_key,
    status: agentKeyStatus(row.status),
    createdAt: row.created_at,
  };
}

export const agentKeys = {
  // A project holds one active key per network: a second is refused, 23505,
  // until the first is retired.
  create: async (db: Tx, input: NewAgentKey, accounts: AccountParser): Promise<AgentKey> => {
    const row = await db
      .insertInto('ujira.agent_keys')
      .values({
        principal_id: CURRENT_PRINCIPAL,
        project_id: CURRENT_PROJECT,
        network: input.network,
        public_key: accounts.parseAccount(input.publicKey),
        secret_ciphertext: input.secretCiphertext,
        secret_nonce: input.secretNonce,
      })
      .returning(publicColumns)
      .executeTakeFirstOrThrow();
    return toAgentKey(row);
  },

  get: async (db: Tx, id: string): Promise<AgentKey | undefined> => {
    const row = await db
      .selectFrom('ujira.agent_keys')
      .select(publicColumns)
      .where('id', '=', id)
      .executeTakeFirst();
    return row === undefined ? undefined : toAgentKey(row);
  },

  // The key new mandates on this network name, if the project has one yet.
  active: async (db: Tx, network: string): Promise<AgentKey | undefined> => {
    const row = await db
      .selectFrom('ujira.agent_keys')
      .select(publicColumns)
      .where('network', '=', network)
      .where('status', '=', 'active')
      .executeTakeFirst();
    return row === undefined ? undefined : toAgentKey(row);
  },

  // True when an active key was found and retired. A retired key never comes
  // back (UJ004), because mandates already on chain still name it.
  retire: async (db: Tx, id: string): Promise<boolean> => {
    const result = await db
      .updateTable('ujira.agent_keys')
      .set({ status: 'retired' })
      .where('id', '=', id)
      .where('status', '=', 'active')
      .executeTakeFirst();
    return result.numUpdatedRows > 0n;
  },

  // For the worker's signer only. Under the app or the reader the database
  // refuses the secret columns, 42501.
  sealedSecret: async (db: Tx, id: string): Promise<SealedAgentSecret | undefined> => {
    const row = await db
      .selectFrom('ujira.agent_keys')
      .select(['id', 'project_id', 'network', 'public_key', 'secret_ciphertext', 'secret_nonce'])
      .where('id', '=', id)
      .executeTakeFirst();
    return row === undefined
      ? undefined
      : {
          id: row.id,
          projectId: row.project_id,
          network: row.network,
          publicKey: row.public_key,
          ciphertext: row.secret_ciphertext,
          nonce: row.secret_nonce,
        };
  },
};

// For the cross-tenant matrix, which requires a case for each method here.
export const agentKeyRepositories = { agentKeys } as const;
