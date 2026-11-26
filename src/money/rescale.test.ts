// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The API contract for rescale is documented at the top of parse.test.ts.

import { describe, expect, it } from 'vitest';

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
import type { Money, MoneyError } from './index.js';
import { rescale, toMinor } from './rescale.js';
import type { RoundingMode } from './rescale.js';

const MAX = 2n ** 127n - 1n;
const MIN = -(2n ** 127n);
const MODES: readonly RoundingMode[] = ['half-even', 'half-up', 'floor', 'ceil', 'trunc'];

type ErrorClass = abstract new (message?: string) => MoneyError;
const InvalidRoundingModeError = (moneyIndex as Record<string, unknown>)[
  'InvalidRoundingModeError'
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

function expectMoneyError(run: () => unknown, Expected: ErrorClass): MoneyError {
  const err = thrown(run);
  expect(Expected).toBeTypeOf('function');
  expect(err).toBeInstanceOf(Expected);
  return err as MoneyError;
}

const usd = (amount: bigint, scale: number): Money => moneyAt(amount, 'USD', scale);

describe('rescale down', () => {
  it('rounds 1.005 to 1.00 half-even and 1.01 half-up', () => {
    expect(rescale(usd(1005n, 3), 2, 'half-even')).toEqual(usd(100n, 2));
    expect(rescale(usd(1005n, 3), 2, 'half-up')).toEqual(usd(101n, 2));
  });

  // Amounts at scale 3 rounded to scale 2. Columns follow MODES.
  const table: [bigint, [bigint, bigint, bigint, bigint, bigint]][] = [
    [1005n, [100n, 101n, 100n, 101n, 100n]],
    [1015n, [102n, 102n, 101n, 102n, 101n]],
    [1025n, [102n, 103n, 102n, 103n, 102n]],
    [1006n, [101n, 101n, 100n, 101n, 100n]],
    [1004n, [100n, 100n, 100n, 101n, 100n]],
    [1000n, [100n, 100n, 100n, 100n, 100n]],
    [-1005n, [-100n, -101n, -101n, -100n, -100n]],
    [-1015n, [-102n, -102n, -102n, -101n, -101n]],
    [-1006n, [-101n, -101n, -101n, -100n, -100n]],
    [-1004n, [-100n, -100n, -101n, -100n, -100n]],
    [-1000n, [-100n, -100n, -100n, -100n, -100n]],
    [5n, [0n, 1n, 0n, 1n, 0n]],
    [-5n, [0n, -1n, -1n, 0n, 0n]],
    [15n, [2n, 2n, 1n, 2n, 1n]],
    [-15n, [-2n, -2n, -2n, -1n, -1n]],
    [1n, [0n, 0n, 0n, 1n, 0n]],
    [-1n, [0n, 0n, -1n, 0n, 0n]],
    [0n, [0n, 0n, 0n, 0n, 0n]],
  ];

  describe.each(table)('%s thousandths', (amount, expected) => {
    it.each(MODES.map((mode, i) => [mode, expected[i]] as const))(
      'rounds %s to %s hundredths',
      (mode, want) => {
        const r = rescale(usd(amount, 3), 2, mode);
        expect(r.amount).toBe(want);
        expect(r.scale).toBe(2);
        expect(r.currency).toBe('USD');
        expect(Object.isFrozen(r)).toBe(true);
      },
    );
  });

  it('looks at every dropped digit, not only the first, to find a tie', () => {
    // USD at a working scale of 6 rounded to cents: four dropped digits.
    const usdc = (amount: bigint): Money => usd(amount, 6);
    expect(rescale(usdc(1_225_000n), 2, 'half-even').amount).toBe(122n);
    expect(rescale(usdc(1_225_001n), 2, 'half-even').amount).toBe(123n);
    expect(rescale(usdc(1_224_999n), 2, 'half-up').amount).toBe(122n);
    expect(rescale(usdc(1_225_000n), 2, 'half-up').amount).toBe(123n);
    expect(rescale(usdc(1_235_000n), 2, 'half-even').amount).toBe(124n);
    expect(rescale(usdc(1_230_001n), 2, 'ceil').amount).toBe(124n);
    expect(rescale(usdc(-1_230_001n), 2, 'floor').amount).toBe(-124n);
    expect(rescale(usdc(1_234_567n), 2, 'trunc').amount).toBe(123n);
  });

  it('drops 16 digits at the extremes, from scale 18 to cents', () => {
    const e16 = 10n ** 16n;
    expect(rescale(usd(MAX, 18), 2, 'floor').amount).toBe(MAX / e16);
    expect(rescale(usd(MAX, 18), 2, 'ceil').amount).toBe(MAX / e16 + 1n);
    expect(rescale(usd(MIN, 18), 2, 'trunc').amount).toBe(MIN / e16);
    expect(rescale(usd(MIN, 18), 2, 'floor').amount).toBe(MIN / e16 - 1n);
    expect(rescale(usd(5n * 10n ** 15n, 18), 2, 'half-even').amount).toBe(0n);
    expect(rescale(usd(15n * 10n ** 15n, 18), 2, 'half-even').amount).toBe(2n);
    expect(rescale(usd(-5n * 10n ** 15n, 18), 2, 'half-up').amount).toBe(-1n);
  });

  it('an exact downscale gives the same result in every mode', () => {
    for (const mode of MODES) {
      expect(rescale(usd(123_400n, 4), 2, mode)).toEqual(usd(1234n, 2));
      expect(rescale(usd(-123_400n, 4), 2, mode)).toEqual(usd(-1234n, 2));
    }
  });
});

describe('rescale up and same scale', () => {
  it('scales up exactly in every mode', () => {
    for (const mode of MODES) {
      expect(rescale(usd(123n, 2), 6, mode)).toEqual(usd(1_230_000n, 6));
      expect(rescale(usd(-1n, 2), 18, mode)).toEqual(usd(-(10n ** 16n), 18));
    }
  });

  it('returns an equal frozen value at the same scale', () => {
    const r = rescale(usd(MAX, 2), 2, 'trunc');
    expect(r).toEqual(usd(MAX, 2));
    expect(Object.isFrozen(r)).toBe(true);
  });

  it('throws MoneyOverflowError when scaling up leaves i128', () => {
    expectMoneyError(() => rescale(usd(MAX, 2), 3, 'half-even'), MoneyOverflowError);
    expectMoneyError(() => rescale(usd(MIN, 2), 3, 'half-even'), MoneyOverflowError);
    expectMoneyError(() => rescale(usd(10n ** 23n, 2), 18, 'floor'), MoneyOverflowError);
    expect(rescale(usd(MAX / 10n, 2), 3, 'floor').amount).toBe((MAX / 10n) * 10n);
    expect(rescale(usd(MIN / 10n, 2), 3, 'floor').amount).toBe((MIN / 10n) * 10n);
  });

  it('keeps the currency', () => {
    expect(rescale(moneyAt(1_234_567n, 'NGN', 6), 2, 'trunc')).toEqual(money(123n, 'NGN'));
    expect(rescale(money(5n, 'KES'), 9, 'half-up')).toEqual(moneyAt(50_000_000n, 'KES', 9));
  });

  it('never goes coarser than the minor unit', () => {
    for (const scale of [0, 1]) {
      expectMoneyError(() => rescale(money(5n, 'NGN'), scale, 'half-up'), InvalidScaleError);
    }
  });

  it('refuses a token amount, whose scale never changes', () => {
    expectMoneyError(
      () => rescale(loose(tokenAmount(1_234_567n, 'USDC', 'stellar')), 7, 'trunc'),
      KindMismatchError,
    );
  });
});

describe('toMinor', () => {
  it('rounds a working scale value to the minor unit with the given mode', () => {
    expect(toMinor(usd(1005n, 3), 'half-even')).toEqual(money(100n, 'USD'));
    expect(toMinor(usd(1005n, 3), 'half-up')).toEqual(money(101n, 'USD'));
    expect(toMinor(moneyAt(-1_234_567n, 'NGN', 6), 'floor')).toEqual(money(-124n, 'NGN'));
    expect(toMinor(money(42n, 'GBP'), 'trunc')).toEqual(money(42n, 'GBP'));
  });

  it('requires a rounding mode and refuses tokens', () => {
    expectMoneyError(() => toMinor(usd(1n, 6), loose(undefined)), InvalidRoundingModeError);
    expectMoneyError(
      () => toMinor(loose(tokenAmount(1n, 'USDC', 'stellar')), 'trunc'),
      KindMismatchError,
    );
  });
});

describe('rescale rejects bad input', () => {
  it('requires a rounding mode on every call, even when scaling up', () => {
    const bad: unknown[] = [
      undefined,
      null,
      '',
      'HALF_EVEN',
      'halfEven',
      'half_even',
      'round',
      'ceiling',
      'down',
      'up',
      'Half-Even',
      'half-even ',
      Object('half-even'),
      { mode: 'half-even' },
      0,
    ];
    for (const rounding of bad) {
      expectMoneyError(() => rescale(usd(1005n, 3), 2, loose(rounding)), InvalidRoundingModeError);
      expectMoneyError(() => rescale(usd(1n, 2), 6, loose(rounding)), InvalidRoundingModeError);
      expectMoneyError(() => rescale(usd(1n, 2), 2, loose(rounding)), InvalidRoundingModeError);
    }
  });

  it('never calls toString on a rounding mode', () => {
    const calls: string[] = [];
    const hostile = {
      toString() {
        calls.push('toString');
        return 'half-even';
      },
      [Symbol.toPrimitive]() {
        calls.push('toPrimitive');
        return 'half-even';
      },
    };
    const err = expectMoneyError(
      () => rescale(usd(1n, 2), 3, loose(hostile)),
      InvalidRoundingModeError,
    );
    expect(err.message.length).toBeLessThanOrEqual(200);
    expect(err.message).not.toMatch(/[\r\n]/);
    expect(calls).toEqual([]);
  });

  it('rejects a bad target scale before the rounding mode', () => {
    for (const scale of [-1, 0, 1, 19, 2.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expectMoneyError(() => rescale(usd(1n, 2), scale, 'trunc'), InvalidScaleError);
      expectMoneyError(() => rescale(usd(1n, 2), scale, loose('bogus')), InvalidScaleError);
    }
    expectMoneyError(() => rescale(usd(1n, 2), loose('2'), 'trunc'), InvalidScaleError);
    expectMoneyError(() => rescale(usd(1n, 2), loose(2n), 'trunc'), InvalidScaleError);
  });

  const forged: [string, unknown, ErrorClass][] = [
    ['null', null, InvalidAmountError],
    [
      'a string amount',
      { kind: 'fiat', amount: '1', currency: 'USD', scale: 2 },
      InvalidAmountError,
    ],
    [
      'an unknown currency',
      { kind: 'fiat', amount: 1n, currency: 'BTC', scale: 2 },
      UnknownCurrencyError,
    ],
    ['a scale of 19', { kind: 'fiat', amount: 1n, currency: 'USD', scale: 19 }, InvalidScaleError],
    [
      'an out of range amount',
      { kind: 'fiat', amount: MIN - 1n, currency: 'USD', scale: 2 },
      MoneyOverflowError,
    ],
  ];

  it.each(forged)(
    'rejects a forged operand with %s before anything else',
    (_l, value, Expected) => {
      expectMoneyError(() => rescale(loose(value), 2, 'trunc'), Expected);
      expectMoneyError(() => rescale(loose(value), 99, loose('bogus')), Expected);
    },
  );

  it('reads each operand field once and computes from the snapshot', () => {
    const reads = { kind: 0, amount: 0, currency: 0, scale: 0 };
    const answers = {
      kind: 'fiat',
      amount: [1005n, 2n ** 200n],
      currency: ['USD', 'NGN'],
      scale: [3, 18],
    };
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
            const list: unknown[] = answers[key];
            return list[Math.min(reads[key], list.length) - 1];
          }
          return undefined;
        },
      },
    );
    expect(rescale(loose(value), 2, 'half-up')).toEqual(usd(101n, 2));
    expect(reads.amount).toBeLessThanOrEqual(1);
    expect(reads.currency).toBeLessThanOrEqual(1);
    expect(reads.scale).toBeLessThanOrEqual(1);
  });

  it('never mutates its input', () => {
    const input = usd(1005n, 3);
    rescale(input, 2, 'half-even');
    expect(input).toEqual(usd(1005n, 3));
  });
});
