// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

import { describe, expect, it } from 'vitest';

import { encodeAccountAddress } from './destination.js';
import { freighterAddress, freighterSign, WalletRefused, type FreighterApi } from './wallet.js';

const WALLET = encodeAccountAddress(new Uint8Array(32).fill(7));
const OTHER = encodeAccountAddress(new Uint8Array(32).fill(8));

function api(over: Partial<Record<keyof FreighterApi, () => Promise<unknown>>>): FreighterApi {
  return {
    isConnected: () => Promise.resolve({ isConnected: true }),
    requestAccess: () => Promise.resolve({ address: WALLET }),
    signMessage: () => Promise.resolve({ signedMessage: 'c2ln', signerAddress: WALLET }),
    ...over,
  } as FreighterApi;
}

async function refusal(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (error) {
    if (error instanceof WalletRefused) return error.key;
    throw error;
  }
  return 'no refusal';
}

describe('Freighter', () => {
  it('shares the address it holds', async () => {
    await expect(freighterAddress(api({}))).resolves.toBe(WALLET);
  });

  it('is missing when the extension does not answer, or throws', async () => {
    const absent = api({ isConnected: () => Promise.resolve({ isConnected: false }) });
    expect(await refusal(freighterAddress(absent))).toBe('connect.missing');
    const broken = api({ isConnected: () => Promise.reject(new Error('no extension')) });
    expect(await refusal(freighterAddress(broken))).toBe('connect.missing');
  });

  it('is declined when the person says no or shares nothing', async () => {
    const said = api({
      requestAccess: () => Promise.resolve({ address: '', error: { code: -4, message: 'no' } }),
    });
    expect(await refusal(freighterAddress(said))).toBe('connect.declined');
    const empty = api({ requestAccess: () => Promise.resolve({ address: '' }) });
    expect(await refusal(freighterAddress(empty))).toBe('connect.declined');
  });

  it('signs with base64, from a newer release as text and an older one as bytes', async () => {
    await expect(freighterSign('hello', WALLET, api({}))).resolves.toEqual({ signature: 'c2ln' });
    const bytes = api({
      signMessage: () =>
        Promise.resolve({ signedMessage: Uint8Array.from([115, 105, 103]), signerAddress: '' }),
    });
    await expect(freighterSign('hello', WALLET, bytes)).resolves.toEqual({ signature: 'c2ln' });
  });

  it('names the signer when it is not the account itself', async () => {
    const delegated = api({
      signMessage: () => Promise.resolve({ signedMessage: 'c2ln', signerAddress: OTHER }),
    });
    await expect(freighterSign('hello', WALLET, delegated)).resolves.toEqual({
      signature: 'c2ln',
      signer: OTHER,
    });
  });

  it('is declined when no signature comes back', async () => {
    for (const answer of [
      { signedMessage: null, signerAddress: '' },
      { signedMessage: '', signerAddress: WALLET },
      { signedMessage: 'c2ln', signerAddress: WALLET, error: { code: -4, message: 'no' } },
    ]) {
      const declined = api({ signMessage: () => Promise.resolve(answer) });
      expect(await refusal(freighterSign('hello', WALLET, declined))).toBe('prove.declined');
    }
    const thrown = api({ signMessage: () => Promise.reject(new Error('closed')) });
    expect(await refusal(freighterSign('hello', WALLET, thrown))).toBe('prove.declined');
  });
});
