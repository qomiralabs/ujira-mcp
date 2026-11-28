// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The receipt hash has to come out the same in every language a verifier
// might use, so the encoding is deliberately small: object keys sorted by
// UTF-16 code unit (the order RFC 8785 uses), no whitespace, strings escaped
// the way JSON.stringify escapes them, and integers only. Anything that has
// more than one reasonable spelling (floats, bigints, dates, undefined) is
// refused rather than guessed at, so two encoders can never disagree.

import { createHash } from 'node:crypto';

import { ReceiptNotCanonicalError } from './errors.js';

export type CanonicalValue =
  | string
  | number
  | boolean
  | null
  | readonly CanonicalValue[]
  | { readonly [key: string]: CanonicalValue };

// Receipts nest four levels deep. The cap keeps a hostile document from
// exhausting the stack before it is refused.
const MAX_DEPTH = 32;

// A high surrogate not followed by a low one, or a low one not after a high
// one. String.prototype.isWellFormed says the same, but is newer than the
// library this builds against.
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function isPlainObject(value: object): boolean {
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function encodeString(text: string, path: string): string {
  // A lone surrogate has no UTF-8 encoding, so its hash would depend on how
  // each verifier happened to replace it.
  if (LONE_SURROGATE.test(text)) throw new ReceiptNotCanonicalError(path, 'malformed string');
  return JSON.stringify(text);
}

function encodeNumber(value: number, path: string): string {
  if (!Number.isSafeInteger(value)) {
    throw new ReceiptNotCanonicalError(path, 'numbers must be safe integers');
  }
  // String(-0) is "0", the same as JSON.stringify.
  return String(value);
}

function encodeArray(list: readonly unknown[], path: string, depth: number): string {
  const parts: string[] = [];
  for (const index of list.keys()) {
    // A hole would be read through Array.prototype, so it is refused.
    if (!Object.hasOwn(list, index)) throw new ReceiptNotCanonicalError(path, 'sparse array');
    parts.push(encode(list[index], `${path}[${String(index)}]`, depth + 1));
  }
  return `[${parts.join(',')}]`;
}

function encodeObject(record: object, path: string, depth: number): string {
  if (!isPlainObject(record)) throw new ReceiptNotCanonicalError(path, 'not a plain object');
  if (Object.getOwnPropertySymbols(record).length > 0) {
    throw new ReceiptNotCanonicalError(path, 'symbol keys');
  }
  const parts: string[] = [];
  // Default sort compares UTF-16 code units, which is the order the hash fixes.
  for (const key of Object.keys(record).sort()) {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    // A getter could answer differently for the hash and for storage.
    if (descriptor === undefined || !('value' in descriptor)) {
      throw new ReceiptNotCanonicalError(`${path}.${key}`, 'accessor property');
    }
    const childPath = `${path}.${key}`;
    parts.push(`${encodeString(key, childPath)}:${encode(descriptor.value, childPath, depth + 1)}`);
  }
  return `{${parts.join(',')}}`;
}

function encode(value: unknown, path: string, depth: number): string {
  if (depth > MAX_DEPTH) throw new ReceiptNotCanonicalError(path, 'nested too deeply');
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return encodeString(value, path);
    case 'number':
      return encodeNumber(value, path);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'object':
      return Array.isArray(value)
        ? encodeArray(value as readonly unknown[], path, depth)
        : encodeObject(value, path, depth);
    default:
      // bigint, undefined, functions and symbols have no JSON form, and
      // JSON.stringify would drop or throw on them inconsistently.
      throw new ReceiptNotCanonicalError(path, `${typeof value} has no canonical form`);
  }
}

/**
 * The canonical JSON text of `value`. Throws ReceiptNotCanonicalError for
 * anything outside plain objects, arrays, strings, safe integers, booleans
 * and null.
 */
export function canonicalJson(value: unknown): string {
  return encode(value, '$', 0);
}

/** Lowercase hex SHA-256 of the UTF-8 bytes of `text`. */
export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}
