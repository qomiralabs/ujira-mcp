// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// Hostile locales and polluted prototypes. Locale parsing in Intl is slow on
// huge tags, so length is capped before Intl ever sees the text, and option
// values inherited from Object.prototype must never change the output.

import { afterEach, describe, expect, it, vi } from 'vitest';

import { formatMoney } from './format.js';
import * as moneyIndex from './index.js';
import { InvalidAmountError, money, moneyAt } from './index.js';
import type { MoneyError } from './index.js';
import { parseMoney } from './parse.js';

type ErrorClass = abstract new (message?: string) => MoneyError;
const InvalidLocaleError = (moneyIndex as Record<string, unknown>)[
  'InvalidLocaleError'
] as ErrorClass;

function thrown(run: () => unknown): unknown {
  try {
    run();
  } catch (err) {
    return err;
  }
  return undefined;
}

// A well formed tag of exactly `length` characters, built from private use
// subtags of eight letters, so Intl would accept it if it ever saw it.
function tagOfLength(length: number): string {
  let tag = 'en-US-x';
  while (tag.length < length) tag += '-abcdefgh';
  return tag.slice(0, length).replace(/-$/, 'a');
}

describe('formatMoney caps the locale length before Intl', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('builds well formed test tags', () => {
    for (const length of [64, 65, 200]) {
      const tag = tagOfLength(length);
      expect(tag).toHaveLength(length);
      expect(Intl.getCanonicalLocales(tag)).toHaveLength(1);
    }
  });

  it('accepts a valid tag of exactly 64 characters', () => {
    const tag = tagOfLength(64);
    expect(formatMoney(money(150n, 'USD'), { locale: tag })).toBe('$1.50');
  });

  it.each([65, 200, 10_000])('rejects a valid looking tag of %i characters', (length) => {
    const err = thrown(() => formatMoney(money(150n, 'USD'), { locale: tagOfLength(length) }));
    expect(err).toBeInstanceOf(InvalidLocaleError);
  });

  it('never calls Intl for an over long tag', () => {
    const canonical = vi.spyOn(Intl, 'getCanonicalLocales');
    const numberFormat = vi.spyOn(Intl, 'NumberFormat');
    const err = thrown(() => formatMoney(money(150n, 'USD'), { locale: tagOfLength(65) }));
    expect(err).toBeInstanceOf(InvalidLocaleError);
    expect(canonical).not.toHaveBeenCalled();
    expect(numberFormat).not.toHaveBeenCalled();
  });

  it('rejects a megabyte private use tag quickly', () => {
    const huge = 'en-x-' + Array.from({ length: 200_000 }, () => 'abcdefgh').join('-');
    expect(huge.length).toBeGreaterThan(1_000_000);
    const started = performance.now();
    const err = thrown(() => formatMoney(money(150n, 'USD'), { locale: huge }));
    const elapsed = performance.now() - started;
    expect(err).toBeInstanceOf(InvalidLocaleError);
    expect(elapsed).toBeLessThan(250);
  });
});

describe('options inherited from Object.prototype are ignored', () => {
  const proto = Object.prototype as Record<string, unknown>;

  afterEach(() => {
    delete proto['rounding'];
    delete proto['locale'];
  });

  it('formatMoney keeps half-even when Object.prototype.rounding is polluted', () => {
    proto['rounding'] = 'ceil';
    expect(formatMoney(moneyAt(1005n, 'USD', 3), { locale: 'en-US' })).toBe('$1.00');
  });

  it('formatMoney rejects a missing locale when Object.prototype.locale is polluted', () => {
    proto['locale'] = 'en-US';
    const err = thrown(() => formatMoney(money(1n, 'USD'), {} as never));
    expect(err).toBeInstanceOf(InvalidLocaleError);
  });

  it('formatMoney still uses own options while the prototype is polluted', () => {
    proto['rounding'] = 'floor';
    proto['locale'] = 'de-DE';
    expect(formatMoney(moneyAt(1005n, 'USD', 3), { locale: 'en-US', rounding: 'ceil' })).toBe(
      '$1.01',
    );
  });

  it('parseMoney does not round when Object.prototype.rounding is polluted', () => {
    proto['rounding'] = 'half-up';
    expect(thrown(() => parseMoney('1.005', 'USD', {}))).toBeInstanceOf(InvalidAmountError);
    expect(parseMoney('1.005', 'USD', { rounding: 'floor' }).amount).toBe(100n);
  });

  it('leaves the prototype clean after each case', () => {
    expect(Object.hasOwn(Object.prototype, 'rounding')).toBe(false);
    expect(Object.hasOwn(Object.prototype, 'locale')).toBe(false);
  });
});
