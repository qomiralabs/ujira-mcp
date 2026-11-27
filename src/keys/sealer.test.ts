// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { createSealer, SealError } from './sealer.js';

const KEY = randomBytes(32).toString('base64');

function openError(work: () => unknown): SealError {
  try {
    work();
  } catch (error) {
    if (error instanceof SealError) return error;
    throw error;
  }
  throw new Error('expected a SealError');
}

describe('createSealer', () => {
  it('opens what it sealed, under the same associated data', () => {
    const sealer = createSealer(KEY);
    const sealed = sealer.seal(Buffer.from('ada@example.org'), 'email:p1:r1');
    expect(sealed.nonce).toHaveLength(12);
    expect(sealed.ciphertext).toHaveLength('ada@example.org'.length + 16);
    expect(sealer.open(sealed, 'email:p1:r1').toString()).toBe('ada@example.org');
  });

  it('never writes the plaintext into the ciphertext', () => {
    const sealed = createSealer(KEY).seal(Buffer.from('ada@example.org'), 'a');
    expect(sealed.ciphertext.includes(Buffer.from('ada@example.org'))).toBe(false);
  });

  it('uses a fresh nonce for every value', () => {
    const sealer = createSealer(KEY);
    const one = sealer.seal(Buffer.from('same'), 'a');
    const two = sealer.seal(Buffer.from('same'), 'a');
    expect(one.nonce.equals(two.nonce)).toBe(false);
    expect(one.ciphertext.equals(two.ciphertext)).toBe(false);
  });

  it('refuses a value moved to other associated data, such as another project', () => {
    const sealer = createSealer(KEY);
    const sealed = sealer.seal(Buffer.from('ada@example.org'), 'email:p1:r1');
    const error = openError(() => sealer.open(sealed, 'email:p2:r1'));
    expect(error.code).toBe('OPEN_FAILED');
    expect(error.message).not.toContain('p2');
  });

  it('refuses a value sealed under another key', () => {
    const sealed = createSealer(KEY).seal(Buffer.from('x'), 'a');
    const other = createSealer(randomBytes(32).toString('base64'));
    expect(openError(() => other.open(sealed, 'a')).code).toBe('OPEN_FAILED');
  });

  it('refuses a changed ciphertext, tag or nonce', () => {
    const sealer = createSealer(KEY);
    const sealed = sealer.seal(Buffer.from('ada@example.org'), 'a');
    const flipped = Buffer.from(sealed.ciphertext);
    flipped[0] = (flipped[0] ?? 0) ^ 1;
    expect(openError(() => sealer.open({ ...sealed, ciphertext: flipped }, 'a')).code).toBe(
      'OPEN_FAILED',
    );
    const nonce = Buffer.from(sealed.nonce);
    nonce[0] = (nonce[0] ?? 0) ^ 1;
    expect(openError(() => sealer.open({ ...sealed, nonce }, 'a')).code).toBe('OPEN_FAILED');
    expect(
      openError(() => sealer.open({ ciphertext: Buffer.alloc(8), nonce: sealed.nonce }, 'a')).code,
    ).toBe('OPEN_FAILED');
    expect(
      openError(() => sealer.open({ ciphertext: sealed.ciphertext, nonce: Buffer.alloc(8) }, 'a'))
        .code,
    ).toBe('OPEN_FAILED');
  });

  it.each([
    ['empty', ''],
    ['too short', randomBytes(16).toString('base64')],
    ['too long', randomBytes(48).toString('base64')],
    ['not base64', `${KEY.slice(0, -2)}!=`],
    ['unpadded', KEY.replace(/=+$/, '')],
  ])('refuses a key that is %s, without repeating it', (_, key) => {
    const error = openError(() => createSealer(key));
    expect(error.code).toBe('KEY_INVALID');
    if (key !== '') expect(error.message).not.toContain(key);
  });
});
