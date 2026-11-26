// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

/*
 * Public contract for src/money (exported from ./index.js). The package
 * root, src/index.ts, keeps exporting only the older helpers in src/money.ts.
 *
 * These tests pass numbers such as 1.5 on purpose to prove they are
 * rejected.
 *
 * Constants
 *   I128_MIN: bigint = -(2n ** 127n)
 *   I128_MAX: bigint = 2n ** 127n - 1n
 *   MAX_SCALE: number = 18
 *
 * Types
 *   type FiatCurrencyCode =
 *     'USD' | 'NGN' | 'KES' | 'GHS' | 'ZAR' | 'PHP' | 'INR' | 'BRL' | 'COP' | 'MXN' | 'EUR' | 'GBP'
 *   type TokenAsset = 'USDC'
 *   type Chain = 'stellar'
 *   interface Money {
 *     readonly kind: 'fiat'; readonly amount: bigint;
 *     readonly currency: FiatCurrencyCode; readonly scale: number
 *   }
 *   interface TokenAmount {
 *     readonly kind: 'token'; readonly amount: bigint; readonly asset: TokenAsset;
 *     readonly chain: Chain; readonly scale: number
 *   }
 *   Money is fiat only. Its scale is the currency's ISO minor unit, or a finer
 *   working scale up to MAX_SCALE built with moneyAt; never coarser. A
 *   TokenAmount is always at its token's decimals on its chain (USDC on
 *   Stellar is 7) and keeps its chain, so one asset on two chains would be
 *   two different values by construction.
 *   `kind` is a runtime discriminant read first by every operation.
 *   interface FiatCurrency { readonly code: FiatCurrencyCode; readonly minorUnits: number }
 *   interface SettlementToken {
 *     readonly asset: TokenAsset; readonly chain: Chain;
 *     readonly tokenScale: number; readonly displayScale: number
 *   }
 *
 * Errors (all extend MoneyError, which extends Error; `name` equals the class
 * name; `code` is a readonly stable string)
 *   MoneyOverflowError     code 'MONEY_OVERFLOW'     amount or result outside [I128_MIN, I128_MAX]
 *   CurrencyMismatchError  code 'CURRENCY_MISMATCH'  operands have different currencies
 *   ScaleMismatchError     code 'SCALE_MISMATCH'     same currency, different scales
 *   UnknownCurrencyError   code 'UNKNOWN_CURRENCY'   code or asset and chain pair not in the tables
 *   InvalidAmountError     code 'INVALID_AMOUNT'     amount or factor is not a bigint or canonical
 *                                                    integer string; sum of an empty list
 *   InvalidScaleError      code 'INVALID_SCALE'      fiat scale not an integer from the minor
 *                                                    unit to MAX_SCALE; token scale not the
 *                                                    token's decimals; a scale passed to money()
 *   KindMismatchError      code 'KIND_MISMATCH'      fiat money combined with a token amount, or
 *                                                    passed where only one kind is accepted
 *   TokenMismatchError     code 'TOKEN_MISMATCH'     token amounts of different assets or chains
 *   RateMismatchError      code 'RATE_MISMATCH'      a conversion source or target that is not
 *                                                    the rate's base or quote
 *
 * Factory
 *   money(amount: bigint | string, currency: FiatCurrencyCode): Money
 *     At the currency's ISO minor unit. A third argument throws
 *     InvalidScaleError rather than being ignored. Token assets are not fiat
 *     and throw UnknownCurrencyError.
 *   moneyAt(amount, currency: FiatCurrencyCode, scale: number): Money
 *     scale is an integer from the currency's minor unit to MAX_SCALE;
 *     anything else, coarser scales included, throws InvalidScaleError.
 *   tokenAmount(amount, asset: TokenAsset, chain: Chain): TokenAmount
 *     At the token's decimals from SETTLEMENT_TOKENS; an unknown pair throws
 *     UnknownCurrencyError. There is no way to give a token another scale.
 *   For all three, amount is a bigint, or a canonical decimal integer string matching
 *     /^-?(0|[1-9][0-9]*)$/ with "-0" rejected. Anything else (numbers, boxed
 *     bigints, "+1", "01", "1.0", "1e3", "0x10", whitespace, empty) throws
 *     InvalidAmountError. Values outside i128 throw MoneyOverflowError.
 *     Validation order: amount type and syntax, then currency (or asset and
 *     chain), then scale, then range. Zero and negative amounts are valid
 *     values. The returned object is frozen with exactly the fields above.
 *
 * Operations (pure, never mutate inputs, every Money result is frozen)
 *   Every operation takes Money or TokenAmount and returns the same kind.
 *   add(a, b), subtract(a, b)
 *   multiply(a, factor: bigint): Money        factor that is not a bigint throws
 *                                             InvalidAmountError; only the result is bounded
 *   negate(a): Money                          negate of I128_MIN throws MoneyOverflowError
 *   sum(items: readonly Money[]): Money       identical to items.reduce(add), including
 *                                             throwing on an intermediate overflow; empty
 *                                             list throws InvalidAmountError
 *   compare(a, b): -1 | 0 | 1
 *   equals(a, b): boolean
 *   isZero(a), isNegative(a): boolean
 *   Binary operations (add, subtract, sum, compare, equals) check kind first
 *   (KindMismatchError); then for fiat currency (CurrencyMismatchError) and
 *   scale (ScaleMismatchError), and for tokens asset and chain
 *   (TokenMismatchError).
 *   An operand whose amount is not a bigint (a forged object) throws
 *   InvalidAmountError.
 *
 * Tables (see currencies.test.ts)
 *   FIAT_CURRENCIES: readonly FiatCurrency[]          frozen, twelve entries
 *   SETTLEMENT_TOKENS: readonly SettlementToken[]     frozen, one entry
 *   fiatCurrency(code: string): FiatCurrency          throws UnknownCurrencyError
 *   settlementToken(asset: string, chain: string): SettlementToken
 *                                                     throws UnknownCurrencyError
 *   Lookups are exact and case sensitive.
 */

import { describe, expect, it } from 'vitest';

import * as root from '../index.js';
import {
  CurrencyMismatchError,
  I128_MAX,
  I128_MIN,
  InvalidAmountError,
  InvalidScaleError,
  KindMismatchError,
  MAX_SCALE,
  MoneyError,
  MoneyOverflowError,
  RateMismatchError,
  ScaleMismatchError,
  TokenMismatchError,
  UnknownCurrencyError,
  add,
  compare,
  equals,
  isNegative,
  isZero,
  money,
  moneyAt,
  multiply,
  negate,
  subtract,
  sum,
  tokenAmount,
} from './index.js';
import type { FiatCurrencyCode, Money } from './index.js';

// Independent of the implementation so a wrong constant cannot hide itself.
const MAX = 2n ** 127n - 1n;
const MIN = -(2n ** 127n);

const usd = (amount: bigint): Money => money(amount, 'USD');

// Lets tests feed values the type system would reject, to prove runtime checks.
function loose(value: unknown): never {
  return value as never;
}

describe('constants', () => {
  it('bounds amounts to the signed 128 bit range', () => {
    expect(I128_MAX).toBe(MAX);
    expect(I128_MIN).toBe(MIN);
    expect(typeof I128_MAX).toBe('bigint');
    expect(typeof I128_MIN).toBe('bigint');
  });

  it('caps scale at 18', () => {
    expect(MAX_SCALE).toBe(18);
  });
});

describe('errors', () => {
  const cases: [new (message?: string) => MoneyError, string, string][] = [
    [MoneyOverflowError, 'MoneyOverflowError', 'MONEY_OVERFLOW'],
    [CurrencyMismatchError, 'CurrencyMismatchError', 'CURRENCY_MISMATCH'],
    [ScaleMismatchError, 'ScaleMismatchError', 'SCALE_MISMATCH'],
    [UnknownCurrencyError, 'UnknownCurrencyError', 'UNKNOWN_CURRENCY'],
    [InvalidAmountError, 'InvalidAmountError', 'INVALID_AMOUNT'],
    [InvalidScaleError, 'InvalidScaleError', 'INVALID_SCALE'],
    [KindMismatchError, 'KindMismatchError', 'KIND_MISMATCH'],
    [TokenMismatchError, 'TokenMismatchError', 'TOKEN_MISMATCH'],
    [RateMismatchError, 'RateMismatchError', 'RATE_MISMATCH'],
  ];

  it.each(cases)('%o has a stable code and extends MoneyError', (Ctor, name, code) => {
    const err = new Ctor('boom');
    expect(err).toBeInstanceOf(MoneyError);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe(name);
    expect(err.code).toBe(code);
    expect(err.message).toBe('boom');
  });

  it('gives every error class a distinct code', () => {
    const codes = cases.map(([Ctor]) => new Ctor().code);
    expect(new Set(codes).size).toBe(cases.length);
  });
});

describe('money factory', () => {
  it('builds a value from a bigint', () => {
    const m = money(1234n, 'USD');
    expect(m).toEqual({ kind: 'fiat', amount: 1234n, currency: 'USD', scale: 2 });
    expect(typeof m.amount).toBe('bigint');
  });

  it('rejects a number amount', () => {
    expect(() => money(loose(100), 'USD')).toThrow(InvalidAmountError);
    expect(() => money(loose(0), 'USD')).toThrow(InvalidAmountError);
    expect(() => money(loose(1.5), 'USD')).toThrow(InvalidAmountError);
    expect(() => money(loose(Number.NaN), 'USD')).toThrow(InvalidAmountError);
    expect(() => money(loose(Number.POSITIVE_INFINITY), 'USD')).toThrow(InvalidAmountError);
    expect(() => money(loose(Number.MAX_SAFE_INTEGER), 'USD')).toThrow(InvalidAmountError);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['boolean', true],
    ['object', {}],
    ['array', [1n]],
    ['boxed bigint', Object(1n)],
    ['symbol', Symbol('1')],
  ])('rejects a %s amount', (_label, value) => {
    expect(() => money(loose(value), 'USD')).toThrow(InvalidAmountError);
  });

  it.each(['0', '1', '-1', '1234567890', String(MAX), String(MIN)])(
    'accepts the canonical integer string %s',
    (text) => {
      const m = money(text, 'USD');
      expect(m.amount).toBe(BigInt(text));
      expect(typeof m.amount).toBe('bigint');
    },
  );

  it.each([
    '',
    ' ',
    ' 1',
    '1 ',
    '\n1',
    '+1',
    '-0',
    '01',
    '-01',
    '00',
    '1.0',
    '1.',
    '.5',
    '1e3',
    '1E3',
    '0x10',
    '0b1',
    '0o7',
    '1_000',
    '1,000',
    '--1',
    '-',
    'NaN',
    'Infinity',
    '-Infinity',
    '1n',
    '١',
    '１',
  ])('rejects the non canonical amount string %j', (text) => {
    expect(() => money(text, 'USD')).toThrow(InvalidAmountError);
  });

  it('accepts amounts at the exact i128 boundaries', () => {
    expect(money(MAX, 'USD').amount).toBe(MAX);
    expect(money(MIN, 'USD').amount).toBe(MIN);
    expect(moneyAt(MAX, 'USD', 18).amount).toBe(MAX);
    expect(tokenAmount(MIN, 'USDC', 'stellar').amount).toBe(MIN);
  });

  it('throws MoneyOverflowError one past either boundary', () => {
    expect(() => money(MAX + 1n, 'USD')).toThrow(MoneyOverflowError);
    expect(() => money(MIN - 1n, 'USD')).toThrow(MoneyOverflowError);
    expect(() => money(String(MAX + 1n), 'USD')).toThrow(MoneyOverflowError);
    expect(() => money(String(MIN - 1n), 'USD')).toThrow(MoneyOverflowError);
  });

  it('throws MoneyOverflowError for very large values without hanging', () => {
    expect(() => money(2n ** 4096n, 'USD')).toThrow(MoneyOverflowError);
    expect(() => money('9'.repeat(10_000), 'USD')).toThrow(MoneyOverflowError);
    expect(() => money('-' + '9'.repeat(10_000), 'USD')).toThrow(MoneyOverflowError);
  });

  it('accepts zero and negative amounts', () => {
    expect(usd(0n).amount).toBe(0n);
    expect(usd(-1n).amount).toBe(-1n);
    expect(money('-250', 'NGN').amount).toBe(-250n);
  });

  it.each(['XXX', 'usd', 'Usd', '', 'USD ', 'USDC ', 'usdc', 'USDT', 'BTC', 'XLM', 'STELLAR'])(
    'throws UnknownCurrencyError for the currency %j',
    (code) => {
      expect(() => money(1n, loose(code))).toThrow(UnknownCurrencyError);
      expect(() => moneyAt(1n, loose(code), 2)).toThrow(UnknownCurrencyError);
    },
  );

  it.each([840, null, undefined, {}])('throws UnknownCurrencyError for a %o currency', (code) => {
    expect(() => money(1n, loose(code))).toThrow(UnknownCurrencyError);
  });

  it('refuses token assets as fiat currencies', () => {
    for (const asset of ['USDC', 'USDT']) {
      expect(() => money(1n, loose(asset))).toThrow(UnknownCurrencyError);
      expect(() => moneyAt(1n, loose(asset), 6)).toThrow(UnknownCurrencyError);
    }
  });

  it('builds every fiat currency at its minor unit', () => {
    const codes: FiatCurrencyCode[] = [
      'USD',
      'NGN',
      'KES',
      'GHS',
      'ZAR',
      'PHP',
      'INR',
      'BRL',
      'COP',
      'MXN',
      'EUR',
      'GBP',
    ];
    for (const code of codes) {
      const m = money(1n, code);
      expect(m.currency).toBe(code);
      expect(m.scale).toBe(2);
    }
  });

  it('refuses a scale passed to money instead of ignoring it', () => {
    for (const scale of [2, 6, 0, undefined]) {
      expect(() => (money as (...args: unknown[]) => Money)(1n, 'USD', scale)).toThrow(
        InvalidScaleError,
      );
    }
  });

  it('builds a finer working scale with moneyAt, up to 18', () => {
    for (let scale = 2; scale <= 18; scale += 1) {
      const m = moneyAt(1n, 'USD', scale);
      expect(m.scale).toBe(scale);
      expect(m.kind).toBe('fiat');
    }
  });

  it('refuses a scale coarser than the minor unit', () => {
    expect(() => moneyAt(20_000n, 'NGN', 0)).toThrow(InvalidScaleError);
    expect(() => moneyAt(5n, 'USD', 1)).toThrow(InvalidScaleError);
    expect(() => moneyAt(1n, 'USD', -0)).toThrow(InvalidScaleError);
  });

  it.each([
    ['negative', -1],
    ['above the maximum', 19],
    ['fractional', 2.5],
    ['NaN', Number.NaN],
    ['infinite', Number.POSITIVE_INFINITY],
    ['a string', '2'],
    ['a bigint', 2n],
    ['null', null],
    ['undefined', undefined],
  ])('throws InvalidScaleError for a moneyAt scale that is %s', (_label, scale) => {
    expect(() => moneyAt(1n, 'USD', loose(scale))).toThrow(InvalidScaleError);
  });

  it('validates the amount before the currency and the currency before the scale', () => {
    expect(() => moneyAt(loose(1), loose('XXX'), -1)).toThrow(InvalidAmountError);
    expect(() => moneyAt(1n, loose('XXX'), -1)).toThrow(UnknownCurrencyError);
    expect(() => moneyAt(MAX + 1n, 'USD', -1)).toThrow(InvalidScaleError);
    expect(() => money(loose(1), loose('XXX'))).toThrow(InvalidAmountError);
  });

  it('checks the range last, after currency and scale', () => {
    const tooLong = '1'.repeat(40);
    expect(() => moneyAt(tooLong, loose('XXX'), 2)).toThrow(UnknownCurrencyError);
    expect(() => moneyAt(tooLong, 'USD', 19)).toThrow(InvalidScaleError);
    expect(() => moneyAt(String(MAX + 1n), loose('XXX'), 2)).toThrow(UnknownCurrencyError);
    expect(() => moneyAt(String(MIN - 1n), 'USD', loose(1.5))).toThrow(InvalidScaleError);
    expect(() => money(MIN - 1n, loose('XXX'))).toThrow(UnknownCurrencyError);
    expect(() => money(tooLong, 'USD')).toThrow(MoneyOverflowError);
  });

  it('returns a frozen value', () => {
    const m = usd(5n);
    expect(Object.isFrozen(m)).toBe(true);
    expect(() => {
      (m as { amount: bigint }).amount = 6n;
    }).toThrow(TypeError);
    expect(() => {
      (m as { currency: string }).currency = 'NGN';
    }).toThrow(TypeError);
    expect(() => {
      (m as { scale: number }).scale = 3;
    }).toThrow(TypeError);
    expect(() => {
      (m as { kind: string }).kind = 'token';
    }).toThrow(TypeError);
    expect(m).toEqual({ kind: 'fiat', amount: 5n, currency: 'USD', scale: 2 });
  });

  it('exposes exactly kind, amount, currency and scale', () => {
    expect(Object.keys(usd(1n)).sort()).toEqual(['amount', 'currency', 'kind', 'scale']);
    expect(Object.keys(moneyAt(1n, 'USD', 6)).sort()).toEqual([
      'amount',
      'currency',
      'kind',
      'scale',
    ]);
  });
});

describe('add', () => {
  it('adds two values of the same currency and scale', () => {
    expect(add(usd(150n), usd(275n))).toEqual(usd(425n));
    expect(add(usd(-150n), usd(100n))).toEqual(usd(-50n));
    expect(add(usd(0n), usd(0n))).toEqual(usd(0n));
  });

  it('add throws CurrencyMismatchError for USD and NGN', () => {
    expect(() => add(usd(1n), money(1n, 'NGN'))).toThrow(CurrencyMismatchError);
  });

  it('add throws ScaleMismatchError for USD at 2 and 6', () => {
    expect(() => add(usd(1n), moneyAt(1n, 'USD', 6))).toThrow(ScaleMismatchError);
  });

  it('reports a currency mismatch before a scale mismatch', () => {
    expect(() => add(usd(1n), moneyAt(1n, 'NGN', 6))).toThrow(CurrencyMismatchError);
  });

  it('throws KindMismatchError for fiat and a token, in either order', () => {
    const token = tokenAmount(1n, 'USDC', 'stellar');
    expect(() => add(usd(1n), loose(token))).toThrow(KindMismatchError);
    expect(() => add(token, loose(usd(1n)))).toThrow(KindMismatchError);
  });

  it('adds token amounts of the same asset and chain', () => {
    const r = add(tokenAmount(5n, 'USDC', 'stellar'), tokenAmount(7n, 'USDC', 'stellar'));
    expect(r).toEqual(tokenAmount(12n, 'USDC', 'stellar'));
    expect(Object.isFrozen(r)).toBe(true);
  });

  it('reaches the exact i128 boundaries', () => {
    expect(add(usd(MAX - 1n), usd(1n)).amount).toBe(MAX);
    expect(add(usd(MIN + 1n), usd(-1n)).amount).toBe(MIN);
    expect(add(usd(MAX), usd(MIN)).amount).toBe(-1n);
  });

  it('throws MoneyOverflowError one past the boundaries', () => {
    expect(() => add(usd(MAX), usd(1n))).toThrow(MoneyOverflowError);
    expect(() => add(usd(MIN), usd(-1n))).toThrow(MoneyOverflowError);
    expect(() => add(usd(MAX), usd(MAX))).toThrow(MoneyOverflowError);
    expect(() => add(usd(MIN), usd(MIN))).toThrow(MoneyOverflowError);
  });

  it('does not mutate its inputs', () => {
    const a = usd(10n);
    const b = usd(20n);
    add(a, b);
    expect(a).toEqual(usd(10n));
    expect(b).toEqual(usd(20n));
  });

  it('returns a frozen value', () => {
    expect(Object.isFrozen(add(usd(1n), usd(2n)))).toBe(true);
  });

  it('rejects a forged operand with a number amount', () => {
    const forged = loose({ kind: 'fiat', amount: 1, currency: 'USD', scale: 2 });
    expect(() => add(usd(1n), forged)).toThrow(InvalidAmountError);
    expect(() => add(forged, usd(1n))).toThrow(InvalidAmountError);
  });
});

describe('subtract', () => {
  it('subtracts and can go negative', () => {
    expect(subtract(usd(500n), usd(125n))).toEqual(usd(375n));
    expect(subtract(usd(125n), usd(500n))).toEqual(usd(-375n));
    expect(subtract(usd(7n), usd(7n))).toEqual(usd(0n));
  });

  it('throws CurrencyMismatchError, ScaleMismatchError and KindMismatchError', () => {
    expect(() => subtract(usd(1n), money(1n, 'KES'))).toThrow(CurrencyMismatchError);
    expect(() => subtract(usd(1n), moneyAt(1n, 'USD', 7))).toThrow(ScaleMismatchError);
    expect(() => subtract(usd(1n), loose(tokenAmount(1n, 'USDC', 'stellar')))).toThrow(
      KindMismatchError,
    );
  });

  it('reaches the exact i128 boundaries', () => {
    expect(subtract(usd(MAX - 1n), usd(-1n)).amount).toBe(MAX);
    expect(subtract(usd(MIN + 1n), usd(1n)).amount).toBe(MIN);
    expect(subtract(usd(-1n), usd(MAX)).amount).toBe(MIN);
  });

  it('throws MoneyOverflowError one past the boundaries', () => {
    expect(() => subtract(usd(MIN), usd(1n))).toThrow(MoneyOverflowError);
    expect(() => subtract(usd(MAX), usd(-1n))).toThrow(MoneyOverflowError);
    expect(() => subtract(usd(0n), usd(MIN))).toThrow(MoneyOverflowError);
    expect(() => subtract(usd(MAX), usd(MIN))).toThrow(MoneyOverflowError);
  });

  it('does not mutate its inputs and returns a frozen value', () => {
    const a = usd(10n);
    const b = usd(3n);
    const r = subtract(a, b);
    expect(a).toEqual(usd(10n));
    expect(b).toEqual(usd(3n));
    expect(Object.isFrozen(r)).toBe(true);
  });
});

describe('multiply', () => {
  it('multiplies by a bigint factor and keeps currency and scale', () => {
    expect(multiply(tokenAmount(25n, 'USDC', 'stellar'), 4n)).toEqual(
      tokenAmount(100n, 'USDC', 'stellar'),
    );
    expect(multiply(usd(25n), -4n)).toEqual(usd(-100n));
    expect(multiply(usd(25n), 0n)).toEqual(usd(0n));
    expect(multiply(usd(25n), 1n)).toEqual(usd(25n));
  });

  it('rejects a number factor', () => {
    expect(() => multiply(usd(25n), loose(2))).toThrow(InvalidAmountError);
    expect(() => multiply(usd(25n), loose(0.5))).toThrow(InvalidAmountError);
    expect(() => multiply(usd(25n), loose('2'))).toThrow(InvalidAmountError);
    expect(() => multiply(usd(25n), loose(Object(2n)))).toThrow(InvalidAmountError);
  });

  it('bounds only the result, so zero times a huge factor is zero', () => {
    expect(multiply(usd(0n), 2n ** 4096n)).toEqual(usd(0n));
    expect(multiply(usd(0n), -(2n ** 4096n))).toEqual(usd(0n));
  });

  it('reaches the exact i128 boundaries', () => {
    expect(multiply(usd(1n), MAX).amount).toBe(MAX);
    expect(multiply(usd(-1n), MAX).amount).toBe(-MAX);
    expect(multiply(usd(1n), MIN).amount).toBe(MIN);
    expect(multiply(usd(2n ** 63n), -(2n ** 64n)).amount).toBe(MIN);
    expect(multiply(usd(MAX), -1n).amount).toBe(-MAX);
  });

  it('throws MoneyOverflowError one past the boundaries', () => {
    expect(() => multiply(usd(1n), MAX + 1n)).toThrow(MoneyOverflowError);
    expect(() => multiply(usd(-1n), MIN)).toThrow(MoneyOverflowError);
    expect(() => multiply(usd(MIN), -1n)).toThrow(MoneyOverflowError);
    expect(() => multiply(usd(2n ** 63n), 2n ** 64n)).toThrow(MoneyOverflowError);
    expect(() => multiply(usd(MAX), 2n)).toThrow(MoneyOverflowError);
    expect(() => multiply(usd(MIN), 2n)).toThrow(MoneyOverflowError);
  });

  it('does not mutate its input and returns a frozen value', () => {
    const a = usd(3n);
    const r = multiply(a, 3n);
    expect(a).toEqual(usd(3n));
    expect(Object.isFrozen(r)).toBe(true);
  });
});

describe('negate', () => {
  it('flips the sign and keeps currency and scale', () => {
    expect(negate(tokenAmount(5n, 'USDC', 'stellar'))).toEqual(tokenAmount(-5n, 'USDC', 'stellar'));
    expect(negate(usd(-5n))).toEqual(usd(5n));
  });

  it('maps zero to zero', () => {
    const r = negate(usd(0n));
    expect(r.amount).toBe(0n);
    expect(isZero(r)).toBe(true);
    expect(isNegative(r)).toBe(false);
  });

  it('negates I128_MAX to -I128_MAX', () => {
    expect(negate(usd(MAX)).amount).toBe(-MAX);
    expect(negate(usd(-MAX)).amount).toBe(MAX);
  });

  it('throws MoneyOverflowError for I128_MIN', () => {
    expect(() => negate(usd(MIN))).toThrow(MoneyOverflowError);
  });

  it('does not mutate its input and returns a frozen value', () => {
    const a = usd(3n);
    const r = negate(a);
    expect(a).toEqual(usd(3n));
    expect(Object.isFrozen(r)).toBe(true);
  });
});

describe('sum', () => {
  it('sums a list of one', () => {
    expect(sum([usd(9n)])).toEqual(usd(9n));
  });

  it('sums many values', () => {
    expect(sum([usd(1n), usd(2n), usd(3n), usd(-10n)])).toEqual(usd(-4n));
  });

  it('throws InvalidAmountError for an empty list', () => {
    expect(() => sum([])).toThrow(InvalidAmountError);
  });

  it('throws on a mismatch anywhere in the list', () => {
    expect(() => sum([usd(1n), usd(1n), money(1n, 'GHS')])).toThrow(CurrencyMismatchError);
    expect(() => sum([usd(1n), usd(1n), moneyAt(1n, 'USD', 6)])).toThrow(ScaleMismatchError);
    expect(() => sum(loose([usd(1n), tokenAmount(1n, 'USDC', 'stellar')]))).toThrow(
      KindMismatchError,
    );
  });

  it('sums token amounts into a token amount', () => {
    const items = [tokenAmount(1n, 'USDC', 'stellar'), tokenAmount(2n, 'USDC', 'stellar')];
    expect(sum(items)).toEqual(tokenAmount(3n, 'USDC', 'stellar'));
  });

  it('reaches the boundary and throws one past it', () => {
    expect(sum([usd(MAX - 2n), usd(1n), usd(1n)]).amount).toBe(MAX);
    expect(() => sum([usd(MAX - 1n), usd(1n), usd(1n)])).toThrow(MoneyOverflowError);
    expect(() => sum([usd(MIN), usd(-1n)])).toThrow(MoneyOverflowError);
  });

  it('behaves like repeated add, so an intermediate overflow throws', () => {
    expect(() => sum([usd(MAX), usd(1n), usd(-1n)])).toThrow(MoneyOverflowError);
  });

  it('does not mutate the list or its items and returns a frozen value', () => {
    const items = [usd(1n), usd(2n)];
    const r = sum(items);
    expect(items).toEqual([usd(1n), usd(2n)]);
    expect(Object.isFrozen(r)).toBe(true);
  });

  it('rejects a list holding a forged item with a number amount', () => {
    expect(() =>
      sum(loose([usd(1n), { kind: 'fiat', amount: 1, currency: 'USD', scale: 2 }])),
    ).toThrow(InvalidAmountError);
  });
});

describe('compare and equals', () => {
  it('orders values', () => {
    expect(compare(usd(1n), usd(2n))).toBe(-1);
    expect(compare(usd(2n), usd(1n))).toBe(1);
    expect(compare(usd(2n), usd(2n))).toBe(0);
    expect(compare(usd(MIN), usd(MAX))).toBe(-1);
    expect(compare(usd(-1n), usd(0n))).toBe(-1);
  });

  it('checks equality', () => {
    expect(equals(usd(2n), usd(2n))).toBe(true);
    expect(equals(usd(2n), usd(3n))).toBe(false);
    expect(equals(usd(MIN), usd(MIN))).toBe(true);
  });

  it('throws on mixed currencies, scales and kinds instead of answering false', () => {
    expect(() => compare(usd(1n), money(1n, 'EUR'))).toThrow(CurrencyMismatchError);
    expect(() => compare(usd(1n), moneyAt(10n, 'USD', 3))).toThrow(ScaleMismatchError);
    expect(() => equals(usd(1n), money(1n, 'EUR'))).toThrow(CurrencyMismatchError);
    expect(() => equals(usd(1n), loose(tokenAmount(1n, 'USDC', 'stellar')))).toThrow(
      KindMismatchError,
    );
  });

  it('compares token amounts of the same asset and chain', () => {
    expect(compare(tokenAmount(1n, 'USDC', 'stellar'), tokenAmount(2n, 'USDC', 'stellar'))).toBe(
      -1,
    );
    expect(equals(tokenAmount(2n, 'USDC', 'stellar'), tokenAmount(2n, 'USDC', 'stellar'))).toBe(
      true,
    );
  });
});

describe('isZero and isNegative', () => {
  it.each([
    [0n, true, false],
    [1n, false, false],
    [-1n, false, true],
    [MAX, false, false],
    [MIN, false, true],
  ])('amount %s gives isZero %s and isNegative %s', (amount, zero, negative) => {
    expect(isZero(usd(amount))).toBe(zero);
    expect(isNegative(usd(amount))).toBe(negative);
  });
});

// A Proxy can claim any prototype it likes, so the plain record check alone
// says nothing about where its fields come from. Only own fields count.
describe('proxied operands', () => {
  const fields = { kind: 'fiat', amount: 7n, currency: 'USD', scale: 2 };
  const claimsPlain = (): object =>
    new Proxy(Object.create(fields) as object, { getPrototypeOf: () => Object.prototype });
  const operations: [string, (value: Money) => unknown][] = [
    ['add', (v) => add(v, usd(1n))],
    ['subtract', (v) => subtract(usd(1n), v)],
    ['multiply', (v) => multiply(v, 2n)],
    ['negate', (v) => negate(v)],
    ['sum', (v) => sum([usd(1n), v])],
    ['compare', (v) => compare(v, usd(1n))],
    ['equals', (v) => equals(usd(1n), v)],
    ['isZero', (v) => isZero(v)],
    ['isNegative', (v) => isNegative(v)],
  ];

  it('a Proxy claiming Object.prototype with inherited fields is refused', () => {
    const proxy = claimsPlain();
    expect(Object.getPrototypeOf(proxy)).toBe(Object.prototype);
    expect(() => negate(loose(proxy))).toThrow(InvalidAmountError);
  });

  it.each(operations)('%s refuses the same proxy', (_name, op) => {
    expect(() => op(loose(claimsPlain()))).toThrow(InvalidAmountError);
  });

  it('refuses fields a get trap answers but the target does not own', () => {
    const answers: Record<string, unknown> = fields;
    const proxy = new Proxy({}, { get: (_target, key): unknown => answers[String(key)] });
    expect(() => negate(loose(proxy))).toThrow(InvalidAmountError);
  });

  it('still accepts a proxy whose target owns every field', () => {
    expect(negate(loose(new Proxy({ ...fields }, {})))).toEqual(usd(-7n));
  });
});

describe('package root', () => {
  // The published package's exports do not change with this module.
  it('does not re-export the money module', () => {
    const fromRoot = root as Record<string, unknown>;
    for (const name of ['money', 'add', 'MoneyError', 'I128_MAX', 'allocate', 'parseMoney']) {
      expect(fromRoot[name], name).toBeUndefined();
    }
  });
});
