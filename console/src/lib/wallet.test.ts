// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

import { describe, expect, it } from 'vitest';

import {
  MOCK_WALLET,
  albedoSignature,
  bytesToBase64,
  freighterSignature,
  mockWallet,
} from './wallet';

const HEX = 'ab'.repeat(64);

describe('message signatures', () => {
  it('turns bytes into base64', () => {
    expect(bytesToBase64(new Uint8Array([0, 1, 2, 253, 254, 255]))).toBe('AAEC/f7/');
  });

  it('reads both Freighter answer shapes and treats an empty one as declined', () => {
    expect(freighterSignature('c2ln')).toBe('c2ln');
    expect(freighterSignature(new Uint8Array([1, 2, 3]))).toBe('AQID');
    expect(freighterSignature('')).toBeNull();
    expect(freighterSignature(null)).toBeNull();
    expect(freighterSignature(new Uint8Array())).toBeNull();
  });

  it('takes the SEP-53 signedMessage from Albedo, as hex, and never message_signature', () => {
    expect(albedoSignature({ signedMessage: HEX, message_signature: 'cd'.repeat(64) })).toBe(HEX);
    expect(albedoSignature({ message_signature: 'cd'.repeat(64) })).toBeNull();
    expect(albedoSignature({ signedMessage: 'ab' })).toBeNull();
    expect(albedoSignature({ signedMessage: 'zz'.repeat(64) })).toBeNull();
    expect(albedoSignature(null)).toBeNull();
  });

  it('gives the demo wallet a signature, never the message itself', async () => {
    const sig = await mockWallet(MOCK_WALLET).signMessage('secret words');
    expect(sig).not.toBe('');
    expect(atob(sig)).not.toContain('secret');
  });
});
