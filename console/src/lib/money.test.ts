// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

import { describe, expect, it } from 'vitest';

import {
  addMinor,
  compareMinor,
  formatAmount,
  formatUsdc,
  parseAmount,
  percentOf,
  subMinor,
  wholeUnits,
} from './money';

describe('parseAmount', () => {
  it.each([
    ['1', '10000000'],
    ['40', '400000000'],
    ['12.5', '125000000'],
    ['0.0000001', '1'],
    ['.5', '5000000'],
    ['5.', '50000000'],
    ['1,000.25', '10002500000'],
    [' 007.10 ', '71000000'],
    ['0', '0'],
  ])('reads %s as %s minor units', (input, minor) => {
    expect(parseAmount(input)).toEqual({ ok: true, minor });
  });

  it('keeps every digit of amounts a float would round', () => {
    expect(parseAmount('0.1')).toEqual({ ok: true, minor: '1000000' });
    expect(parseAmount('90071992547.4099931')).toEqual({ ok: true, minor: '900719925474099931' });
    expect(parseAmount('123456789012345678.1234567')).toEqual({
      ok: true,
      minor: '1234567890123456781234567',
    });
  });

  it.each([
    ['', 'Enter an amount.'],
    ['-1', 'The amount cannot be negative.'],
    ['1.23456789', 'Use at most 7 decimal places.'],
    ['1e5', 'Use digits and one decimal point, like 12.50.'],
    ['1.2.3', 'Use digits and one decimal point, like 12.50.'],
    ['.', 'Use digits and one decimal point, like 12.50.'],
    ['abc', 'Use digits and one decimal point, like 12.50.'],
  ])('refuses %j', (input, error) => {
    expect(parseAmount(input)).toEqual({ ok: false, error });
  });

  it('honours other decimal counts', () => {
    expect(parseAmount('1.25', 2)).toEqual({ ok: true, minor: '125' });
    expect(parseAmount('1.255', 2)).toEqual({ ok: false, error: 'Use at most 2 decimal places.' });
  });
});

describe('formatAmount', () => {
  it.each([
    ['0', '0.00'],
    ['1', '0.0000001'],
    ['10000000', '1.00'],
    ['125000000', '12.50'],
    ['123456789', '12.3456789'],
    ['10002500000', '1,000.25'],
    ['12345678900000000', '1,234,567,890.00'],
    ['-25000000', '-2.50'],
  ])('shows %s as %s', (minor, shown) => {
    expect(formatAmount(minor)).toBe(shown);
  });

  it('round trips through parseAmount', () => {
    for (const minor of ['1', '99', '10000000', '987654321012', '5000001']) {
      const parsed = parseAmount(formatAmount(minor));
      expect(parsed).toEqual({ ok: true, minor });
    }
  });

  it('can drop grouping for inputs', () => {
    expect(formatAmount('10002500000', { grouping: false })).toBe('1000.25');
  });

  it('names the currency', () => {
    expect(formatUsdc('150000000')).toBe('15.00 USDC');
  });
});

describe('integer helpers', () => {
  it('converts whole units', () => {
    expect(wholeUnits(50)).toBe('500000000');
    expect(wholeUnits('0')).toBe('0');
    expect(() => wholeUnits(1.5)).toThrow();
  });

  it('compares, adds and subtracts as integers', () => {
    expect(compareMinor('10000000', '9999999')).toBe(1);
    expect(compareMinor('5', '5')).toBe(0);
    expect(compareMinor('99999999999999999999', '100000000000000000000')).toBe(-1);
    expect(addMinor('99999999999999999999', '1')).toBe('100000000000000000000');
    expect(subMinor('400000000', '150000000')).toBe('250000000');
  });

  it('gives a bar percentage rounded down and clamped', () => {
    expect(percentOf('0', '400000000')).toBe(0);
    expect(percentOf('150000000', '400000000')).toBe(37);
    expect(percentOf('400000000', '400000000')).toBe(100);
    expect(percentOf('500000000', '400000000')).toBe(100);
    expect(percentOf('1', '0')).toBe(0);
  });
});
