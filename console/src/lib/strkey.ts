// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// Checks Stellar addresses the way the network does: base32, the right
// version byte and a CRC16 checksum, so a mistyped character is caught here
// instead of by a failed transaction.

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const VERSION = { account: 6 << 3, contract: 2 << 3 } as const;

function base32Decode(input: string): Uint8Array | null {
  const out: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const ch of input) {
    const value = ALPHABET.indexOf(ch);
    if (value < 0) return null;
    buffer = (buffer << 5) | value;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 0xff);
    }
  }
  return Uint8Array.from(out);
}

function crc16xmodem(bytes: Uint8Array): number {
  let crc = 0;
  for (const byte of bytes) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}

function check(address: string, version: number): boolean {
  if (address.length !== 56) return false;
  const raw = base32Decode(address);
  if (raw?.length !== 35) return false;
  if (raw[0] !== version) return false;
  const body = raw.subarray(0, 33);
  const expected = crc16xmodem(body);
  const actual = (raw[33] ?? 0) | ((raw[34] ?? 0) << 8);
  return expected === actual;
}

function base32Encode(bytes: Uint8Array): string {
  let out = '';
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += ALPHABET[(buffer >> bits) & 31] ?? '';
    }
  }
  if (bits > 0) out += ALPHABET[(buffer << (5 - bits)) & 31] ?? '';
  return out;
}

/** The strkey of 32 bytes, used by the mock mode to make valid looking addresses. */
export function encodeAddress(kind: keyof typeof VERSION, payload: Uint8Array): string {
  if (payload.length !== 32) throw new Error('an address payload is 32 bytes');
  const body = new Uint8Array(33);
  body[0] = VERSION[kind];
  body.set(payload, 1);
  const crc = crc16xmodem(body);
  const full = new Uint8Array(35);
  full.set(body);
  full[33] = crc & 0xff;
  full[34] = crc >> 8;
  return base32Encode(full);
}

/** A Stellar wallet address (G...). */
export function isAccountAddress(value: string): boolean {
  return check(value, VERSION.account);
}

/** A Soroban contract address (C...). */
export function isContractAddress(value: string): boolean {
  return check(value, VERSION.contract);
}

/** "GABC...WXYZ", for places where the full address does not fit. */
export function shortAddress(value: string, keep = 4): string {
  return value.length <= keep * 2 + 3 ? value : `${value.slice(0, keep)}...${value.slice(-keep)}`;
}

/** A sentence explaining what is wrong with a typed wallet address, or null. */
export function accountAddressProblem(value: string): string | null {
  const v = value.trim();
  if (v === '') return 'Paste a Stellar wallet address.';
  if (v.startsWith('C'))
    return 'That is a contract address. Paste a wallet address, starting with G.';
  if (v.startsWith('S')) {
    return 'That looks like a secret key. Never share it. Paste the public address, starting with G.';
  }
  if (!v.startsWith('G')) return 'Stellar wallet addresses start with G.';
  if (v.length !== 56) return `A wallet address has 56 characters; this one has ${v.length}.`;
  if (!isAccountAddress(v)) return 'This address has a typo: its checksum does not match.';
  return null;
}
