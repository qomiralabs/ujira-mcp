// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// Stellar address checks, kept here so code outside src/chain can validate an
// address without importing the Stellar library itself.

import { StrKey } from '@stellar/stellar-sdk';

/** A classic account address (G...). */
export function isAccountAddress(text: string): boolean {
  return StrKey.isValidEd25519PublicKey(text);
}

/** A contract address (C...). */
export function isContractAddress(text: string): boolean {
  return StrKey.isValidContract(text);
}
