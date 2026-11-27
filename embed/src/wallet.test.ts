// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

import { describe, expect, it } from 'vitest';

import { encodeAccountAddress } from './destination.js';
import {
  albedoAddress,
  albedoSign,
  albedoSignature,
  freighterAddress,
  freighterSign,
  WalletRefused,
  type AlbedoApi,
  type FreighterApi,
} from './wallet.js';

const WALLET = encodeAccountAddress(new Uint8Array(32).fill(7));
const OTHER = encodeAccountAddress(new Uint8Array(32).fill(8));

/** 64 signature bytes, 0x00 to 0x3f, as Albedo sends them and as the server is sent them. */
const SIGNATURE_BYTES = Uint8Array.from({ length: 64 }, (_, index) => index);
const SIGNATURE_HEX = [...SIGNATURE_BYTES]
  .map((byte) => byte.toString(16).padStart(2, '0'))
  .join('');
const SIGNATURE_BASE64 = btoa(String.fromCharCode(...SIGNATURE_BYTES));

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

function albedo(over: Partial<AlbedoApi> = {}): () => Promise<AlbedoApi> {
  const stand: AlbedoApi = {
    publicKey: () => Promise.resolve({ pubkey: WALLET }),
    signMessage: () =>
      Promise.resolve({ pubkey: WALLET, original_message: 'hello', signedMessage: SIGNATURE_HEX }),
    ...over,
  };
  return () => Promise.resolve(stand);
}

describe('Albedo', () => {
  it('shares the address the person picks', async () => {
    await expect(albedoAddress(albedo())).resolves.toBe(WALLET);
  });

  it('is declined when its window is closed or shares nothing', async () => {
    const closed = albedo({ publicKey: () => Promise.reject(new Error('Request was cancelled')) });
    expect(await refusal(albedoAddress(closed))).toBe('connect.albedo.declined');
    const empty = albedo({ publicKey: () => Promise.resolve({ pubkey: '' }) });
    expect(await refusal(albedoAddress(empty))).toBe('connect.albedo.declined');
  });

  it('says the connection failed when its library cannot be loaded', async () => {
    const offline = (): Promise<AlbedoApi> => Promise.reject(new Error('Failed to fetch'));
    expect(await refusal(albedoAddress(offline))).toBe('widget.loadFailed');
    expect(await refusal(albedoSign('hello', WALLET, offline))).toBe('widget.loadFailed');
  });

  it('asks for the saved account and sends its SEP-53 signedMessage as base64', async () => {
    const asked: unknown[] = [];
    const watched = albedo({
      signMessage: (params) => {
        asked.push(params);
        return Promise.resolve({ pubkey: WALLET, signedMessage: SIGNATURE_HEX });
      },
    });
    await expect(albedoSign('hello', WALLET, watched)).resolves.toEqual({
      signature: SIGNATURE_BASE64,
    });
    expect(asked).toEqual([{ message: 'hello', pubkey: WALLET }]);
  });

  it('never uses message_signature, the older scheme the server refuses', async () => {
    expect(
      albedoSignature({ signedMessage: SIGNATURE_HEX, message_signature: 'cd'.repeat(64) }),
    ).toBe(SIGNATURE_BASE64);
    expect(albedoSignature({ message_signature: 'cd'.repeat(64) })).toBeUndefined();
    const older = albedo({
      signMessage: () => Promise.resolve({ pubkey: WALLET, message_signature: 'cd'.repeat(64) }),
    });
    expect(await refusal(albedoSign('hello', WALLET, older))).toBe('prove.albedo.unusable');
  });

  it('takes only 64 bytes of hex', () => {
    expect(albedoSignature({ signedMessage: SIGNATURE_HEX.toUpperCase() })).toBe(SIGNATURE_BASE64);
    for (const signedMessage of [
      'ab',
      'zz'.repeat(64),
      `${SIGNATURE_HEX}00`,
      SIGNATURE_BASE64,
      7,
    ]) {
      expect(albedoSignature({ signedMessage }), String(signedMessage)).toBeUndefined();
    }
    expect(albedoSignature(null)).toBeUndefined();
    expect(albedoSignature('text')).toBeUndefined();
  });

  it('refuses a signature from another account than the one saved', async () => {
    const switched = albedo({
      signMessage: () => Promise.resolve({ pubkey: OTHER, signedMessage: SIGNATURE_HEX }),
    });
    expect(await refusal(albedoSign('hello', WALLET, switched))).toBe('prove.albedo.otherAccount');
  });

  it('is declined when the person closes its window', async () => {
    const closed = albedo({
      signMessage: () => Promise.reject(new Error('Request was cancelled')),
    });
    expect(await refusal(albedoSign('hello', WALLET, closed))).toBe('prove.declined');
  });
});
