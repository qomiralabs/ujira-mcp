// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

import { describe, expect, it } from 'vitest';

import * as entry from '../money.js';
import * as root from '../index.js';
import { I128_MAX } from './index.js';
import { STELLAR_DECIMALS, formatUnits, minorUnits, units } from './units.js';

describe('the original money entry point', () => {
  it('exports exactly what it exported before the money module', () => {
    expect(Object.keys(entry).sort()).toEqual([
      'STELLAR_DECIMALS',
      'formatUnits',
      'minorUnits',
      'units',
    ]);
    expect(entry.formatUnits).toBe(formatUnits);
    expect(entry.minorUnits).toBe(minorUnits);
    expect(entry.units).toBe(units);
    expect(entry.STELLAR_DECIMALS).toBe(7);
  });

  it('still reaches the package root', () => {
    expect(root.formatUnits).toBe(formatUnits);
    expect(root.minorUnits).toBe(minorUnits);
    expect(root.units).toBe(units);
    expect(root.STELLAR_DECIMALS).toBe(STELLAR_DECIMALS);
  });
});

describe('minorUnits', () => {
  it('parses positive whole minor units up to the i128 maximum', () => {
    expect(minorUnits.parse('1')).toBe(1n);
    expect(minorUnits.parse(I128_MAX.toString())).toBe(I128_MAX);
  });

  it.each(['0', '-1', '01', '1.5', '1e3', ' 1', '', (I128_MAX + 1n).toString(), '9'.repeat(40)])(
    'refuses %j',
    (text) => {
      expect(minorUnits.safeParse(text).success).toBe(false);
    },
  );

  it('refuses anything that is not a string', () => {
    for (const value of [1, 1n, null, undefined, {}]) {
      expect(minorUnits.safeParse(value).success).toBe(false);
    }
  });
});

describe('formatUnits and units', () => {
  it.each([
    [0n, '0'],
    [1n, '0.0000001'],
    [25_000_000n, '2.5'],
    [10_000_000n, '1'],
    [-15_000_000n, '-1.5'],
  ])('renders %s as %s', (amount, text) => {
    expect(formatUnits(amount)).toBe(text);
  });

  it('takes another scale', () => {
    expect(formatUnits(1230n, 2)).toBe('12.3');
    expect(formatUnits(5n, 0)).toBe('5');
  });

  it('turns whole units into minor units and refuses fractions', () => {
    expect(units(3)).toBe(30_000_000n);
    expect(units(3, 2)).toBe(300n);
    expect(() => units(1.5)).toThrow(RangeError);
    expect(() => units(Number.MAX_SAFE_INTEGER + 1)).toThrow(RangeError);
  });
});
