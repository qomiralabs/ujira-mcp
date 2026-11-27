// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// What the mandate service needs from storage, as a port, so its rules are
// tested in memory and the database stays behind its repositories. Every
// method takes the caller's tenant and runs as its own short transaction:
// none is held open across a chain call, which can take a minute.

import type {
  Mandate,
  NewMandate,
  NewSigningRequest,
  Page,
  PageRequest,
  ProjectContext,
  StoredSigningRequest,
} from '../db/index.js';

export interface AgentKeyRef {
  readonly id: string;
  readonly publicKey: string;
}

/** A recipient of the project with the wallet it is paid at, if it has one. */
export interface RecipientWallet {
  readonly id: string;
  readonly mandateId: string;
  readonly label: string;
  readonly recipientRef: string;
  readonly status: string;
  readonly destination: string | null;
}

/** What an approval needs of a payout: its mandate and the id the chain knows it by. */
export interface PayoutRef {
  readonly mandateId: string;
  /** 64 lower case hex digits. */
  readonly onchainPayoutId: string;
}

/** Another project already holds this contract. */
export class MandateTakenError extends Error {
  constructor() {
    super('the contract belongs to another project');
    this.name = 'MandateTakenError';
  }
}

export interface MandateStore {
  /** The key new mandates on this network name as agent, if the project has one yet. */
  activeAgentKey(t: ProjectContext, network: string): Promise<AgentKeyRef | undefined>;
  mandate(t: ProjectContext, id: string): Promise<Mandate | undefined>;
  mandates(t: ProjectContext, page: PageRequest): Promise<Page<Mandate>>;
  /** Attaches a contract, or finds it already attached to this project. MandateTakenError for another's. */
  addMandate(
    t: ProjectContext,
    input: NewMandate,
  ): Promise<{ readonly mandate: Mandate; readonly created: boolean }>;
  /** The project's recipients among `ids`, whichever mandate they are on; unknown ids are left out. */
  recipients(t: ProjectContext, ids: readonly string[]): Promise<RecipientWallet[]>;
  /** The project's payout, or undefined for an unknown id or another tenant's. */
  payout(t: ProjectContext, id: string): Promise<PayoutRef | undefined>;
  /** One mandate's recipients, at most `limit`. */
  mandateRecipients(
    t: ProjectContext,
    mandateId: string,
    limit: number,
  ): Promise<RecipientWallet[]>;
  createSigningRequest(t: ProjectContext, input: NewSigningRequest): Promise<StoredSigningRequest>;
  signingRequest(t: ProjectContext, id: string): Promise<StoredSigningRequest | undefined>;
  /** False when the request already had a transaction. */
  markSubmitted(t: ProjectContext, id: string, txHash: string): Promise<boolean>;
  /**
   * Marks a create submitted and adds the mandate it deployed, in one
   * transaction. A second call for the same contract finds the first row.
   */
  recordCreated(
    t: ProjectContext,
    requestId: string,
    txHash: string,
    input: NewMandate,
  ): Promise<Mandate>;
}
