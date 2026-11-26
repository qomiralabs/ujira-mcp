// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The API contract for this module is documented at the top of money.test.ts.

import { describe, expect, it } from 'vitest';

import {
  FIAT_CURRENCIES,
  MoneyError,
  SETTLEMENT_TOKENS,
  UnknownCurrencyError,
  fiatCurrency,
  isFiatCurrencyCode,
  isTokenAsset,
  money,
  settlementToken,
  tokenAmount,
} from './index.js';

// ISO 4217 minor units, written out here rather than derived from the table.
const ISO_4217_MINOR_UNITS: Record<string, number> = {
  USD: 2,
  NGN: 2,
  KES: 2,
  GHS: 2,
  ZAR: 2,
  PHP: 2,
  INR: 2,
  BRL: 2,
  COP: 2,
  MXN: 2,
  EUR: 2,
  GBP: 2,
};

describe('fiat currency table', () => {
  it('fiat table matches ISO 4217 minor units', () => {
    expect(FIAT_CURRENCIES).toHaveLength(12);
    const asRecord = Object.fromEntries(FIAT_CURRENCIES.map((c) => [c.code, c.minorUnits]));
    expect(asRecord).toEqual(ISO_4217_MINOR_UNITS);
    for (const [code, minorUnits] of Object.entries(ISO_4217_MINOR_UNITS)) {
      expect(fiatCurrency(code)).toEqual({ code, minorUnits });
    }
  });

  it('has no duplicate codes', () => {
    const codes = FIAT_CURRENCIES.map((c) => c.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('stores minor units as integer numbers', () => {
    for (const c of FIAT_CURRENCIES) {
      expect(Number.isSafeInteger(c.minorUnits)).toBe(true);
    }
  });

  it('is frozen, entries included', () => {
    expect(Object.isFrozen(FIAT_CURRENCIES)).toBe(true);
    for (const c of FIAT_CURRENCIES) {
      expect(Object.isFrozen(c)).toBe(true);
    }
    expect(() => {
      (FIAT_CURRENCIES as unknown as unknown[]).push({ code: 'JPY', minorUnits: 0 });
    }).toThrow(TypeError);
  });

  it('does not list settlement tokens as fiat', () => {
    expect(() => fiatCurrency('USDC')).toThrow(UnknownCurrencyError);
    expect(() => fiatCurrency('usdc')).toThrow(UnknownCurrencyError);
  });
});

describe('settlement token table', () => {
  it('the only settlement token is USDC on Stellar at scale 7', () => {
    expect(SETTLEMENT_TOKENS).toEqual([
      { asset: 'USDC', chain: 'stellar', tokenScale: 7, displayScale: 2 },
    ]);
    expect(settlementToken('USDC', 'stellar')).toBe(SETTLEMENT_TOKENS[0]);
  });

  it('keeps the token scale separate from the display scale', () => {
    for (const t of SETTLEMENT_TOKENS) {
      expect(t.displayScale).toBe(2);
      expect(t.tokenScale).not.toBe(t.displayScale);
    }
  });

  it('is frozen, entries included', () => {
    expect(Object.isFrozen(SETTLEMENT_TOKENS)).toBe(true);
    for (const t of SETTLEMENT_TOKENS) {
      expect(Object.isFrozen(t)).toBe(true);
    }
  });

  it('builds every token amount at its token scale', () => {
    for (const t of SETTLEMENT_TOKENS) {
      const amount = tokenAmount(1n, t.asset, t.chain);
      expect(amount.scale).toBe(t.tokenScale);
      expect(amount.chain).toBe(t.chain);
    }
  });
});

describe('kind predicates', () => {
  it('tells fiat codes from token assets, exactly and case sensitively', () => {
    for (const c of FIAT_CURRENCIES) {
      expect(isFiatCurrencyCode(c.code)).toBe(true);
      expect(isTokenAsset(c.code)).toBe(false);
    }
    for (const t of SETTLEMENT_TOKENS) {
      expect(isTokenAsset(t.asset)).toBe(true);
      expect(isFiatCurrencyCode(t.asset)).toBe(false);
    }
    for (const value of ['usd', 'usdc', 'USDT', '', '__proto__', 'constructor', null, 1]) {
      expect(isFiatCurrencyCode(value)).toBe(false);
      expect(isTokenAsset(value)).toBe(false);
    }
  });
});

describe('unknown currencies', () => {
  it('throws UnknownCurrencyError for XXX', () => {
    expect(() => fiatCurrency('XXX')).toThrow(UnknownCurrencyError);
    expect(() => money(1n, 'XXX' as never)).toThrow(UnknownCurrencyError);
  });

  it.each(['usd', 'Usd', '', ' USD', 'USD ', 'JPY', 'BTC', 'constructor', '__proto__', 'toString'])(
    'fiatCurrency throws UnknownCurrencyError for %j',
    (code) => {
      expect(() => fiatCurrency(code)).toThrow(UnknownCurrencyError);
    },
  );

  it.each([
    ['USDT', 'stellar'],
    ['USDC', 'ethereum'],
    ['USDC', 'Stellar'],
    ['usdc', 'stellar'],
    ['USDC', 'stellar:pubnet'],
    ['USDC', ''],
    ['', 'stellar'],
    ['XLM', 'stellar'],
    ['USDC', 'constructor'],
    ['constructor', 'stellar'],
    ['__proto__', 'stellar'],
  ])('settlementToken throws UnknownCurrencyError for %s on %s', (asset, chain) => {
    expect(() => settlementToken(asset, chain)).toThrow(UnknownCurrencyError);
  });

  it('throws an error that carries the shared code', () => {
    try {
      settlementToken('USDT', 'stellar');
      expect.unreachable('settlementToken should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(MoneyError);
      expect((err as MoneyError).code).toBe('UNKNOWN_CURRENCY');
    }
  });
});
