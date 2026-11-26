// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The money module's internal helpers and allocate's weights length check.
// build and snapshot are exported from money.ts for sibling modules only, so
// they must validate on their own and never leak through a public index.

import { describe, expect, it } from 'vitest';

import * as root from '../index.js';
import { allocate } from './allocate.js';
import * as moneyIndex from './index.js';
import {
  InvalidAmountError,
  InvalidScaleError,
  KindMismatchError,
  MoneyOverflowError,
  UnknownCurrencyError,
  money,
  moneyAt,
  tokenAmount,
} from './index.js';
import type { Money, MoneyError, TokenAmount } from './index.js';
import {
  MAX_SCALE,
  build,
  buildToken,
  powerOfTen,
  snapshot,
  snapshotFiat,
  snapshotToken,
  withAmount,
} from './money.js';
import { decimalText } from './parse.js';

const MAX = 2n ** 127n - 1n;
const MIN = -(2n ** 127n);

type ErrorClass = abstract new (message?: string) => MoneyError;
const InvalidAllocationError = (moneyIndex as Record<string, unknown>)[
  'InvalidAllocationError'
] as ErrorClass;

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

function expectMoneyError(run: () => unknown, Expected: ErrorClass): void {
  const err = thrown(run);
  expect(Expected).toBeTypeOf('function');
  expect(err).toBeInstanceOf(Expected);
}

const usd = (amount: bigint): Money => money(amount, 'USD');

describe('build validates what it mints', () => {
  it('rejects an unknown currency', () => {
    expectMoneyError(() => build(5n, loose('BTC'), 2), UnknownCurrencyError);
    expectMoneyError(() => build(5n, loose('usd'), 2), UnknownCurrencyError);
    expectMoneyError(() => build(5n, loose(null), 2), UnknownCurrencyError);
  });

  it('rejects an invalid scale', () => {
    for (const scale of [1.5, -1, 19, Number.NaN, Number.POSITIVE_INFINITY, '2', 2n, null]) {
      expectMoneyError(() => build(5n, 'USD', loose(scale)), InvalidScaleError);
    }
  });

  it('rejects an amount outside i128', () => {
    expectMoneyError(() => build(MAX + 1n, 'USD', 2), MoneyOverflowError);
    expectMoneyError(() => build(MIN - 1n, 'USD', 2), MoneyOverflowError);
  });

  it('checks currency before scale before range', () => {
    expectMoneyError(() => build(MAX + 1n, loose('BTC'), 1.5), UnknownCurrencyError);
    expectMoneyError(() => build(MAX + 1n, 'USD', 1.5), InvalidScaleError);
  });

  // The bigint parameter type is gone after a cast or an untyped call, and
  // relational operators compare a number with a bigint without complaint,
  // so the range check alone would let 0.5 through as a frozen Money.
  it.each([
    ['an integer number', 5],
    ['a fractional number', 0.5],
    ['a negative fractional number', -1.25],
    ['a number past i128', 2 ** 200],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['a numeric string', '5'],
    ['a fractional string', '0.5'],
    ['a boxed bigint', Object(5n)],
    ['null', null],
    ['undefined', undefined],
  ])('rejects %s as the amount', (_label, amount) => {
    expectMoneyError(() => build(loose(amount), 'USD', 2), InvalidAmountError);
  });

  it('rejects a number cast to bigint', () => {
    expectMoneyError(() => build(5 as unknown as bigint, 'USD', 2), InvalidAmountError);
  });

  it('checks the amount type after currency and scale', () => {
    expectMoneyError(() => build(loose(0.5), loose('BTC'), 2), UnknownCurrencyError);
    expectMoneyError(() => build(loose(0.5), 'USD', 1.5), InvalidScaleError);
  });

  it('mints a frozen value at the exact boundaries', () => {
    const top = build(MAX, 'USD', 18);
    expect(top).toEqual({ kind: 'fiat', amount: MAX, currency: 'USD', scale: 18 });
    expect(Object.isFrozen(top)).toBe(true);
    expect(build(MIN, 'USD', 2).amount).toBe(MIN);
  });

  it('refuses a scale coarser than the minor unit, negative zero included', () => {
    expectMoneyError(() => build(1n, 'USD', 1), InvalidScaleError);
    expectMoneyError(() => build(1n, 'USD', -0), InvalidScaleError);
  });

  it('refuses token assets, which are not fiat', () => {
    expectMoneyError(() => build(1n, loose('USDC'), 7), UnknownCurrencyError);
  });

  it('is not exported from the money index or the package root', () => {
    const fromIndex = moneyIndex as Record<string, unknown>;
    const fromRoot = root as Record<string, unknown>;
    expect(fromIndex['build']).toBeUndefined();
    expect(fromRoot['build']).toBeUndefined();
    expect(fromIndex['snapshot']).toBeUndefined();
    expect(fromRoot['snapshot']).toBeUndefined();
  });
});

/** A real array whose length reads come back as `length`. */
function withLength(length: unknown, items: readonly unknown[] = [1n, 1n]): readonly bigint[] {
  const proxy = new Proxy([...items], {
    get(target, key, receiver) {
      if (key === 'length') return length;
      return Reflect.get(target, key, receiver) as unknown;
    },
  });
  return loose(proxy);
}

describe('allocate rejects a weights length that is not a whole count', () => {
  it.each([
    ['-1', -1],
    ['NaN', Number.NaN],
    ['1.5', 1.5],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
    ['-0', -0],
    ['0.5', 0.5],
    ['16.5', 16.5],
    ['a numeric string', '2'],
    ['a bigint', 2n],
    ['undefined', undefined],
  ])('rejects a length of %s', (_label, length) => {
    expectMoneyError(() => allocate(usd(100n), withLength(length)), InvalidAllocationError);
  });

  it('never reads a weight when the length is not a whole count', () => {
    for (const length of [-1, Number.NaN, 1.5, Number.POSITIVE_INFINITY]) {
      const reads: string[] = [];
      const proxy = new Proxy([1n, 1n], {
        get(target, key, receiver) {
          if (key === 'length') return length;
          if (typeof key === 'string' && /^[0-9]+$/.test(key)) reads.push(key);
          return Reflect.get(target, key, receiver) as unknown;
        },
      });
      thrown(() => allocate(usd(100n), loose(proxy)));
      expect(reads).toEqual([]);
    }
  });

  it('still accepts a whole length from a proxy', () => {
    const legs = allocate(usd(100n), withLength(2));
    expect(legs.map((leg) => leg.amount)).toEqual([50n, 50n]);
  });

  it('reads the weights length exactly once', () => {
    // A second read could report a different count than the one validated.
    for (const items of [[1n], [1n, 1n, 1n], Array.from({ length: 16 }, () => 1n)]) {
      let lengthReads = 0;
      const proxy = new Proxy([...items], {
        get(target, key, receiver) {
          if (key === 'length') lengthReads += 1;
          return Reflect.get(target, key, receiver) as unknown;
        },
      });
      allocate(usd(100n), loose(proxy));
      expect(lengthReads).toBe(1);
    }
  });

  it('reads the length once even when the second read would grow it', () => {
    let lengthReads = 0;
    const proxy = new Proxy([1n, 1n], {
      get(target, key, receiver) {
        if (key === 'length') {
          lengthReads += 1;
          return lengthReads === 1 ? 2 : 16;
        }
        return Reflect.get(target, key, receiver) as unknown;
      },
    });
    expect(allocate(usd(100n), loose(proxy)).map((leg) => leg.amount)).toEqual([50n, 50n]);
    expect(lengthReads).toBe(1);
  });
});

describe('allocate reports a negative total before any weight problem', () => {
  // Every case below is an InvalidAllocationError, so only the message tells
  // which check fired.
  it.each([
    ['empty weights', []],
    ['a zero weight', [0n]],
    ['a negative weight', [-1n]],
    ['too many weights', Array.from({ length: 17 }, () => 1n)],
    ['a number weight', [1]],
    ['not an array', null],
  ])('with %s', (_label, weights) => {
    const err = thrown(() => allocate(usd(-1n), loose(weights)));
    expect(err).toBeInstanceOf(InvalidAllocationError);
    expect((err as MoneyError).message).toBe('cannot allocate a negative total');
  });

  it('reports the weight problem itself when the total is fine', () => {
    const err = thrown(() => allocate(usd(1n), [0n]));
    expect(err).toBeInstanceOf(InvalidAllocationError);
    expect((err as MoneyError).message).not.toBe('cannot allocate a negative total');
  });
});

describe('powerOfTen', () => {
  it('returns 10 to every scale from 0 to MAX_SCALE', () => {
    let expected = 1n;
    for (let scale = 0; scale <= MAX_SCALE; scale += 1) {
      expect(powerOfTen(scale)).toBe(expected);
      expected *= 10n;
    }
  });

  it.each([-1, 19, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'throws InvalidScaleError for %s instead of converting it',
    (scale) => {
      expectMoneyError(() => powerOfTen(scale), InvalidScaleError);
    },
  );

  it('never takes a power from a polluted prototype', () => {
    const proto = Object.prototype as Record<string, unknown>;
    proto['19'] = 10n ** 19n;
    proto['1.5'] = 10n;
    try {
      expectMoneyError(() => powerOfTen(19), InvalidScaleError);
      expectMoneyError(() => powerOfTen(1.5), InvalidScaleError);
      expect(powerOfTen(18)).toBe(10n ** 18n);
    } finally {
      delete proto['19'];
      delete proto['1.5'];
    }
  });

  it('is not exported from the money index or the package root', () => {
    expect((moneyIndex as Record<string, unknown>)['powerOfTen']).toBeUndefined();
    expect((root as Record<string, unknown>)['powerOfTen']).toBeUndefined();
  });
});

describe('token and kind helpers', () => {
  it('buildToken validates the pair and the amount and takes the scale from the table', () => {
    expect(buildToken(5n, 'USDC', 'stellar')).toEqual(tokenAmount(5n, 'USDC', 'stellar'));
    expect(buildToken(5n, 'USDC', 'stellar').scale).toBe(7);
    expectMoneyError(() => buildToken(5n, loose('USDT'), 'stellar'), UnknownCurrencyError);
    expectMoneyError(() => buildToken(loose(5), 'USDC', 'stellar'), InvalidAmountError);
    expectMoneyError(() => buildToken(MAX + 1n, 'USDC', 'stellar'), MoneyOverflowError);
  });

  it('withAmount keeps the unit of fiat and token values', () => {
    expect(withAmount(moneyAt(1n, 'NGN', 6), 9n)).toEqual(moneyAt(9n, 'NGN', 6));
    expect(withAmount(tokenAmount(1n, 'USDC', 'stellar'), 9n)).toEqual(
      tokenAmount(9n, 'USDC', 'stellar'),
    );
  });

  it('snapshot rejects a missing or unknown kind before reading other fields', () => {
    for (const kind of [undefined, 'Fiat', 'tokens', 1, null]) {
      expectMoneyError(
        () => snapshot(loose({ kind, amount: 1n, currency: 'USD', scale: 2 })),
        InvalidAmountError,
      );
    }
  });

  it('snapshotFiat and snapshotToken refuse the other kind', () => {
    expectMoneyError(
      () => snapshotFiat(loose(tokenAmount(1n, 'USDC', 'stellar'))),
      KindMismatchError,
    );
    expectMoneyError(() => snapshotToken(loose(money(1n, 'USD'))), KindMismatchError);
    const fiat: Money = snapshotFiat(money(1n, 'USD'));
    const token: TokenAmount = snapshotToken(tokenAmount(1n, 'USDC', 'stellar'));
    expect(fiat.kind).toBe('fiat');
    expect(token.kind).toBe('token');
  });

  it('decimalText handles scale 0 and negatives', () => {
    expect(decimalText(7n, 0)).toBe('7');
    expect(decimalText(-7n, 0)).toBe('-7');
    expect(decimalText(-5n, 2)).toBe('-0.05');
    expect(decimalText(1_234_567n, 6)).toBe('1.234567');
  });

  it('keeps the new helpers out of the money index and the package root', () => {
    for (const name of [
      'buildToken',
      'withAmount',
      'snapshotFiat',
      'snapshotToken',
      'decimalText',
    ]) {
      expect((moneyIndex as Record<string, unknown>)[name]).toBeUndefined();
      expect((root as Record<string, unknown>)[name]).toBeUndefined();
    }
  });
});
