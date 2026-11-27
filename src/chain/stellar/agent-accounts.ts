// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// Agent keys on Stellar: ed25519 keys whose raw 32 byte seed is the secret
// the key module seals. The secret never leaves as a string, so it cannot
// end up in a template literal or a log line by accident.
//
// An agent account only signs request_payout on its mandates. It never holds
// or receives USDC, the mandate contract does, so it needs no trustline and
// funding adds none. That keeps the reserve at the two base reserves friendbot
// pays for, and means there is no trustline to go missing later.

import { Keypair } from '@stellar/stellar-sdk';

import type { AgentAccounts, GeneratedAgentKey } from '../agent-accounts.js';
import { ChainError, withDeadline, type CallOptions, type NetworkId } from '../adapter.js';
import { toChainError } from './adapter.js';
import { signerFrom } from './keys.js';
import type { StellarNetworkPort } from './network.js';

const SEED_BYTES = 32;

export interface StellarAgentAccountsOptions {
  readonly network: NetworkId;
  readonly chain: Pick<StellarNetworkPort, 'friendbot' | 'accountFacts'>;
}

export class StellarAgentAccounts implements AgentAccounts {
  readonly network: NetworkId;
  private readonly chain: StellarAgentAccountsOptions['chain'];

  constructor(options: StellarAgentAccountsOptions) {
    this.network = options.network;
    this.chain = options.chain;
  }

  generate(): GeneratedAgentKey {
    const keypair = Keypair.random();
    return { publicKey: keypair.publicKey(), secret: Buffer.from(keypair.rawSecretKey()) };
  }

  signer(secret: Buffer, publicKey: string) {
    // The message names neither value: one is a secret, and the other would
    // tell a reader which account a broken row belongs to.
    const refused = () =>
      new ChainError('SIGNATURE_INVALID', 'the agent secret is not the key of its account');
    if (secret.length !== SEED_BYTES) throw refused();
    // A copy, so the caller zeroing its buffer cannot reach into the keypair.
    const keypair = Keypair.fromRawEd25519Seed(Buffer.from(secret));
    if (keypair.publicKey() !== publicKey) throw refused();
    return signerFrom(keypair);
  }

  async fund(address: string, o: CallOptions): Promise<void> {
    if (this.network !== 'stellar:testnet') {
      // On the public network the reserve is real money, and who pays it is a
      // decision for before mainnet, not something to do quietly here.
      throw new ChainError('UNAVAILABLE', 'agent accounts are funded on testnet only', {
        reason: 'funding_unsupported',
      });
    }
    await withDeadline(
      o,
      'funding the agent account',
      async () => {
        await this.chain.friendbot(address);
        // Friendbot answering is not the account existing: read it back.
        const facts = await this.chain.accountFacts(address);
        if (!facts.exists) {
          throw new ChainError('UNAVAILABLE', 'the agent account does not exist after funding', {
            reason: 'friendbot_failed',
          });
        }
      },
      (error) => toChainError(error, 'funding the agent account'),
    );
  }
}
