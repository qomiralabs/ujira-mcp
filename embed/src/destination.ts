// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// Reads a Stellar wallet destination the way UJIRA's onboarding does, so a
// recipient hears about a mistake while they still have their wallet open.
// The server reads it again and is the authority: anything this lets through
// that the server refuses comes back as a refusal and is shown the same way.
//
// The rules mirror the server's, in the same order:
//   - G, M and C addresses only, each with a valid checksum;
//   - never the all zero key, which nobody can sign for;
//   - a memo only as a numeric id, since a payout from a mandate cannot carry
//     a text or hash memo, and never next to an M or a C;
//   - never an address that can never be paid out to, such as the USDC
//     issuer, which the session lists. An M is looked through to its account.

import type { MessageKey } from './i18n/catalogue.js';

/** A destination the widget is ready to send. */
export interface WalletDestination {
  address: string;
  /** The numeric memo, as text so a 64 bit id survives, or empty. */
  memo: string;
}

export type DestinationReading =
  | { ok: true; destination: WalletDestination }
  | { ok: false; field: 'address' | 'memo'; problem: MessageKey };

const VERSION = { account: 6 << 3, muxed: 12 << 3, contract: 2 << 3 } as const;
const KEY_BYTES = 32;
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
// A memo id is a u64 in decimal. A leading zero would not survive the trip
// to a number, so digits with one are a text memo that only looks numeric.
const MEMO_ID = /^(?:0|[1-9][0-9]*)$/;
const U64_MAX = (1n << 64n) - 1n;

function crc16(bytes: Uint8Array): number {
  let crc = 0;
  for (const byte of bytes) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}

/** The bytes of a base32 strkey, or undefined when it is not one. */
function base32(text: string): Uint8Array | undefined {
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const character of text) {
    const value = ALPHABET.indexOf(character);
    if (value < 0) return undefined;
    buffer = ((buffer << 5) | value) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }
  // Leftover bits must be zero, or two spellings would decode alike.
  if ((buffer & ((1 << bits) - 1)) !== 0) return undefined;
  return Uint8Array.from(bytes);
}

type Strkey = 'malformed' | 'checksum' | Uint8Array;

/** The payload of a strkey of this version and size, or what is wrong with it. */
function readStrkey(text: string, version: number, payloadBytes: number): Strkey {
  // The exact length first: a trailing character can carry only zero bits
  // and still decode to the same bytes.
  if (text.length !== Math.ceil(((1 + payloadBytes + 2) * 8) / 5)) return 'malformed';
  const bytes = base32(text);
  if (bytes?.length !== 1 + payloadBytes + 2) return 'malformed';
  const body = 1 + payloadBytes;
  const crc = crc16(bytes.subarray(0, body));
  if (bytes[body] !== (crc & 0xff) || bytes[body + 1] !== crc >> 8) return 'checksum';
  if (bytes[0] !== version) return 'malformed';
  return bytes.subarray(1, body);
}

/** A strkey: the version byte, the payload and its checksum, in base32. */
function encodeStrkey(version: number, payload: Uint8Array): string {
  const bytes = new Uint8Array(1 + payload.length + 2);
  bytes[0] = version;
  bytes.set(payload, 1);
  const crc = crc16(bytes.subarray(0, 1 + payload.length));
  bytes[1 + payload.length] = crc & 0xff;
  bytes[2 + payload.length] = crc >> 8;
  let text = '';
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = ((buffer << 8) | byte) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      text += ALPHABET.charAt((buffer >> bits) & 31);
    }
  }
  if (bits > 0) text += ALPHABET.charAt((buffer << (5 - bits)) & 31);
  return text;
}

/** The G address for a public key. */
export function encodeAccountAddress(key: Uint8Array): string {
  return encodeStrkey(VERSION.account, key);
}

/** The M address for a public key and a muxed id. */
export function encodeMuxedAddress(key: Uint8Array, id: bigint): string {
  const payload = new Uint8Array(KEY_BYTES + 8);
  payload.set(key);
  new DataView(payload.buffer).setBigUint64(KEY_BYTES, id);
  return encodeStrkey(VERSION.muxed, payload);
}

/** The C address for a contract id. */
export function encodeContractAddress(id: Uint8Array): string {
  return encodeStrkey(VERSION.contract, id);
}

const FORMS: Readonly<Record<string, { version: number; bytes: number }>> = {
  G: { version: VERSION.account, bytes: KEY_BYTES },
  M: { version: VERSION.muxed, bytes: KEY_BYTES + 8 },
  C: { version: VERSION.contract, bytes: KEY_BYTES },
};

/**
 * The account a destination pays: an M is looked through to its G, so the
 * unpayable list cannot be stepped around with a muxed spelling.
 */
function paidAccount(address: string, payload: Uint8Array): string {
  return address.startsWith('M') ? encodeAccountAddress(payload.subarray(0, KEY_BYTES)) : address;
}

/**
 * Reads what the recipient typed. Spaces around either value are dropped,
 * since a copied address often carries one; anything inside is a mistake.
 * `neverPayable` comes from the session: the addresses the network settles
 * through, which a payout would burn.
 */
export function readWalletDestination(
  addressText: string,
  memoText: string,
  neverPayable: readonly string[],
): DestinationReading {
  const address = addressText.trim();
  const memo = memoText.trim();
  if (address === '') return { ok: false, field: 'address', problem: 'destination.wallet.missing' };
  const form = FORMS[address.charAt(0)];
  const payload = form === undefined ? 'malformed' : readStrkey(address, form.version, form.bytes);
  if (typeof payload === 'string') {
    return { ok: false, field: 'address', problem: 'destination.wallet.invalid' };
  }
  if (payload.subarray(0, KEY_BYTES).every((byte) => byte === 0)) {
    return { ok: false, field: 'address', problem: 'destination.wallet.invalid' };
  }
  if (memo !== '') {
    if (!address.startsWith('G')) {
      return { ok: false, field: 'memo', problem: 'destination.memo.notNeeded' };
    }
    if (!MEMO_ID.test(memo)) {
      return { ok: false, field: 'memo', problem: 'destination.memo.unsupported' };
    }
    if (memo.length > 20 || BigInt(memo) > U64_MAX) {
      return { ok: false, field: 'memo', problem: 'destination.memo.tooLong' };
    }
  }
  if (neverPayable.includes(paidAccount(address, payload))) {
    return { ok: false, field: 'address', problem: 'destination.wallet.unpayable' };
  }
  return { ok: true, destination: { address, memo } };
}
