// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

import { describe, expect, it } from 'vitest';

import {
  accountAddressProblem,
  encodeAddress,
  isAccountAddress,
  isContractAddress,
  shortAddress,
} from './strkey';

// Public testnet identifiers from the deployment record.
const FACTORY = 'CB4AYBA5NVQPVPNOWUCSZQK6ZIGOF7KSCS6SF6UV6D2OKPDXLHEPD4V7';
const USDC_SAC = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA';
// The all zero account key, a well known valid strkey.
const ZERO_ACCOUNT = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';

describe('strkey', () => {
  it('accepts real addresses', () => {
    expect(isAccountAddress(ZERO_ACCOUNT)).toBe(true);
    expect(isContractAddress(FACTORY)).toBe(true);
    expect(isContractAddress(USDC_SAC)).toBe(true);
  });

  it('tells wallets and contracts apart', () => {
    expect(isAccountAddress(FACTORY)).toBe(false);
    expect(isContractAddress(ZERO_ACCOUNT)).toBe(false);
  });

  it('catches a single changed character by its checksum', () => {
    const typo = `${ZERO_ACCOUNT.slice(0, 20)}B${ZERO_ACCOUNT.slice(21)}`;
    expect(isAccountAddress(typo)).toBe(false);
    expect(accountAddressProblem(typo)).toBe(
      'This address has a typo: its checksum does not match.',
    );
  });

  it('encodes what it decodes', () => {
    const payload = new Uint8Array(32).map((_, i) => i * 7);
    const account = encodeAddress('account', payload);
    const contract = encodeAddress('contract', payload);
    expect(account).toMatch(/^G[A-Z2-7]{55}$/);
    expect(contract).toMatch(/^C[A-Z2-7]{55}$/);
    expect(isAccountAddress(account)).toBe(true);
    expect(isContractAddress(contract)).toBe(true);
    expect(encodeAddress('account', new Uint8Array(32))).toBe(ZERO_ACCOUNT);
  });

  it('explains what is wrong in words', () => {
    expect(accountAddressProblem('')).toBe('Paste a Stellar wallet address.');
    expect(accountAddressProblem(FACTORY)).toMatch(/contract address/);
    expect(accountAddressProblem('S'.padEnd(56, 'A'))).toMatch(/secret key/);
    expect(accountAddressProblem('GABC')).toBe(
      'A wallet address has 56 characters; this one has 4.',
    );
    expect(accountAddressProblem('XYZ')).toBe('Stellar wallet addresses start with G.');
    expect(accountAddressProblem(ZERO_ACCOUNT)).toBeNull();
  });

  it('shortens long values', () => {
    expect(shortAddress(ZERO_ACCOUNT)).toBe('GAAA...AWHF');
    expect(shortAddress('GABC')).toBe('GABC');
  });
});
