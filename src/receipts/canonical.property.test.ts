// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

import fc from 'fast-check';
import { expect, test } from 'vitest';

import { canonicalJson, sha256Hex } from './canonical.js';

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

const { json } = fc.letrec<{ json: Json; list: Json[]; record: Record<string, Json> }>((tie) => ({
  json: fc.oneof(
    { depthSize: 'small', withCrossShrink: true },
    fc.string({ unit: 'grapheme' }),
    fc.integer(),
    fc.boolean(),
    fc.constant(null),
    tie('list'),
    tie('record'),
  ),
  list: fc.array(tie('json'), { maxLength: 4 }),
  record: fc.dictionary(fc.string({ unit: 'grapheme', maxLength: 6 }), tie('json'), {
    maxKeys: 5,
  }),
}));

const indents = fc.constantFrom<string | number>(0, 1, 2, 4, '\t', ' \n ');

// A small deterministic generator, so a failing case replays from its seed.
function shuffled<T>(items: readonly T[], seed: number): T[] {
  const out = [...items];
  let state = seed >>> 0;
  for (let i = out.length - 1; i > 0; i -= 1) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    const j = state % (i + 1);
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

// Rebuilds every object with its keys in a different order. fromEntries
// defines own properties, so a "__proto__" key stays a key.
function reorder(value: unknown, seed: number): unknown {
  if (Array.isArray(value)) return value.map((item, i) => reorder(item, seed + i));
  if (typeof value !== 'object' || value === null) return value;
  const entries = shuffled(Object.entries(value), seed);
  return Object.fromEntries(entries.map(([key, item], i) => [key, reorder(item, seed * 31 + i)]));
}

test('key order and whitespace never change the hash', () => {
  fc.assert(
    fc.property(json, fc.integer(), indents, (value, seed, indent) => {
      const expected = sha256Hex(canonicalJson(value));
      const text = JSON.stringify(reorder(value, seed), null, indent);
      expect(sha256Hex(canonicalJson(JSON.parse(text)))).toBe(expected);
    }),
  );
});
