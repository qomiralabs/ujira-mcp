// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The scale guard and the table it protects are two separate facts. If they
// ever drift apart, an index the table does not hold must throw rather than
// resolve through Array.prototype.

import { afterEach, describe, expect, it } from 'vitest';

import { InvalidScaleError } from './errors.js';
import { MAX_SCALE, powerOfTen } from './money.js';
import { readOwnIndex } from './options.js';

const arrayProto = Array.prototype as unknown as Record<string, unknown>;
const objectProto = Object.prototype as Record<string, unknown>;

afterEach(() => {
  delete arrayProto['19'];
  delete arrayProto['3'];
  delete objectProto['19'];
});

describe('powerOfTen', () => {
  it('Array.prototype[19] set by a test does not change the result, and an out-of-table index throws', () => {
    arrayProto['19'] = 10n ** 19n;
    expect(() => powerOfTen(19)).toThrow(InvalidScaleError);
    expect(powerOfTen(MAX_SCALE)).toBe(10n ** 18n);
    for (const index of [20, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => powerOfTen(index)).toThrow(InvalidScaleError);
    }
  });

  it('ignores a polluted entry at an index the table already owns', () => {
    arrayProto['3'] = 7n;
    expect(powerOfTen(3)).toBe(1000n);
  });

  it('refuses a scale given as text or bigint, even one the table holds', () => {
    expect(() => powerOfTen('2' as unknown as number)).toThrow(InvalidScaleError);
    expect(() => powerOfTen(2n as unknown as number)).toThrow(InvalidScaleError);
  });
});

describe('readOwnIndex', () => {
  const table: readonly bigint[] = Object.freeze([1n, 10n, 100n]);

  it('returns an entry the list owns', () => {
    expect(readOwnIndex(table, 2)).toBe(100n);
  });

  it('never answers past the end from a polluted Array.prototype', () => {
    arrayProto['3'] = 1000n;
    expect(readOwnIndex(table, 3)).toBeUndefined();
  });

  it('treats a hole as missing', () => {
    const holey = new Array<bigint>(3);
    holey[0] = 1n;
    arrayProto['3'] = 7n;
    objectProto['19'] = 7n;
    expect(readOwnIndex(holey, 1)).toBeUndefined();
    expect(readOwnIndex(holey, 19)).toBeUndefined();
  });

  it.each([-1, 1.5, Number.NaN, '1', 1n, -0.5])('refuses the index %s', (index) => {
    expect(readOwnIndex(table, index)).toBeUndefined();
  });
});
