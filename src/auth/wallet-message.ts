// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The one time message a person signs with their wallet to sign in, or to
// prove they hold a wallet that will receive payouts.
//
// The text is fixed line by line so that the server can rebuild it exactly
// from its fields: a message is accepted only if formatting its parsed fields
// gives back the same bytes, which leaves no room for a second reading of the
// same text. The origin is part of the signed text, so a signature collected
// by another site is refused here, and the wallet shows the site's host on the
// first line so the person can see who is asking.
//
// The format, version 1 (every line ends in a single "\n" except the last):
//
//   <host> asks you to sign in with your wallet.
//   Signing proves you hold this wallet. It moves no money and approves nothing.
//
//   Version: 1
//   Purpose: sign_in
//   Origin: <scheme>://<host>
//   Address: <account address>
//   Nonce: <22 to 128 base64url characters>
//   Issued At: <YYYY-MM-DDTHH:mm:ss.sssZ>
//   Expires At: <YYYY-MM-DDTHH:mm:ss.sssZ>
//
// For the purpose recipient_wallet the first line reads "<host> asks you to
// prove you hold this wallet to receive payouts." Wallets sign the text with
// SEP-53; checking that signature is the chain adapter's job, so nothing here
// knows which chain the address is on.

import { randomBytes } from 'node:crypto';

import { z } from 'zod';

export const WALLET_MESSAGE_VERSION = 1;

/** A challenge lives this long; the ADR keeps sign in challenges for 10 minutes. */
export const WALLET_MESSAGE_TTL_MS = 10 * 60 * 1000;

/** Two server instances may disagree on the time by this much. */
export const WALLET_MESSAGE_CLOCK_SKEW_MS = 60 * 1000;

/** Far longer than any valid message, and short enough to refuse junk before parsing. */
const MAX_MESSAGE_LENGTH = 1024;

export const WALLET_MESSAGE_PURPOSES = ['sign_in', 'recipient_wallet'] as const;
export type WalletMessagePurpose = (typeof WALLET_MESSAGE_PURPOSES)[number];

const HEADLINES: Readonly<Record<WalletMessagePurpose, (host: string) => string>> = {
  sign_in: (host) => `${host} asks you to sign in with your wallet.`,
  recipient_wallet: (host) => `${host} asks you to prove you hold this wallet to receive payouts.`,
};

const NOTICE = 'Signing proves you hold this wallet. It moves no money and approves nothing.';

export interface WalletMessage {
  readonly version: typeof WALLET_MESSAGE_VERSION;
  readonly purpose: WalletMessagePurpose;
  readonly origin: string;
  readonly address: string;
  readonly nonce: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
}

export type WalletMessageErrorCode =
  | 'MESSAGE_MALFORMED'
  | 'PURPOSE_MISMATCH'
  | 'ORIGIN_MISMATCH'
  | 'ADDRESS_INVALID'
  | 'ADDRESS_MISMATCH'
  | 'MESSAGE_NOT_YET_VALID'
  | 'MESSAGE_EXPIRED'
  | 'SIGNATURE_MALFORMED'
  | 'SIGNATURE_INVALID'
  | 'NONCE_REUSED';

/**
 * Why a message or its signature was refused. The message text never carries
 * the signature, the nonce or the signed text, so it is safe to log; callers
 * answer every code with the same 401 so the reason does not leak to a client.
 */
export class WalletMessageError extends Error {
  readonly code: WalletMessageErrorCode;

  constructor(code: WalletMessageErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'WalletMessageError';
    this.code = code;
  }
}

/**
 * The part of the chain adapter this module needs. `ChainAdapter` satisfies it,
 * so auth never imports a chain library.
 */
export interface WalletProofVerifier {
  /** The canonical form of an account address; throws if it is not one. */
  parseAccount(raw: string): string;
  /** SEP-53: an ed25519 signature over SHA-256("Stellar Signed Message:\n" + message). */
  verifyWalletProof(address: string, message: string, signatureBase64: string): boolean;
}

/**
 * Where issued nonces are kept. `consume` must be atomic: of two concurrent
 * calls for the same nonce at most one resolves true, and it resolves false
 * for a nonce this server never issued for that address and purpose.
 */
export interface WalletNonceStore {
  consume(message: WalletMessage): Promise<boolean>;
}

const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const timestamp = z
  .string()
  .regex(TIMESTAMP)
  // The regex alone takes 2026-02-30; a round trip through Date does not.
  .refine((s) => !Number.isNaN(Date.parse(s)) && new Date(s).toISOString() === s);

function isLoopback(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

const origin = z
  .string()
  .max(255)
  .refine((s) => {
    if (!URL.canParse(s)) return false;
    const url = new URL(s);
    // Plain http only for a developer's own machine; anything served to people is https.
    const schemeOk =
      url.protocol === 'https:' || (url.protocol === 'http:' && isLoopback(url.hostname));
    return schemeOk && url.origin === s;
  });

const walletMessageSchema = z
  .strictObject({
    version: z.literal(WALLET_MESSAGE_VERSION),
    purpose: z.enum(WALLET_MESSAGE_PURPOSES),
    origin,
    // Chain neutral on purpose: the adapter parses the address when it verifies.
    address: z.string().regex(/^[A-Za-z0-9]{16,128}$/),
    nonce: z.string().regex(/^[A-Za-z0-9_-]{22,128}$/),
    issuedAt: timestamp,
    expiresAt: timestamp,
  })
  .refine((m) => {
    const lifetime = Date.parse(m.expiresAt) - Date.parse(m.issuedAt);
    return lifetime > 0 && lifetime <= WALLET_MESSAGE_TTL_MS;
  });

function malformed(): WalletMessageError {
  return new WalletMessageError(
    'MESSAGE_MALFORMED',
    'The wallet message is not in the expected form.',
  );
}

function checked(fields: WalletMessage): WalletMessage {
  const parsed = walletMessageSchema.safeParse(fields);
  if (!parsed.success) throw malformed();
  return parsed.data;
}

function render(m: WalletMessage): string {
  return [
    HEADLINES[m.purpose](new URL(m.origin).host),
    NOTICE,
    '',
    `Version: ${m.version}`,
    `Purpose: ${m.purpose}`,
    `Origin: ${m.origin}`,
    `Address: ${m.address}`,
    `Nonce: ${m.nonce}`,
    `Issued At: ${m.issuedAt}`,
    `Expires At: ${m.expiresAt}`,
  ].join('\n');
}

/** The exact text the wallet signs. Throws MESSAGE_MALFORMED for fields outside the format. */
export function formatWalletMessage(fields: WalletMessage): string {
  return render(checked(fields));
}

/** A fresh nonce: 16 random bytes, base64url. */
export function newWalletNonce(): string {
  return randomBytes(16).toString('base64url');
}

/** A new challenge for `address`, issued at `now` and valid for `ttlMs`. */
export function createWalletMessage(p: {
  readonly purpose: WalletMessagePurpose;
  readonly origin: string;
  readonly address: string;
  readonly now?: Date;
  readonly ttlMs?: number;
}): { readonly message: WalletMessage; readonly text: string } {
  const now = p.now ?? new Date();
  const message = checked({
    version: WALLET_MESSAGE_VERSION,
    purpose: p.purpose,
    origin: p.origin,
    address: p.address,
    nonce: newWalletNonce(),
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + (p.ttlMs ?? WALLET_MESSAGE_TTL_MS)).toISOString(),
  });
  return { message, text: render(message) };
}

const FIELD_LINES = [
  ['Version', 'version'],
  ['Purpose', 'purpose'],
  ['Origin', 'origin'],
  ['Address', 'address'],
  ['Nonce', 'nonce'],
  ['Issued At', 'issuedAt'],
  ['Expires At', 'expiresAt'],
] as const;

/** Reads a message back into its fields. Throws MESSAGE_MALFORMED unless the text is exactly the format. */
export function parseWalletMessage(text: string): WalletMessage {
  if (text.length > MAX_MESSAGE_LENGTH) throw malformed();
  const lines = text.split('\n');
  if (lines.length !== 3 + FIELD_LINES.length) throw malformed();
  const raw: Record<string, string> = {};
  for (const [index, [label, key]] of FIELD_LINES.entries()) {
    const line = lines[3 + index] ?? '';
    const prefix = `${label}: `;
    if (!line.startsWith(prefix)) throw malformed();
    raw[key] = line.slice(prefix.length);
  }
  const fields = walletMessageSchema.safeParse({ ...raw, version: Number(raw['version']) });
  if (!fields.success) throw malformed();
  // The headline, the notice and the version digits are only checked here, by
  // rebuilding the whole text; "Version: 01" or a changed headline fail.
  if (render(fields.data) !== text) throw malformed();
  return fields.data;
}

const HEX_SIGNATURE = /^[0-9a-fA-F]{128}$/;
const BASE64_SIGNATURE = /^[A-Za-z0-9+/]{86}==$/;

/**
 * Wallets hand back a 64 byte signature in different encodings: Freighter as
 * base64, Albedo as hex. Returns the canonical base64 the adapter takes, or
 * throws SIGNATURE_MALFORMED.
 */
export function walletSignatureToBase64(raw: string): string {
  if (HEX_SIGNATURE.test(raw)) return Buffer.from(raw, 'hex').toString('base64');
  if (BASE64_SIGNATURE.test(raw)) {
    const bytes = Buffer.from(raw, 'base64');
    // Node ignores stray low bits in the last character; a canonical encoding
    // is the only one that round trips, so two strings never mean one signature.
    if (bytes.length === 64 && bytes.toString('base64') === raw) return raw;
  }
  throw new WalletMessageError(
    'SIGNATURE_MALFORMED',
    'The signature is not a 64 byte signature in base64 or hex.',
  );
}

export interface VerifyWalletMessageInput {
  /** The text the wallet signed, as the client sent it back. */
  readonly message: string;
  /** The address the client claims signed it. */
  readonly address: string;
  /** The signature as the wallet returned it, base64 or hex. */
  readonly signature: string;
  readonly expected: { readonly purpose: WalletMessagePurpose; readonly origin: string };
  readonly now?: Date;
}

/**
 * Checks a signed wallet message and uses up its nonce. Resolves with the
 * message fields, or rejects with a WalletMessageError. Errors from the
 * verifier or the store are not caught: an outage is not a bad signature.
 *
 * The nonce is consumed last, so a request with a bad signature does not burn
 * the challenge of the person it was issued to.
 */
export async function verifyWalletMessage(
  input: VerifyWalletMessageInput,
  deps: { readonly verifier: WalletProofVerifier; readonly nonces: WalletNonceStore },
): Promise<WalletMessage> {
  const message = parseWalletMessage(input.message);
  if (message.purpose !== input.expected.purpose) {
    throw new WalletMessageError('PURPOSE_MISMATCH', 'The message was signed for another purpose.');
  }
  if (message.origin !== input.expected.origin) {
    throw new WalletMessageError('ORIGIN_MISMATCH', 'The message was signed for another site.');
  }

  let address: string;
  try {
    address = deps.verifier.parseAccount(input.address);
  } catch (cause) {
    throw new WalletMessageError('ADDRESS_INVALID', 'The address is not a valid account.', {
      cause,
    });
  }
  if (address !== message.address) {
    throw new WalletMessageError('ADDRESS_MISMATCH', 'The message names a different address.');
  }

  const now = (input.now ?? new Date()).getTime();
  if (now < Date.parse(message.issuedAt) - WALLET_MESSAGE_CLOCK_SKEW_MS) {
    throw new WalletMessageError('MESSAGE_NOT_YET_VALID', 'The message is not valid yet.');
  }
  if (now >= Date.parse(message.expiresAt)) {
    throw new WalletMessageError('MESSAGE_EXPIRED', 'The message has expired.');
  }

  const signature = walletSignatureToBase64(input.signature);
  if (!deps.verifier.verifyWalletProof(address, input.message, signature)) {
    throw new WalletMessageError('SIGNATURE_INVALID', 'The signature does not match the address.');
  }
  if (!(await deps.nonces.consume(message))) {
    throw new WalletMessageError('NONCE_REUSED', 'The message was already used or never issued.');
  }
  return message;
}
