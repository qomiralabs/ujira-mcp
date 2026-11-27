// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The keys the payout jobs sign with. A payout is requested by the agent key
// its mandate names and executed by the one executor key. Where an agent key
// comes from is behind this port: today the shared agent key from the
// environment, and the project's own sealed key once projects hold keys, with
// no change to the jobs.

import type { TxSigner } from '../chain/adapter.js';
import type { ProjectContext } from '../db/index.js';

/** What the jobs know of a mandate when they ask for its agent. */
export interface MandateAgentRef {
  readonly id: string;
  /** One of the project's keys, or null for a mandate made with the shared key. */
  readonly agentKeyId: string | null;
  /** The account the chain names as the mandate's agent. */
  readonly agentAddress: string;
}

export interface PayoutSigners {
  /**
   * The signer for the agent the mandate names, under the job's tenant.
   * Throws AgentKeyUnavailableError when this server cannot sign as it.
   */
  agentFor(context: ProjectContext, mandate: MandateAgentRef): Promise<TxSigner>;
  readonly executor: TxSigner;
}

/**
 * The mandate names an agent this server holds no key for. Nothing was sent,
 * and trying again cannot change it, so the payout needs a person.
 */
export class AgentKeyUnavailableError extends Error {
  override readonly name = 'AgentKeyUnavailableError';
  readonly code = 'AGENT_KEY_UNAVAILABLE';

  constructor() {
    super('this server holds no key for the agent the mandate names');
  }
}

/**
 * Looks up a project's own agent key. Kept to the one call the jobs need, so
 * the key service can plug in as it is.
 */
export interface ProjectKeySigner {
  signer(context: ProjectContext, agentKeyId: string): Promise<TxSigner>;
}

export interface SignerOptions {
  readonly executor: TxSigner;
  /** The key mandates made before projects had keys were created with. */
  readonly sharedAgent?: TxSigner;
  /** The project keys; until they exist, only the shared key signs. */
  readonly projectKeys?: ProjectKeySigner;
}

export function payoutSigners(o: SignerOptions): PayoutSigners {
  return {
    executor: o.executor,
    agentFor: async (context, mandate) => {
      if (mandate.agentKeyId !== null && o.projectKeys !== undefined) {
        const signer = await o.projectKeys.signer(context, mandate.agentKeyId);
        // The chain would refuse any other key; this says why before it does.
        if (signer.publicKey !== mandate.agentAddress) throw new AgentKeyUnavailableError();
        return signer;
      }
      if (o.sharedAgent !== undefined && o.sharedAgent.publicKey === mandate.agentAddress) {
        return o.sharedAgent;
      }
      throw new AgentKeyUnavailableError();
    },
  };
}
