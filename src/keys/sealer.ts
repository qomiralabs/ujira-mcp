// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// Seals small secrets and personal data under the key encryption key, with
// AES-256-GCM. Every sealed value is bound to where it belongs through the
// associated data: a ciphertext copied to another project's row, another
// recipient, or another kind of field does not open there.
//
// The key never leaves this closure, and no error carries the key, the
// plaintext or the associated data.

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const ALGORITHM = 'aes-256-gcm';

export interface Sealed {
  // The ciphertext with the 16 byte tag after it.
  readonly ciphertext: Buffer;
  readonly nonce: Buffer;
}

export interface Sealer {
  seal(plaintext: Buffer, associatedData: string): Sealed;
  // Throws SealError when the value was not sealed under this key and this
  // associated data, or was changed since.
  open(sealed: Sealed, associatedData: string): Buffer;
}

export type SealErrorCode = 'KEY_INVALID' | 'OPEN_FAILED';

export class SealError extends Error {
  override readonly name = 'SealError';

  constructor(
    readonly code: SealErrorCode,
    message: string,
  ) {
    super(message);
  }
}

// Strict base64 of exactly 32 bytes, so a key pasted with a stray character or
// cut short is refused at start rather than quietly decoded to other bytes.
function keyFrom(base64: string): Buffer {
  const key = Buffer.from(base64, 'base64');
  if (
    !/^[A-Za-z0-9+/]+={0,2}$/.test(base64) ||
    key.length !== KEY_BYTES ||
    key.toString('base64') !== base64
  ) {
    throw new SealError('KEY_INVALID', 'the key encryption key must be 32 bytes of base64');
  }
  return key;
}

export function createSealer(keyBase64: string): Sealer {
  const key = keyFrom(keyBase64);
  return {
    seal(plaintext, associatedData) {
      // A fresh random nonce per value. GCM is safe for far more values under
      // one key than a project will ever seal.
      const nonce = randomBytes(NONCE_BYTES);
      const cipher = createCipheriv(ALGORITHM, key, nonce, { authTagLength: TAG_BYTES });
      cipher.setAAD(Buffer.from(associatedData, 'utf8'));
      const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      return { ciphertext: Buffer.concat([body, cipher.getAuthTag()]), nonce };
    },
    open(sealed, associatedData) {
      if (sealed.nonce.length !== NONCE_BYTES || sealed.ciphertext.length < TAG_BYTES) {
        throw new SealError('OPEN_FAILED', 'the sealed value is not one this key sealed');
      }
      const body = sealed.ciphertext.subarray(0, sealed.ciphertext.length - TAG_BYTES);
      const tag = sealed.ciphertext.subarray(sealed.ciphertext.length - TAG_BYTES);
      try {
        const decipher = createDecipheriv(ALGORITHM, key, sealed.nonce, {
          authTagLength: TAG_BYTES,
        });
        decipher.setAAD(Buffer.from(associatedData, 'utf8'));
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(body), decipher.final()]);
      } catch {
        // The cause is dropped on purpose: what OpenSSL says adds nothing a
        // caller can act on, and the one answer is that this value is not ours.
        throw new SealError('OPEN_FAILED', 'the sealed value is not one this key sealed');
      }
    },
  };
}
