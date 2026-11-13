// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// Loads signing keys from the environment or from files. A key is only ever
// read here and kept inside a TxSigner; no error, log line or tool answer
// carries it.

import { createHmac, pbkdf2Sync } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { Keypair, StrKey, type Transaction } from '@stellar/stellar-sdk';

import { EngineError } from '../errors.js';
import type { TxSigner } from './gateway.js';

/** SEP-0005: m/44'/148'/0', the path the stellar CLI uses for its identities. */
const STELLAR_PATH = [44, 148, 0];
const HARDENED = 0x80000000;

/** BIP-39 seed from a mnemonic, without a passphrase, as the stellar CLI makes it. */
function mnemonicSeed(mnemonic: string): Buffer {
  const words = mnemonic.normalize('NFKD').trim().split(/\s+/).join(' ');
  return pbkdf2Sync(words, 'mnemonic', 2048, 64, 'sha512');
}

/** SLIP-0010 ed25519 derivation; every step is hardened. */
function deriveEd25519(seed: Buffer, path: readonly number[]): Buffer {
  let digest = createHmac('sha512', 'ed25519 seed').update(seed).digest();
  let key = digest.subarray(0, 32);
  let chain = digest.subarray(32);
  for (const index of path) {
    const data = Buffer.alloc(37);
    key.copy(data, 1);
    data.writeUInt32BE((index | HARDENED) >>> 0, 33);
    digest = createHmac('sha512', chain).update(data).digest();
    key = digest.subarray(0, 32);
    chain = digest.subarray(32);
  }
  return Buffer.from(key);
}

export function keypairFromMnemonic(mnemonic: string): Keypair {
  return Keypair.fromRawEd25519Seed(deriveEd25519(mnemonicSeed(mnemonic), STELLAR_PATH));
}

/**
 * Reads a key from text: a bare secret seed (S...), or a stellar CLI identity
 * file with `secret_key = "S..."` or `seed_phrase = "..."`.
 */
export function keypairFromText(text: string, label: string): Keypair {
  const trimmed = text.trim();
  if (StrKey.isValidEd25519SecretSeed(trimmed)) return Keypair.fromSecret(trimmed);
  const secret = /^\s*secret_key\s*=\s*"([^"]+)"/m.exec(trimmed)?.[1];
  if (secret !== undefined && StrKey.isValidEd25519SecretSeed(secret)) {
    return Keypair.fromSecret(secret);
  }
  const phrase = /^\s*seed_phrase\s*=\s*"([^"]+)"/m.exec(trimmed)?.[1];
  if (phrase !== undefined && phrase.trim().split(/\s+/).length >= 12) {
    return keypairFromMnemonic(phrase);
  }
  // The text is never echoed: it may be a key in a shape we do not read.
  throw new EngineError(
    'config_invalid',
    `${label} does not hold a Stellar secret key we can read`,
  );
}

export function signerFrom(keypair: Keypair): TxSigner {
  return {
    publicKey: keypair.publicKey(),
    sign(tx: Transaction) {
      tx.sign(keypair);
    },
  };
}

type Env = Readonly<Record<string, string | undefined>>;

/**
 * The signer named by `<prefix>_SECRET` or `<prefix>_KEY_FILE`, or undefined
 * when neither is set. Setting both is refused, since one would silently win.
 */
export function signerFromEnv(env: Env, prefix: string): TxSigner | undefined {
  const inline = env[`${prefix}_SECRET`];
  const file = env[`${prefix}_KEY_FILE`];
  if (inline !== undefined && inline !== '' && file !== undefined && file !== '') {
    throw new EngineError('config_invalid', `set ${prefix}_SECRET or ${prefix}_KEY_FILE, not both`);
  }
  if (inline !== undefined && inline !== '') {
    return signerFrom(keypairFromText(inline, `${prefix}_SECRET`));
  }
  if (file !== undefined && file !== '') {
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch (error) {
      throw new EngineError('config_invalid', `${prefix}_KEY_FILE cannot be read`, {
        cause: error,
      });
    }
    return signerFrom(keypairFromText(text, `${prefix}_KEY_FILE`));
  }
  return undefined;
}
