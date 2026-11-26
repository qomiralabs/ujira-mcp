// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// Product code that reaches for the Stellar library directly, in three ways.
// The boundary test lints this text as if it lived in src/; here in test/ it
// is allowed, so the repository's own lint run stays clean.

import { Keypair } from '@stellar/stellar-sdk';
import type { Transaction } from '@stellar/stellar-sdk';

export const key = (): string => Keypair.random().publicKey();
export const sign = (tx: Transaction): void => {
  tx.sign(Keypair.random());
};
export const later = () => import('@stellar/stellar-sdk');
