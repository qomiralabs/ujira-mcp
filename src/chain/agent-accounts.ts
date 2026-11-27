// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// What the key module needs from a chain to give a project its own agent:
// a fresh key, a signer made from a stored secret, and an account on chain
// for the key to sign as. The key module seals and stores the secret; this
// port only knows what a key on its chain looks like.

import type { CallOptions, NetworkId } from './adapter.js';
import type { TxSigner } from './types.js';

export interface GeneratedAgentKey {
  // The account the key signs as, in the chain's canonical spelling.
  readonly publicKey: string;
  // The raw secret. The caller seals it and then zeroes this buffer.
  readonly secret: Buffer;
}

export interface AgentAccounts {
  readonly network: NetworkId;
  generate(): GeneratedAgentKey;
  // A signer holding the key. Throws ChainError SIGNATURE_INVALID when the
  // secret is not the key of `publicKey`, so a row whose columns were swapped
  // can never sign as an account it does not name. The secret buffer is not
  // kept; the caller may zero it as soon as this returns.
  signer(secret: Buffer, publicKey: string): TxSigner;
  // Makes the account exist, which is what lets the key sign anything. Safe
  // to repeat: an account that already exists resolves. Throws ChainError.
  fund(address: string, o: CallOptions): Promise<void>;
}
