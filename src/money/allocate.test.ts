// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

/*
 * Public contract for allocate (src/money/allocate.ts, exported from
 * ./index.js; the package root does not re-export it). The contract block
 * in money.test.ts and the single read snapshot rules in money-forged.test.ts
 * still apply.
 *
 * Constants
 *   MAX_ALLOCATION_LEGS: number = 16
 *
 * Errors
 *   InvalidAllocationError  code 'INVALID_ALLOCATION'  extends MoneyError, `name`
 *                                                      equals the class name. Lives
 *                                                      in errors.ts beside the others.
 *
 * allocate(total: Money, weights: readonly bigint[]): Money[]
 *   Splits total into weights.length legs, one per weight, in weight order.
 *   Let W = sum(weights) and n = weights.length.
 *     leg i, for i >= 1:  floor(total.amount * weights[i] / W)
 *     leg 0:              total.amount - (leg 1 + ... + leg n-1)
 *   So the rounding remainder always lands on the first leg and the legs
 *   always sum exactly to the total. Example: 100 split 1:1:1 is 34, 33, 33.
 *   Leg 0 can sit more than one unit above its exact share when there are
 *   three or more legs (2 split 1:1:1 is 2, 0, 0); every other leg sits at or
 *   less than one unit below its exact share.
 *
 *   Validation order, first failure wins:
 *     1. total is snapshotted (amount, currency and scale each read exactly
 *        once) and validated like any operand:
 *          not a non null object        InvalidAmountError
 *          amount not a bigint          InvalidAmountError
 *          currency not a known code    UnknownCurrencyError
 *          scale not an integer 0..18   InvalidScaleError
 *          amount outside i128          MoneyOverflowError
 *     2. total.amount < 0                InvalidAllocationError
 *        (a zero total is valid and yields all zero legs)
 *     3. weights is not an array (Array.isArray is false)
 *                                        InvalidAllocationError
 *     4. weights.length is 0 or greater than MAX_ALLOCATION_LEGS
 *                                        InvalidAllocationError
 *        checked before any weight is read
 *     5. each weight, read exactly once, in index order, is not a bigint
 *        (number, string, boxed bigint, null, undefined, hole) or is <= 0n
 *                                        InvalidAllocationError
 *     6. W > I128_MAX                    MoneyOverflowError
 *     7. total.amount * weights[i] > I128_MAX for some i >= 1
 *                                        MoneyOverflowError
 *        (the leg 0 product is never formed, so a single weight never
 *        overflows and [2n, 1n] on I128_MAX is fine while [1n, 2n] throws)
 *
 *   Result: a fresh array of exactly n legs, never the weights array. Every
 *   leg is a frozen Money with exactly the keys amount, currency and scale,
 *   carrying the snapshot currency and scale of the total. Inputs are never
 *   mutated; frozen weight arrays are accepted. Output is a pure function of
 *   (total snapshot, weights snapshot).
 *
 *   Error messages follow the money rules: at most 200 characters, no line
 *   breaks, never echo operand or weight text, and never call toString,
 *   valueOf or Symbol.toPrimitive on a weight or a total field.
 */

import { describe, expect, it } from 'vitest';

import * as root from '../index.js';
import { MAX_ALLOCATION_LEGS, allocate } from './allocate.js';
import * as moneyIndex from './index.js';
import {
  InvalidAmountError,
  InvalidScaleError,
  MoneyError,
  MoneyOverflowError,
  UnknownCurrencyError,
  money,
  moneyAt,
  tokenAmount,
} from './index.js';
import type { FiatCurrencyCode, Money, TokenAmount } from './index.js';

const MAX = 2n ** 127n - 1n;
const MIN = -(2n ** 127n);
const MAX_MESSAGE_LENGTH = 200;

const usd = (amount: bigint): Money => money(amount, 'USD');

// The error class comes through the module namespace so a missing export
// fails the assertions here instead of crashing the whole file at import.
type ErrorClass = abstract new (message?: string) => MoneyError;
const InvalidAllocationError = (moneyIndex as Record<string, unknown>)[
  'InvalidAllocationError'
] as ErrorClass;

// Hands allocate values the type system would refuse.
function loose(value: unknown): never {
  return value as never;
}

function thrown(run: () => unknown): unknown {
  try {
    run();
  } catch (err) {
    return err;
  }
  return undefined;
}

function expectMoneyError(run: () => unknown, Expected: ErrorClass): MoneyError {
  const err = thrown(run);
  expect(Expected).toBeTypeOf('function');
  expect(err).toBeInstanceOf(Expected);
  return err as MoneyError;
}

function expectSafeMessage(err: MoneyError): void {
  expect(err.message.length).toBeLessThanOrEqual(MAX_MESSAGE_LENGTH);
  expect(err.message).not.toMatch(/[\r\n\u2028\u2029]/);
}

const amounts = (legs: readonly Money[]): bigint[] => legs.map((leg) => leg.amount);

function expectLegsOf(total: Money, legs: readonly Money[]): void {
  for (const leg of legs) {
    expect(Object.isFrozen(leg)).toBe(true);
    expect(Object.keys(leg).sort()).toEqual(['amount', 'currency', 'kind', 'scale']);
    expect(typeof leg.amount).toBe('bigint');
    expect(leg.currency).toBe(total.currency);
    expect(leg.scale).toBe(total.scale);
  }
  expect(legs.reduce((acc, leg) => acc + leg.amount, 0n)).toBe(total.amount);
}

/** An operand whose fields answer from a list, one entry per read. */
function sequenced(fields: {
  kind?: 'fiat';
  amount: unknown[];
  currency: unknown[];
  scale: unknown[];
}): {
  value: Money;
  reads: { kind: number; amount: number; currency: number; scale: number };
} {
  const reads = { kind: 0, amount: 0, currency: 0, scale: 0 };
  const value = new Proxy(
    { kind: undefined, amount: undefined, currency: undefined, scale: undefined },
    {
      get(_target, key) {
        if (key === 'kind') {
          reads.kind += 1;
          return 'fiat';
        }
        if (key === 'amount' || key === 'currency' || key === 'scale') {
          reads[key] += 1;
          const list = fields[key];
          return list[Math.min(reads[key], list.length) - 1];
        }
        return undefined;
      },
    },
  );
  return { value: loose(value), reads };
}

/**
 * A real array behind a proxy that counts reads of each index and can answer
 * a different value on later reads of the same index.
 */
function countedWeights(answers: unknown[][]): {
  weights: readonly bigint[];
  reads: number[];
} {
  const reads = answers.map(() => 0);
  const backing = answers.map((list) => list[0]);
  const weights = new Proxy(backing, {
    get(target, key, receiver) {
      if (typeof key === 'string' && /^(0|[1-9][0-9]*)$/.test(key)) {
        const i = Number.parseInt(key, 10);
        const list = answers[i];
        if (list !== undefined) {
          reads[i] = (reads[i] ?? 0) + 1;
          return list[Math.min(reads[i] ?? 1, list.length) - 1];
        }
      }
      return Reflect.get(target, key, receiver) as unknown;
    },
  });
  return { weights: loose(weights), reads };
}

describe('exports', () => {
  it('exposes allocate, MAX_ALLOCATION_LEGS and InvalidAllocationError from the money index only', () => {
    const fromIndex = moneyIndex as Record<string, unknown>;
    const fromRoot = root as Record<string, unknown>;
    expect(fromIndex['allocate']).toBe(allocate);
    expect(fromRoot['allocate']).toBeUndefined();
    expect(fromIndex['MAX_ALLOCATION_LEGS']).toBe(MAX_ALLOCATION_LEGS);
    expect(fromRoot['MAX_ALLOCATION_LEGS']).toBeUndefined();
    expect(fromIndex['InvalidAllocationError']).toBeTypeOf('function');
    expect(fromRoot['InvalidAllocationError']).toBeUndefined();
  });

  it('caps an allocation at 16 legs', () => {
    expect(MAX_ALLOCATION_LEGS).toBe(16);
  });
});

describe('InvalidAllocationError', () => {
  it('has a stable code and name and extends MoneyError', () => {
    expect(InvalidAllocationError).toBeTypeOf('function');
    const Ctor = InvalidAllocationError as unknown as new (message?: string) => MoneyError;
    const err = new Ctor('boom');
    expect(err).toBeInstanceOf(MoneyError);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('InvalidAllocationError');
    expect(err.code).toBe('INVALID_ALLOCATION');
    expect(err.message).toBe('boom');
  });
});

describe('allocate concrete splits', () => {
  it('100 by 1:1:1 is 34, 33, 33', () => {
    const total = usd(100n);
    const legs = allocate(total, [1n, 1n, 1n]);
    expect(amounts(legs)).toEqual([34n, 33n, 33n]);
    expectLegsOf(total, legs);
  });

  it('one leg returns the total', () => {
    for (const weight of [1n, 7n, 10n ** 6n, MAX]) {
      const total = usd(12_345n);
      const legs = allocate(total, [weight]);
      expect(legs).toHaveLength(1);
      expect(legs[0]).toEqual(total);
      expectLegsOf(total, legs);
    }
  });

  it('one leg returns an I128_MAX total unchanged, since the leg 0 product is never formed', () => {
    const total = usd(MAX);
    expect(amounts(allocate(total, [1n]))).toEqual([MAX]);
    expect(amounts(allocate(total, [2n]))).toEqual([MAX]);
    expect(amounts(allocate(total, [MAX]))).toEqual([MAX]);
  });

  it('2 by 1:1:1 is 2, 0, 0: the first leg may exceed its exact share by more than one unit', () => {
    expect(amounts(allocate(usd(2n), [1n, 1n, 1n]))).toEqual([2n, 0n, 0n]);
  });

  it('1 by 1:1 is 1, 0', () => {
    expect(amounts(allocate(usd(1n), [1n, 1n]))).toEqual([1n, 0n]);
  });

  it('100 by 1:2:3 is 17, 33, 50', () => {
    expect(amounts(allocate(usd(100n), [1n, 2n, 3n]))).toEqual([17n, 33n, 50n]);
  });

  it('100 by 3:2:1 is 51, 33, 16', () => {
    expect(amounts(allocate(usd(100n), [3n, 2n, 1n]))).toEqual([51n, 33n, 16n]);
  });

  it('weight order matters: 10 by 1:2 is 4, 6 and 10 by 2:1 is 7, 3', () => {
    expect(amounts(allocate(usd(10n), [1n, 2n]))).toEqual([4n, 6n]);
    expect(amounts(allocate(usd(10n), [2n, 1n]))).toEqual([7n, 3n]);
  });

  it('an exact split has no remainder: 1000 by 70:30 is 700, 300', () => {
    expect(amounts(allocate(usd(1000n), [70n, 30n]))).toEqual([700n, 300n]);
  });

  it('a tiny weight beside a huge one floors to zero: 999 by 1000000:1 is 999, 0', () => {
    expect(amounts(allocate(usd(999n), [10n ** 6n, 1n]))).toEqual([999n, 0n]);
  });

  it('5 across 16 equal legs puts all 5 on the first leg', () => {
    const legs = allocate(
      usd(5n),
      Array.from({ length: 16 }, () => 1n),
    );
    expect(amounts(legs)).toEqual([5n, ...Array.from({ length: 15 }, () => 0n)]);
  });

  it('a zero total yields all zero legs', () => {
    const total = usd(0n);
    const legs = allocate(total, [3n, 7n, 1n]);
    expect(amounts(legs)).toEqual([0n, 0n, 0n]);
    expectLegsOf(total, legs);
  });

  it('splits an I128_MAX total in half without overflow', () => {
    const total = usd(MAX);
    const legs = allocate(total, [1n, 1n]);
    expect(amounts(legs)).toEqual([2n ** 126n, 2n ** 126n - 1n]);
    expectLegsOf(total, legs);
  });

  it('accepts I128_MAX with 2:1, because only products past the first leg are bounded', () => {
    const total = usd(MAX);
    const legs = allocate(total, [2n, 1n]);
    expect(amounts(legs)).toEqual([MAX - MAX / 3n, MAX / 3n]);
    expectLegsOf(total, legs);
  });

  it('accepts weights that sum to exactly I128_MAX', () => {
    expect(amounts(allocate(usd(1n), [MAX - 1n, 1n]))).toEqual([1n, 0n]);
  });

  it('accepts exactly MAX_ALLOCATION_LEGS legs', () => {
    const weights = Array.from({ length: 16 }, (_, i) => BigInt(i + 1));
    const total = usd(10_000n);
    const legs = allocate(total, weights);
    expect(legs).toHaveLength(16);
    expectLegsOf(total, legs);
  });

  it('keeps the currency and scale of every supported fiat unit', () => {
    const cases: [FiatCurrencyCode, number][] = [
      ['USD', 2],
      ['NGN', 2],
      ['KES', 6],
      ['USD', 18],
    ];
    for (const [currency, scale] of cases) {
      const total = moneyAt(10n ** 18n + 1n, currency, scale);
      const legs = allocate(total, [5n, 3n, 2n]);
      expectLegsOf(total, legs);
    }
  });

  it('keeps the asset and chain of every token leg', () => {
    const totals: TokenAmount[] = [
      tokenAmount(10n ** 18n + 1n, 'USDC', 'stellar'),
      tokenAmount(7n, 'USDC', 'stellar'),
    ];
    for (const total of totals) {
      const legs = allocate(total, [5n, 3n, 2n]);
      expect(legs.reduce((acc, leg) => acc + leg.amount, 0n)).toBe(total.amount);
      for (const leg of legs) {
        expect(Object.isFrozen(leg)).toBe(true);
        expect({ ...leg, amount: 0n }).toEqual({ ...total, amount: 0n });
      }
    }
  });

  it('refuses a token total that disagrees with the token table', () => {
    const forged = loose({
      kind: 'token',
      amount: 100n,
      asset: 'USDC',
      chain: 'stellar',
      scale: 6,
    });
    expect(() => allocate(forged, [1n, 1n])).toThrow(InvalidScaleError);
  });
});

describe('allocate purity', () => {
  it('returns a fresh array, never the weights array', () => {
    const weights = [1n, 1n];
    const legs = allocate(usd(10n), weights);
    expect(legs).not.toBe(weights);
    expect(Array.isArray(legs)).toBe(true);
  });

  it('never mutates the weights and accepts a frozen weights array', () => {
    const weights = Object.freeze([3n, 1n, 1n]);
    expect(amounts(allocate(usd(10n), weights))).toEqual([6n, 2n, 2n]);
    expect(weights).toEqual([3n, 1n, 1n]);
    const plain = [3n, 1n, 1n];
    allocate(usd(10n), plain);
    expect(plain).toEqual([3n, 1n, 1n]);
  });

  it('returns the same legs on every call', () => {
    const a = allocate(usd(1_000_003n), [7n, 11n, 13n]);
    const b = allocate(usd(1_000_003n), [7n, 11n, 13n]);
    expect(a).toEqual(b);
  });

  it('mutating a returned array does not affect a later call', () => {
    const first = allocate(usd(9n), [1n, 2n]);
    first.pop();
    expect(amounts(allocate(usd(9n), [1n, 2n]))).toEqual([3n, 6n]);
  });

  it('accepts a well formed plain object total, as a row mapper would produce', () => {
    const row = loose({ kind: 'fiat', amount: 100n, currency: 'KES', scale: 2, chain: 'stellar' });
    const legs = allocate(row, [1n, 1n, 1n]);
    expect(legs).toEqual([money(34n, 'KES'), money(33n, 'KES'), money(33n, 'KES')]);
    for (const leg of legs)
      expect(Object.keys(leg).sort()).toEqual(['amount', 'currency', 'kind', 'scale']);
  });
});

describe('allocate rejects bad totals', () => {
  it('throws on a negative total', () => {
    for (const amount of [-1n, -100n, MIN]) {
      expectMoneyError(() => allocate(usd(amount), [1n]), InvalidAllocationError);
      expectMoneyError(() => allocate(usd(amount), [1n, 1n, 1n]), InvalidAllocationError);
    }
  });

  const forgedCases: [string, unknown, ErrorClass][] = [
    ['null', null, InvalidAmountError],
    ['undefined', undefined, InvalidAmountError],
    ['a number', 100, InvalidAmountError],
    ['a bigint', 100n, InvalidAmountError],
    [
      'a string amount',
      { kind: 'fiat', amount: '100', currency: 'USD', scale: 2 },
      InvalidAmountError,
    ],
    [
      'a number amount',
      { kind: 'fiat', amount: 100, currency: 'USD', scale: 2 },
      InvalidAmountError,
    ],
    [
      'a boxed bigint amount',
      { kind: 'fiat', amount: Object(100n) as unknown, currency: 'USD', scale: 2 },
      InvalidAmountError,
    ],
    [
      'an unknown currency',
      { kind: 'fiat', amount: 100n, currency: 'BTC', scale: 2 },
      UnknownCurrencyError,
    ],
    [
      'a lower case currency',
      { kind: 'fiat', amount: 100n, currency: 'usd', scale: 2 },
      UnknownCurrencyError,
    ],
    [
      'a fractional scale',
      { kind: 'fiat', amount: 100n, currency: 'USD', scale: 1.5 },
      InvalidScaleError,
    ],
    [
      'a scale of 19',
      { kind: 'fiat', amount: 100n, currency: 'USD', scale: 19 },
      InvalidScaleError,
    ],
    [
      'a string scale',
      { kind: 'fiat', amount: 100n, currency: 'USD', scale: '2' },
      InvalidScaleError,
    ],
    [
      'an amount above i128',
      { kind: 'fiat', amount: MAX + 1n, currency: 'USD', scale: 2 },
      MoneyOverflowError,
    ],
    [
      'an amount below i128',
      { kind: 'fiat', amount: MIN - 1n, currency: 'USD', scale: 2 },
      MoneyOverflowError,
    ],
  ];

  it.each(forgedCases)('rejects a forged total with %s', (_label, total, Expected) => {
    expectMoneyError(() => allocate(loose(total), [1n, 1n]), Expected);
  });

  it('validates the total before the weights', () => {
    const forged = loose({ kind: 'fiat', amount: '1', currency: 'USD', scale: 2 });
    expectMoneyError(() => allocate(forged, []), InvalidAmountError);
    expectMoneyError(
      () => allocate(loose({ kind: 'fiat', amount: 1n, currency: 'BTC', scale: 2 }), [0n]),
      UnknownCurrencyError,
    );
    expectMoneyError(
      () =>
        allocate(loose({ kind: 'fiat', amount: MAX + 1n, currency: 'USD', scale: 2 }), loose(null)),
      MoneyOverflowError,
    );
  });

  it('reads each total field exactly once', () => {
    const t = sequenced({ kind: 'fiat', amount: [100n], currency: ['USD'], scale: [2] });
    allocate(t.value, [1n, 1n, 1n]);
    expect(t.reads).toEqual({ kind: 1, amount: 1, currency: 1, scale: 1 });
  });

  it('never relabels legs when the total currency changes between reads', () => {
    const t = sequenced({ kind: 'fiat', amount: [100n], currency: ['USD', 'NGN'], scale: [2] });
    const legs = allocate(t.value, [1n, 1n]);
    expect(legs).toEqual([usd(50n), usd(50n)]);
  });

  it('never rescales legs when the total scale changes between reads', () => {
    const t = sequenced({ kind: 'fiat', amount: [100n], currency: ['USD'], scale: [6, 18] });
    const legs = allocate(t.value, [1n, 1n]);
    expect(legs).toEqual([moneyAt(50n, 'USD', 6), moneyAt(50n, 'USD', 6)]);
  });

  it('never splits an amount that changed after validation', () => {
    // A second read would turn a valid total into a negative or out of range one.
    const neg = sequenced({ kind: 'fiat', amount: [100n, -100n], currency: ['USD'], scale: [2] });
    expect(amounts(allocate(neg.value, [1n, 1n, 1n]))).toEqual([34n, 33n, 33n]);
    const huge = sequenced({
      kind: 'fiat',
      amount: [100n, 2n ** 200n],
      currency: ['USD'],
      scale: [2],
    });
    expect(amounts(allocate(huge.value, [1n, 1n, 1n]))).toEqual([34n, 33n, 33n]);
  });

  it('never calls toString, valueOf or Symbol.toPrimitive on a total field', () => {
    const calls: string[] = [];
    const hostile = {
      toString() {
        calls.push('toString');
        return 'USD';
      },
      valueOf() {
        calls.push('valueOf');
        return 2;
      },
      [Symbol.toPrimitive]() {
        calls.push('toPrimitive');
        return 'USD';
      },
    };
    expectSafeMessage(
      expectMoneyError(
        () => allocate(loose({ kind: 'fiat', amount: 1n, currency: hostile, scale: 2 }), [1n]),
        UnknownCurrencyError,
      ),
    );
    expectSafeMessage(
      expectMoneyError(
        () => allocate(loose({ kind: 'fiat', amount: 1n, currency: 'USD', scale: hostile }), [1n]),
        InvalidScaleError,
      ),
    );
    expectSafeMessage(
      expectMoneyError(
        () => allocate(loose({ kind: 'fiat', amount: hostile, currency: 'USD', scale: 2 }), [1n]),
        InvalidAmountError,
      ),
    );
    expect(calls).toEqual([]);
  });

  it('keeps a forged currency with a newline out of the message', () => {
    const forged = loose({
      kind: 'fiat',
      amount: 1n,
      currency: 'USD\nlevel=info msg=paid',
      scale: 2,
    });
    const err = expectMoneyError(() => allocate(forged, [1n]), UnknownCurrencyError);
    expectSafeMessage(err);
    expect(err.message).not.toContain('msg=paid');
  });
});

describe('allocate rejects bad weights', () => {
  it('throws on empty weights', () => {
    expectMoneyError(() => allocate(usd(100n), []), InvalidAllocationError);
    expectMoneyError(() => allocate(usd(0n), []), InvalidAllocationError);
  });

  it('throws on a zero weight', () => {
    expectMoneyError(() => allocate(usd(100n), [0n]), InvalidAllocationError);
    expectMoneyError(() => allocate(usd(100n), [1n, 0n]), InvalidAllocationError);
    expectMoneyError(() => allocate(usd(100n), [0n, 1n]), InvalidAllocationError);
    expectMoneyError(() => allocate(usd(0n), [0n, 0n]), InvalidAllocationError);
  });

  it('throws on a negative weight, even when the weights still sum to a positive', () => {
    expectMoneyError(() => allocate(usd(100n), [-1n]), InvalidAllocationError);
    expectMoneyError(() => allocate(usd(100n), [3n, -1n]), InvalidAllocationError);
    expectMoneyError(() => allocate(usd(100n), [-1n, 3n]), InvalidAllocationError);
    expectMoneyError(() => allocate(usd(100n), [2n, MIN]), InvalidAllocationError);
  });

  const nonBigintWeights: [string, unknown][] = [
    ['the number 1', 1],
    ['the number 0', 0],
    ['a fractional number', 1.5],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['a numeric string', '1'],
    ['a boxed bigint', Object(1n)],
    ['null', null],
    ['undefined', undefined],
    ['true', true],
    ['a symbol', Symbol('1')],
    ['an object', { weight: 1n }],
    ['a nested array', [1n]],
  ];

  it.each(nonBigintWeights)('throws on a weight that is %s', (_label, weight) => {
    expectMoneyError(() => allocate(usd(100n), loose([weight])), InvalidAllocationError);
    expectMoneyError(() => allocate(usd(100n), loose([1n, weight])), InvalidAllocationError);
    expectMoneyError(() => allocate(usd(100n), loose([weight, 1n])), InvalidAllocationError);
  });

  it('throws on a hole in a sparse weights array', () => {
    // Built with a deleted element rather than a sparse literal, so no lint
    // disable comment is needed where inline config is ignored.
    const withHole: unknown[] = [1n, 0n, 1n];
    Reflect.deleteProperty(withHole, 1);
    const sparse = loose(withHole);
    expectMoneyError(() => allocate(usd(100n), sparse), InvalidAllocationError);
    const holes = loose(new Array(3));
    expectMoneyError(() => allocate(usd(100n), holes), InvalidAllocationError);
  });

  const nonArrays: [string, unknown][] = [
    ['null', null],
    ['undefined', undefined],
    ['a bigint', 1n],
    ['a string', '11'],
    ['an array like object', { length: 1, 0: 1n }],
    ['a BigInt64Array', BigInt64Array.of(1n, 1n)],
    ['a Set', new Set([1n, 2n])],
  ];

  it.each(nonArrays)('throws when weights is %s', (_label, weights) => {
    expectMoneyError(() => allocate(usd(100n), loose(weights)), InvalidAllocationError);
  });

  it('throws on more than MAX_ALLOCATION_LEGS weights', () => {
    for (const length of [17, 100, 100_000]) {
      const weights = Array.from({ length }, () => 1n);
      expectMoneyError(() => allocate(usd(100n), weights), InvalidAllocationError);
    }
  });

  it('checks the leg count before reading any weight', () => {
    const tooMany = countedWeights(Array.from({ length: 17 }, () => [1n]));
    expectMoneyError(() => allocate(usd(100n), tooMany.weights), InvalidAllocationError);
    expect(tooMany.reads.every((n) => n === 0)).toBe(true);
  });

  it('reads each weight exactly once', () => {
    const counted = countedWeights([[1n], [1n], [1n]]);
    expect(amounts(allocate(usd(100n), counted.weights))).toEqual([34n, 33n, 33n]);
    expect(counted.reads).toEqual([1, 1, 1]);
  });

  it('never splits by a weight that changed after validation', () => {
    // Second reads would turn a valid weight into zero, a number or a huge value.
    const counted = countedWeights([
      [1n, 0n],
      [1n, 1],
      [1n, 2n ** 200n],
    ]);
    expect(amounts(allocate(usd(100n), counted.weights))).toEqual([34n, 33n, 33n]);
  });

  it('never calls toString, valueOf or Symbol.toPrimitive on a weight', () => {
    const calls: string[] = [];
    const hostile = {
      toString() {
        calls.push('toString');
        return '1';
      },
      valueOf() {
        calls.push('valueOf');
        return 1n;
      },
      [Symbol.toPrimitive]() {
        calls.push('toPrimitive');
        return 1n;
      },
    };
    const err = expectMoneyError(
      () => allocate(usd(100n), loose([1n, hostile])),
      InvalidAllocationError,
    );
    expectSafeMessage(err);
    expect(calls).toEqual([]);
  });

  it('keeps weight text out of the message', () => {
    const err = expectMoneyError(
      () => allocate(usd(100n), loose(['1\nlevel=info msg=paid'])),
      InvalidAllocationError,
    );
    expectSafeMessage(err);
    expect(err.message).not.toContain('msg=paid');
    expectSafeMessage(
      expectMoneyError(() => allocate(usd(100n), loose(['U'.repeat(1_000_000)])), MoneyError),
    );
  });

  it('keeps every allocation error message bounded and on one line', () => {
    const runs: (() => unknown)[] = [
      () => allocate(usd(-1n), [1n]),
      () => allocate(usd(1n), []),
      () => allocate(usd(1n), [0n]),
      () =>
        allocate(
          usd(1n),
          Array.from({ length: 17 }, () => 1n),
        ),
      () => allocate(usd(MAX), [1n, 2n]),
    ];
    for (const run of runs) expectSafeMessage(expectMoneyError(run, MoneyError));
  });
});

describe('allocate overflow', () => {
  it('throws MoneyOverflowError when a product past the first leg leaves i128', () => {
    expectMoneyError(() => allocate(usd(MAX), [1n, 2n]), MoneyOverflowError);
    expectMoneyError(() => allocate(usd(2n ** 64n), [1n, 2n ** 63n]), MoneyOverflowError);
    expectMoneyError(() => allocate(usd(MAX / 2n + 1n), [1n, 1n, 2n]), MoneyOverflowError);
  });

  it('accepts a product that lands exactly on I128_MAX', () => {
    // I128_MAX times a weight of 1 is the largest product allowed.
    expect(amounts(allocate(usd(MAX), [1n, 1n]))).toEqual([2n ** 126n, 2n ** 126n - 1n]);
    expect(amounts(allocate(usd(MAX), [5n, 1n, 1n]))).toEqual([
      MAX - 2n * (MAX / 7n),
      MAX / 7n,
      MAX / 7n,
    ]);
    // One unit below the bound with the largest weight that keeps the sum in range.
    expect(amounts(allocate(usd(1n), [1n, MAX - 1n]))).toEqual([1n, 0n]);
  });

  it('throws MoneyOverflowError when the weights sum past I128_MAX', () => {
    expectMoneyError(() => allocate(usd(0n), [MAX, 1n]), MoneyOverflowError);
    expectMoneyError(() => allocate(usd(1n), [MAX + 1n]), MoneyOverflowError);
    expectMoneyError(() => allocate(usd(1n), [2n ** 200n]), MoneyOverflowError);
    expectMoneyError(
      () =>
        allocate(
          usd(0n),
          Array.from({ length: 16 }, () => 2n ** 123n),
        ),
      MoneyOverflowError,
    );
  });

  it('a zero total never overflows on products', () => {
    expect(amounts(allocate(usd(0n), [1n, MAX - 1n]))).toEqual([0n, 0n]);
  });

  it('checks weight types before overflow', () => {
    expectMoneyError(() => allocate(usd(MAX), [1n, 2n, 0n]), InvalidAllocationError);
    expectMoneyError(() => allocate(usd(1n), loose([MAX, MAX, 1])), InvalidAllocationError);
  });
});
