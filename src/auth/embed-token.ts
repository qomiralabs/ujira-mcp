// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The embed token, `ujes_<env>_<secret><checksum>`, lets the onboarding widget
// act for one recipient for a short while. It cannot be mistaken for an API
// key, whose format is its own, so a token sent to the wrong kind of route is
// refused in memory before anything is looked up.
//
// The secret is 52 base32 characters, 256 random bits, and only its SHA-256 is
// stored. The whole token is lower case letters, digits and underscores, so it
// goes into an invite link as it is.

import { randomBytes } from 'node:crypto';

import { base32, checksumOf, hashSecret, type TokenEnvironment } from './token.js';

const SECRET_BYTES = 32;
const EMBED_TOKEN = /^(ujes_(live|test))_([a-z2-7]{52})([a-z2-7]{7})$/;

export interface IssuedEmbedToken {
  /** The whole token. Handed over once and never stored. */
  readonly token: string;
  readonly secretSha256: Buffer;
}

export interface ParsedEmbedToken {
  readonly environment: TokenEnvironment;
  readonly secretSha256: Buffer;
}

export function issueEmbedToken(environment: TokenEnvironment): IssuedEmbedToken {
  const secret = base32(randomBytes(SECRET_BYTES));
  const body = `ujes_${environment}_${secret}`;
  return { token: `${body}${checksumOf(body)}`, secretSha256: hashSecret(secret) };
}

/** The parts of a well formed embed token, or null for anything else. Touches nothing. */
export function parseEmbedToken(text: string): ParsedEmbedToken | null {
  const match = EMBED_TOKEN.exec(text);
  if (match === null) return null;
  const [, lead, environment, secret, checksum] = match;
  /* v8 ignore next -- the pattern has all four groups, so a match fills them. */
  if (lead === undefined || secret === undefined || checksum === undefined) return null;
  if (checksumOf(`${lead}_${secret}`) !== checksum) return null;
  return { environment: environment as TokenEnvironment, secretSha256: hashSecret(secret) };
}
