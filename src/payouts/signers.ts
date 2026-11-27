// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The keys the payout jobs sign with. A payout is requested by the project's
// own agent key, the one its mandate names, so the chain itself refuses a
// request on another project's mandate. It is executed by the one executor
// key, which can only pay the legs a mandate recorded.

import type { TxSigner } from '../chain/adapter.js';
import type { ProjectContext } from '../db/index.js';
import { AgentKeyError } from '../keys/agent-keys.js';

/** What the jobs know of a mandate when they ask for its agent. */
export interface MandateAgentRef {
  readonly id: string;
  /** One of the project's keys, or null for a mandate that names an outside agent. */
  readonly agentKeyId: string | null;
  /** The account the chain names as the mandate's agent. */
  readonly agentAddress: string;
}

export interface PayoutSigners {
  /**
   * The signer for the agent the mandate names, under the job's tenant.
   * Throws AgentKeyUnavailableError when this server holds no key for it.
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

  constructor(cause?: unknown) {
    super(
      'this server holds no key for the agent the mandate names',
      cause === undefined ? undefined : { cause },
    );
  }
}

/**
 * Opens one of the project's sealed agent keys. The key service is one; it
 * opens the secret only for as long as it takes to make the signer.
 */
export interface ProjectKeySigner {
  signer(context: ProjectContext, agentKeyId: string): Promise<TxSigner>;
}

export interface SignerOptions {
  readonly executor: TxSigner;
  readonly projectKeys: ProjectKeySigner;
}

export function payoutSigners(o: SignerOptions): PayoutSigners {
  return {
    executor: o.executor,
    agentFor: async (context, mandate) => {
      if (mandate.agentKeyId === null) throw new AgentKeyUnavailableError();
      let signer: TxSigner;
      try {
        signer = await o.projectKeys.signer(context, mandate.agentKeyId);
      } catch (error) {
        // A key that is gone or no longer opens stays that way; an outage
        // reading it goes back to the queue.
        if (error instanceof AgentKeyError) throw new AgentKeyUnavailableError(error);
        throw error;
      }
      // The chain would refuse any other key; this says why before it does.
      if (signer.publicKey !== mandate.agentAddress) throw new AgentKeyUnavailableError();
      return signer;
    },
  };
}
