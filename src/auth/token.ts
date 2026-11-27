// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The API key format: `ujk_<env>_<id>_<secret><checksum>`.
//
// - env is live or test, so a key says where it works before anything is looked up.
// - id is 16 base32 characters, 80 random bits. `ujk_<env>_<id>` is the prefix: the
//   public part that names a key, safe to store and to show in a dashboard.
// - secret is 52 base32 characters, 256 random bits. Only its SHA-256 is stored.
// - checksum is 7 base32 characters of CRC32 over everything before it. It is not
//   a security control: it lets a typo or a stray string be refused without
//   spending a database call on it.

import { createHash, randomBytes } from 'node:crypto';
import { crc32 } from 'node:zlib';

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';
const TOKEN = /^(ujk_(live|test)_[a-z2-7]{16})_([a-z2-7]{52})([a-z2-7]{7})$/;

const ID_BYTES = 10;
const SECRET_BYTES = 32;
const CHECKSUM_LENGTH = 7;

export type TokenEnvironment = 'live' | 'test';

export interface ParsedToken {
  readonly environment: TokenEnvironment;
  readonly prefix: string;
  readonly secret: string;
}

export interface IssuedToken {
  /** The whole key. Shown to its owner once and never stored. */
  readonly token: string;
  readonly prefix: string;
  readonly secretSha256: Buffer;
}

/** Keys say which network they work on, so a test key pasted into production fails before any lookup. */
export function tokenEnvironmentFor(network: 'testnet' | 'pubnet'): TokenEnvironment {
  return network === 'pubnet' ? 'live' : 'test';
}

export function base32(bytes: Uint8Array): string {
  let out = '';
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += ALPHABET.charAt((buffer >>> bits) & 31);
    }
    buffer &= (1 << bits) - 1;
  }
  return bits === 0 ? out : out + ALPHABET.charAt((buffer << (5 - bits)) & 31);
}

export function checksumOf(body: string): string {
  let value = crc32(body);
  let out = '';
  for (let at = 0; at < CHECKSUM_LENGTH; at += 1) {
    out = ALPHABET.charAt(value % 32) + out;
    value = Math.floor(value / 32);
  }
  return out;
}

/** SHA-256 of a key's secret part, which is what the database holds. */
export function hashSecret(secret: string): Buffer {
  return createHash('sha256').update(secret, 'utf8').digest();
}

/** The parts of a well formed key, or null for anything else. Touches nothing. */
export function parseToken(text: string): ParsedToken | null {
  const match = TOKEN.exec(text);
  if (match === null) return null;
  const [, prefix, environment, secret, checksum] = match;
  /* v8 ignore next -- the pattern has all four groups, so a match fills them. */
  if (prefix === undefined || secret === undefined || checksum === undefined) return null;
  if (checksumOf(`${prefix}_${secret}`) !== checksum) return null;
  return { environment: environment as TokenEnvironment, prefix, secret };
}

/** The key text for a prefix and a secret, with its checksum. */
export function formatToken(prefix: string, secret: string): string {
  const body = `${prefix}_${secret}`;
  return `${body}${checksumOf(body)}`;
}

/** A new key. The caller stores the prefix and the hash, and shows the token once. */
export function issueToken(environment: TokenEnvironment): IssuedToken {
  const prefix = `ujk_${environment}_${base32(randomBytes(ID_BYTES))}`;
  const secret = base32(randomBytes(SECRET_BYTES));
  return { token: formatToken(prefix, secret), prefix, secretSha256: hashSecret(secret) };
}
