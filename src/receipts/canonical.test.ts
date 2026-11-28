// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

import { expect, test } from 'vitest';

import { canonicalJson, sha256Hex } from './canonical.js';
import { ReceiptNotCanonicalError } from './errors.js';

function refusal(value: unknown): ReceiptNotCanonicalError {
  try {
    canonicalJson(value);
  } catch (error) {
    if (error instanceof ReceiptNotCanonicalError) return error;
    throw error;
  }
  throw new Error('expected the value to be refused');
}

test('keys are sorted at every level and there is no whitespace', () => {
  expect(canonicalJson({ b: 1, a: { d: [3, { z: true, y: null }], c: 'x' } })).toBe(
    '{"a":{"c":"x","d":[3,{"y":null,"z":true}]},"b":1}',
  );
});

test('keys sort by UTF-16 code unit, not by locale', () => {
  // U+00E9 sorts after "z"; U+1F600 is a surrogate pair starting 0xD83D,
  // which sorts before U+FF5E even though its code point is higher.
  expect(canonicalJson({ z: 1, é: 2, A: 3, '\u{1F600}': 4, '～': 5 })).toBe(
    '{"A":3,"z":1,"é":2,"\u{1F600}":4,"～":5}',
  );
});

test('strings are escaped the way JSON.stringify escapes them', () => {
  expect(canonicalJson('a"b\\c\n\u0001')).toBe('"a\\"b\\\\c\\n\\u0001"');
  expect(canonicalJson({ 'q"': 'ok' })).toBe('{"q\\"":"ok"}');
});

test('scalars encode as plain JSON', () => {
  expect(canonicalJson(null)).toBe('null');
  expect(canonicalJson(true)).toBe('true');
  expect(canonicalJson(false)).toBe('false');
  expect(canonicalJson(-0)).toBe('0');
  expect(canonicalJson(Number.MAX_SAFE_INTEGER)).toBe('9007199254740991');
  expect(canonicalJson([])).toBe('[]');
  expect(canonicalJson({})).toBe('{}');
  expect(canonicalJson(Object.create(null))).toBe('{}');
});

test('anything with more than one spelling is refused with its path', () => {
  const cases: [unknown, string, string][] = [
    [{ a: 1.5 }, '$.a', 'numbers must be safe integers'],
    [{ a: Number.MAX_SAFE_INTEGER + 1 }, '$.a', 'numbers must be safe integers'],
    [[Number.NaN], '$[0]', 'numbers must be safe integers'],
    [{ a: 1n }, '$.a', 'bigint has no canonical form'],
    [{ a: undefined }, '$.a', 'undefined has no canonical form'],
    [{ a: () => 1 }, '$.a', 'function has no canonical form'],
    [{ a: Symbol('s') }, '$.a', 'symbol has no canonical form'],
    [{ a: new Date(0) }, '$.a', 'not a plain object'],
    [{ a: new Map() }, '$.a', 'not a plain object'],
    [{ a: 'x\uD800' }, '$.a', 'malformed string'],
    [{ '\uDC00': 1 }, '$.\uDC00', 'malformed string'],
    [{ [Symbol('k')]: 1 }, '$', 'symbol keys'],
  ];
  for (const [value, path, reason] of cases) {
    const error = refusal(value);
    expect(error.path).toBe(path);
    expect(error.message).toBe(`not canonical at ${path}: ${reason}`);
  }
});

test('holes in arrays are refused', () => {
  // eslint has no say over a sparse literal here, so it is built explicitly.
  const sparse: unknown[] = [];
  sparse.length = 2;
  sparse[1] = 1;
  expect(refusal({ list: sparse }).path).toBe('$.list');
});

test('accessors are refused, so the hash and the stored value cannot differ', () => {
  const record = {};
  Object.defineProperty(record, 'a', { get: () => 1, enumerable: true });
  expect(refusal(record).path).toBe('$.a');
});

test('nesting is bounded', () => {
  let deep: unknown = 1;
  for (let i = 0; i < 40; i += 1) deep = [deep];
  expect(refusal(deep).message).toMatch(/nested too deeply$/);
  let ok: unknown = 1;
  for (let i = 0; i < 32; i += 1) ok = [ok];
  expect(canonicalJson(ok)).toBe(`${'['.repeat(32)}1${']'.repeat(32)}`);
});

test('the hash is lowercase hex SHA-256 over UTF-8', () => {
  expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  expect(sha256Hex('é')).toBe(sha256Hex('é'));
  expect(sha256Hex('é')).not.toBe(sha256Hex('é'));
});
