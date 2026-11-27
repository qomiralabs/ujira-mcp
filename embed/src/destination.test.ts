// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

import { describe, expect, it } from 'vitest';

import {
  encodeAccountAddress,
  encodeContractAddress,
  encodeMuxedAddress,
  readWalletDestination,
} from './destination.js';

const KEY = new Uint8Array(32).fill(7);
const WALLET = encodeAccountAddress(KEY);
const ISSUER_KEY = new Uint8Array(32).fill(9);
const ISSUER = encodeAccountAddress(ISSUER_KEY);
const CONTRACT = encodeContractAddress(new Uint8Array(32).fill(3));

function problemOf(address: string, memo = '', neverPayable: readonly string[] = [ISSUER]) {
  const read = readWalletDestination(address, memo, neverPayable);
  return read.ok ? undefined : { field: read.field, problem: read.problem };
}

describe('reading a wallet destination', () => {
  it('encodes addresses the way Stellar spells them', () => {
    // The well known all zero account, so the encoder is not only checked
    // against the decoder it shares code with.
    expect(encodeAccountAddress(new Uint8Array(32))).toBe(`G${'A'.repeat(52)}WHF`);
    expect(WALLET).toMatch(/^G[A-Z2-7]{55}$/);
    expect(encodeMuxedAddress(KEY, 1n)).toMatch(/^M[A-Z2-7]{68}$/);
    expect(CONTRACT).toMatch(/^C[A-Z2-7]{55}$/);
  });

  it('accepts an account, a muxed account and a contract, trimming the spaces a copy brings', () => {
    expect(readWalletDestination(` ${WALLET}\n`, '', [])).toEqual({
      ok: true,
      destination: { address: WALLET, memo: '' },
    });
    expect(problemOf(encodeMuxedAddress(KEY, 42n))).toBeUndefined();
    expect(problemOf(CONTRACT)).toBeUndefined();
  });

  it('asks for an address when there is none', () => {
    expect(problemOf('  ')).toEqual({ field: 'address', problem: 'destination.wallet.missing' });
  });

  it('refuses a typo, which the checksum catches', () => {
    const typo = `${WALLET.slice(0, 10)}${WALLET.charAt(10) === 'A' ? 'B' : 'A'}${WALLET.slice(11)}`;
    expect(problemOf(typo)).toEqual({ field: 'address', problem: 'destination.wallet.invalid' });
  });

  it('refuses other strkeys, lower case and the wrong length', () => {
    for (const text of [
      `S${WALLET.slice(1)}`,
      WALLET.toLowerCase(),
      WALLET.slice(0, 55),
      `${WALLET}A`,
      `G${'A'.repeat(55)}`,
      'not an address',
    ]) {
      expect(problemOf(text)?.problem, text).toBe('destination.wallet.invalid');
    }
  });

  it('refuses the all zero key, which nobody can sign for', () => {
    expect(problemOf(encodeAccountAddress(new Uint8Array(32)))?.problem).toBe(
      'destination.wallet.invalid',
    );
  });

  it('takes a numeric memo with an account, up to the largest 64 bit id', () => {
    expect(readWalletDestination(WALLET, ' 12345 ', [])).toEqual({
      ok: true,
      destination: { address: WALLET, memo: '12345' },
    });
    expect(problemOf(WALLET, '18446744073709551615')).toBeUndefined();
    expect(problemOf(WALLET, '0')).toBeUndefined();
  });

  it('refuses a text memo, which a payout from a mandate cannot carry', () => {
    for (const memo of ['invoice 12', 'ABC', '007', '-1', '1.5']) {
      expect(problemOf(WALLET, memo), memo).toEqual({
        field: 'memo',
        problem: 'destination.memo.unsupported',
      });
    }
  });

  it('refuses a memo too large for a 64 bit id', () => {
    expect(problemOf(WALLET, '18446744073709551616')?.problem).toBe('destination.memo.tooLong');
    expect(problemOf(WALLET, '1'.repeat(21))?.problem).toBe('destination.memo.tooLong');
  });

  it('refuses a second memo next to a muxed account or a contract', () => {
    expect(problemOf(encodeMuxedAddress(KEY, 1n), '5')?.problem).toBe('destination.memo.notNeeded');
    expect(problemOf(CONTRACT, '5')?.problem).toBe('destination.memo.notNeeded');
  });

  it('refuses an address that can never be paid, under any spelling', () => {
    expect(problemOf(ISSUER)).toEqual({
      field: 'address',
      problem: 'destination.wallet.unpayable',
    });
    expect(problemOf(ISSUER, '77')?.problem).toBe('destination.wallet.unpayable');
    expect(problemOf(encodeMuxedAddress(ISSUER_KEY, 77n))?.problem).toBe(
      'destination.wallet.unpayable',
    );
    expect(problemOf(CONTRACT, '', [CONTRACT])?.problem).toBe('destination.wallet.unpayable');
  });
});
