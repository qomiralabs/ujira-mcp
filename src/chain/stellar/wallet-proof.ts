// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// Proof that a person holds a Stellar account: they sign a message with their
// wallet, as SEP-53 defines it (ed25519 over
// SHA-256("Stellar Signed Message:\n" + message)). The message text itself is
// owned by src/auth, so sign in and recipient proofs read the same wherever
// they are built; this module only checks signatures and names receipts.

import { Keypair } from '@stellar/stellar-sdk';

import type { NetworkId } from '../adapter.js';
import { isAccountAddress } from './addresses.js';

/** A 64 byte ed25519 signature in standard, padded base64. */
const SIGNATURE_BASE64 = /^[A-Za-z0-9+/]{86}==$/;

/**
 * Whether `signatureBase64` is the account's SEP-53 signature of `message`.
 * Anything malformed is simply not a proof, so this answers false rather
 * than throwing.
 */
export function verifyWalletProof(
  address: string,
  message: string,
  signatureBase64: string,
): boolean {
  if (!isAccountAddress(address) || !SIGNATURE_BASE64.test(signatureBase64)) return false;
  try {
    return Keypair.fromPublicKey(address).verifyMessage(
      message,
      Buffer.from(signatureBase64, 'base64'),
    );
  } catch {
    return false;
  }
}

const TX_HASH = /^[0-9a-f]{64}$/;

/**
 * A stable reference to one event of one transaction, the form receipts
 * carry, such as ujira:tx:v1:stellar:testnet:<hash>:0.
 */
export function receiptRef(network: NetworkId, txHash: string, eventIndex: number): string {
  const hash = txHash.toLowerCase();
  if (!TX_HASH.test(hash)) throw new RangeError('txHash must be 64 hex digits');
  if (!Number.isSafeInteger(eventIndex) || eventIndex < 0) {
    throw new RangeError('eventIndex must be a whole number, 0 or more');
  }
  return `ujira:tx:v1:${network}:${hash}:${String(eventIndex)}`;
}
