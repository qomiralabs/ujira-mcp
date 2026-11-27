// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// Values the domain repositories take from callers and turn into what the
// columns hold. None of the errors here repeats the value it refused, so an
// address or a hash never lands in a log line through one.

// What the chain adapter's parseAccount does: the one canonical spelling of an
// account address, or a throw. The repositories take it as an argument rather
// than trusting that the caller already ran it, because the database checks
// only an address's shape, and the same wallet written two ways would be two
// destinations, two agents or two owners. The adapter itself is passed here; the
// database module stays free of any chain code.
export interface AccountParser {
  readonly parseAccount: (raw: string) => string;
}

// A value from a caller that no row can hold. Named by field only.
export class RepositoryInputError extends Error {
  override readonly name = 'RepositoryInputError';

  constructor(readonly field: string) {
    super(`${field} is not a value this repository can store`);
  }
}

const HEX32 = /^[0-9a-f]{64}$/;

// Hashes travel through the engine and to the chain as 64 lowercase hex
// digits, and are stored as their 32 bytes.
export function hex32Bytes(value: string, field: string): Buffer {
  if (!HEX32.test(value)) throw new RepositoryInputError(field);
  return Buffer.from(value, 'hex');
}

export function bytesHex32(value: Buffer): string {
  return value.toString('hex');
}
