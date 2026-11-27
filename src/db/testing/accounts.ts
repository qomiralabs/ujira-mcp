// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// Addresses for the domain repository tests, and a stand in for the chain
// adapter's parseAccount. The database module carries no chain code, so the
// stand in follows the adapter's contract (trim, then accept one account form
// or throw) without its checksum, which is the adapter's own tests' business.

import { randomBytes } from 'node:crypto';

import type { AccountParser } from '../repositories/values.js';

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function strKey(prefix: 'G' | 'C'): string {
  return `${prefix}${Array.from(randomBytes(55), (byte) => BASE32.charAt(byte % 32)).join('')}`;
}

export const testAccount = (): string => strKey('G');
export const testContract = (): string => strKey('C');

export class TestAddressError extends Error {
  override readonly name = 'TestAddressError';
  readonly code = 'INVALID_ADDRESS';
}

export const testAccounts: AccountParser = {
  parseAccount: (raw) => {
    const value = raw.trim();
    if (!/^G[A-Z2-7]{55}$/.test(value)) throw new TestAddressError('not an account address');
    return value;
  },
};

// A sealed value the right size for its column. Nothing here is ever opened.
export const sealed = (fill: number, length = 48): Buffer => Buffer.alloc(length, fill);
export const nonce = (fill: number): Buffer => Buffer.alloc(12, fill);

export const testHex32 = (): string => randomBytes(32).toString('hex');
