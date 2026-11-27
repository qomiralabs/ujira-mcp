// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// A project's mandates: which deployed contract is whose, what it is called, and
// which key drives it. The contract's rules and money live on chain and are read
// from there; nothing here is a copy of them.

import { sql, type Kysely } from 'kysely';

import type { Schema } from '../schema.js';
import { checkedLimit, pageOf, type Page, type PageRequest } from './page.js';
import { bytesHex32, hex32Bytes, type AccountParser } from './values.js';

type Tx = Kysely<Schema>;

const CURRENT_PRINCIPAL = sql<string>`ujira.current_principal_id()`;
const CURRENT_PROJECT = sql<string>`ujira.current_project_id()`;

export interface Mandate {
  readonly id: string;
  readonly projectId: string;
  readonly name: string;
  // The chain adapter's network id, such as stellar:testnet.
  readonly network: string;
  readonly contractAddress: string;
  // The token the contract pays, at its scale on this chain.
  readonly asset: string;
  readonly scale: number;
  // Null for a mandate that names an agent outside this project's keys.
  readonly agentKeyId: string | null;
  readonly agentAddress: string;
  readonly principalWallet: string;
  // 64 lowercase hex digits, or null when the creating transaction was not seen.
  readonly createdTxHash: string | null;
  readonly createdAt: Date;
}

// Either one of this project's keys, whose address the database fills in, or,
// for a mandate made before projects had keys, the address the chain names.
export type MandateAgent = { readonly keyId: string } | { readonly address: string };

export interface NewMandate {
  readonly name: string;
  readonly network: string;
  // As the chain adapter returned it from the deployment or the on chain read.
  readonly contractAddress: string;
  readonly asset: string;
  readonly scale: number;
  readonly agent: MandateAgent;
  readonly principalWallet: string;
  readonly createdTxHash?: string;
}

const mandateColumns = [
  'id',
  'project_id',
  'name',
  'network',
  'contract_address',
  'asset',
  'scale',
  'agent_key_id',
  'agent_address',
  'principal_wallet',
  'created_tx_hash',
  'created_at',
] as const;

function toMandate(row: {
  id: string;
  project_id: string;
  name: string;
  network: string;
  contract_address: string;
  asset: string;
  scale: number;
  agent_key_id: string | null;
  agent_address: string;
  principal_wallet: string;
  created_tx_hash: Buffer | null;
  created_at: Date;
}): Mandate {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    network: row.network,
    contractAddress: row.contract_address,
    asset: row.asset,
    scale: row.scale,
    agentKeyId: row.agent_key_id,
    agentAddress: row.agent_address,
    principalWallet: row.principal_wallet,
    createdTxHash: row.created_tx_hash === null ? null : bytesHex32(row.created_tx_hash),
    createdAt: row.created_at,
  };
}

export const mandates = {
  // A contract already attached to any project is refused, 23505. A key that is
  // not this project's, or is on another network, leaves the agent address
  // empty or fails its key: 23502 or 23503, and no row either way. An asset at a
  // scale its chain does not settle it at is refused by the reference data,
  // 23503.
  create: async (db: Tx, input: NewMandate, accounts: AccountParser): Promise<Mandate> => {
    const createdTxHash =
      input.createdTxHash === undefined ? null : hex32Bytes(input.createdTxHash, 'createdTxHash');
    const agent =
      'keyId' in input.agent
        ? {
            agent_key_id: input.agent.keyId,
            // Read under the same policies, so another project's key reads as
            // nothing and the not null check refuses the row.
            agent_address: sql<string>`(select k.public_key from ujira.agent_keys as k where k.id = ${input.agent.keyId})`,
          }
        : { agent_key_id: null, agent_address: accounts.parseAccount(input.agent.address) };
    const row = await db
      .insertInto('ujira.mandates')
      .values({
        principal_id: CURRENT_PRINCIPAL,
        project_id: CURRENT_PROJECT,
        name: input.name,
        chain: sql<string>`split_part(${input.network}::text, ':', 1)`,
        network: input.network,
        contract_address: input.contractAddress,
        asset: input.asset,
        scale: input.scale,
        ...agent,
        principal_wallet: accounts.parseAccount(input.principalWallet),
        created_tx_hash: createdTxHash,
      })
      .returning(mandateColumns)
      .executeTakeFirstOrThrow();
    return toMandate(row);
  },

  get: async (db: Tx, id: string): Promise<Mandate | undefined> => {
    const row = await db
      .selectFrom('ujira.mandates')
      .select(mandateColumns)
      .where('id', '=', id)
      .executeTakeFirst();
    return row === undefined ? undefined : toMandate(row);
  },

  list: async (db: Tx, page: PageRequest): Promise<Page<Mandate>> => {
    const limit = checkedLimit(page.limit);
    let query = db
      .selectFrom('ujira.mandates')
      .select(mandateColumns)
      .orderBy('id')
      .limit(limit + 1);
    if (page.after !== undefined) query = query.where('id', '>', page.after);
    return pageOf((await query.execute()).map(toMandate), limit, (mandate) => mandate.id);
  },

  // The transaction's own mandate at that contract. Another project's is not
  // found, though creating it again would still be refused.
  findByContract: async (
    db: Tx,
    network: string,
    contractAddress: string,
  ): Promise<Mandate | undefined> => {
    const row = await db
      .selectFrom('ujira.mandates')
      .select(mandateColumns)
      .where('network', '=', network)
      .where('contract_address', '=', contractAddress)
      .executeTakeFirst();
    return row === undefined ? undefined : toMandate(row);
  },

  rename: async (db: Tx, id: string, name: string): Promise<boolean> => {
    const result = await db
      .updateTable('ujira.mandates')
      .set({ name })
      .where('id', '=', id)
      .executeTakeFirst();
    return result.numUpdatedRows > 0n;
  },
};

// For the cross-tenant matrix, which requires a case for each method here.
export const mandateRepositories = { mandates } as const;
