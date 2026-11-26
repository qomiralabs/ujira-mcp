// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

/*
 * Operands that did not come from money(): plain objects, rows from a mapper,
 * objects with getters, null and holes. The contract block in money.test.ts
 * still applies. Added rules:
 *
 *   Every operation (add, subtract, multiply, negate, sum, compare, equals,
 *   isZero, isNegative) reads each of amount, currency and scale from each
 *   operand exactly once into a snapshot, validates the snapshot the same way
 *   money() does, and computes only from the snapshot:
 *     not a non null object          InvalidAmountError
 *     amount not a bigint            InvalidAmountError
 *     currency not a known code      UnknownCurrencyError
 *     scale not an integer 0..18     InvalidScaleError
 *     amount outside i128            MoneyOverflowError
 *   Binary operations validate the first operand, then the second, and only
 *   then compare currency and scale.
 *   sum rejects a non array, and every item (holes, null, undefined) is
 *   validated like an operand.
 *   Error messages never include operand text: they are at most 200
 *   characters, contain no line breaks, and never call toString, valueOf or
 *   Symbol.toPrimitive on an operand field.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  CurrencyMismatchError,
  InvalidAmountError,
  InvalidScaleError,
  MoneyError,
  KindMismatchError,
  MoneyOverflowError,
  ScaleMismatchError,
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
import type { FiatCurrencyCode, Money, TokenAmount } from './index.js';

const MAX = 2n ** 127n - 1n;
const MIN = -(2n ** 127n);
const RUNS = { seed: 0x0f0f6ed, numRuns: 1000 } as const;
// 1000 runs take under a second on an idle machine and several times that on a
// loaded runner, so the default 5 second timeout fails them at random. 30
// seconds covers a heavily loaded runner and still catches a real hang.
const PROPERTY_TIMEOUT_MS = 30_000;
const MAX_MESSAGE_LENGTH = 200;

const CODES: readonly string[] = [
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

const usd = (amount: bigint): Money => money(amount, 'USD');

// Hands the operations values the type system would refuse.
function forge(value: unknown): Money {
  return value as Money;
}

type ErrorClass = abstract new (message?: string) => MoneyError;

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
  expect(err).toBeInstanceOf(Expected);
  return err as MoneyError;
}

function expectValidMoney(value: Money): void {
  expect(Object.isFrozen(value)).toBe(true);
  expect(typeof value.amount).toBe('bigint');
  expect(value.amount >= MIN && value.amount <= MAX).toBe(true);
  expect(CODES.includes(value.currency)).toBe(true);
  expect(Number.isSafeInteger(value.scale)).toBe(true);
  expect(value.scale >= 2 && value.scale <= 18).toBe(true);
}

/**
 * An operand whose fields answer from a list, one entry per read, sticking on
 * the last entry. Reads are counted per field.
 */
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
  // The target owns every key, because a field only the get trap answers is
  // refused before it is read.
  const value = new Proxy(
    { kind: undefined, amount: undefined, currency: undefined, scale: undefined },
    {
      get(_target, key) {
        // Every operand says it is fiat; only the other fields vary per read.
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
  return { value: forge(value), reads };
}

const expectReadOnce = (reads: Record<string, number>): void => {
  expect(reads['kind'] ?? 0).toBeLessThanOrEqual(1);
  expect(reads['amount']).toBeLessThanOrEqual(1);
  expect(reads['currency']).toBeLessThanOrEqual(1);
  expect(reads['scale']).toBeLessThanOrEqual(1);
};

describe('forged operands with bad fields (HIGH 1)', () => {
  it('add rejects an unknown currency with a fractional scale', () => {
    const forged = forge({ kind: 'fiat', amount: 5n, currency: 'BTC', scale: 1.5 });
    expectMoneyError(() => add(forged, forged), UnknownCurrencyError);
  });

  it('add rejects a fractional scale on a known currency', () => {
    const forged = forge({ kind: 'fiat', amount: 5n, currency: 'USD', scale: 1.5 });
    expectMoneyError(() => add(forged, usd(1n)), InvalidScaleError);
    expectMoneyError(() => add(usd(1n), forged), InvalidScaleError);
  });

  it('equals rejects a string scale even when both sides match', () => {
    const forged = forge({ kind: 'fiat', amount: 5n, currency: 'USD', scale: '2' });
    expectMoneyError(() => equals(forged, forged), InvalidScaleError);
  });

  it('compare rejects an operand outside i128', () => {
    const huge = forge({ kind: 'fiat', amount: 2n ** 200n, currency: 'USD', scale: 2 });
    expectMoneyError(() => compare(huge, usd(1n)), MoneyOverflowError);
    expectMoneyError(() => compare(usd(1n), huge), MoneyOverflowError);
    expectMoneyError(
      () => compare(forge({ kind: 'fiat', amount: MAX + 1n, currency: 'USD', scale: 2 }), usd(1n)),
      MoneyOverflowError,
    );
    expectMoneyError(
      () => compare(forge({ kind: 'fiat', amount: MIN - 1n, currency: 'USD', scale: 2 }), usd(1n)),
      MoneyOverflowError,
    );
  });

  it('isZero rejects an unknown currency and a negative scale', () => {
    expectMoneyError(
      () => isZero(forge({ kind: 'fiat', amount: 0n, currency: 'NOPE', scale: -7 })),
      UnknownCurrencyError,
    );
    expectMoneyError(
      () => isZero(forge({ kind: 'fiat', amount: 0n, currency: 'USD', scale: -7 })),
      InvalidScaleError,
    );
  });

  it('isNegative rejects an operand outside i128', () => {
    expectMoneyError(
      () => isNegative(forge({ kind: 'fiat', amount: -(2n ** 200n), currency: 'USD', scale: 2 })),
      MoneyOverflowError,
    );
  });

  const unknownCurrency = forge({ kind: 'fiat', amount: 1n, currency: 'BTC', scale: 2 });
  const badScale = forge({ kind: 'fiat', amount: 1n, currency: 'USD', scale: 19 });
  const outOfRange = forge({ kind: 'fiat', amount: MAX + 1n, currency: 'USD', scale: 2 });

  const unaryOps: [string, (m: Money) => unknown][] = [
    ['multiply', (m) => multiply(m, 1n)],
    ['negate', (m) => negate(m)],
    ['sum of one', (m) => sum([m])],
    ['isZero', (m) => isZero(m)],
    ['isNegative', (m) => isNegative(m)],
  ];
  const binaryOps: [string, (a: Money, b: Money) => unknown][] = [
    ['add', add],
    ['subtract', subtract],
    ['compare', compare],
    ['equals', equals],
    ['sum of two', (a, b) => sum([a, b])],
  ];

  describe.each(unaryOps)('%s', (_name, op) => {
    it('rejects an unknown currency, a bad scale and an out of range amount', () => {
      expectMoneyError(() => op(unknownCurrency), UnknownCurrencyError);
      expectMoneyError(() => op(badScale), InvalidScaleError);
      expectMoneyError(() => op(outOfRange), MoneyOverflowError);
    });
  });

  describe.each(binaryOps)('%s', (_name, op) => {
    it('rejects an unknown currency, a bad scale and an out of range amount on either side', () => {
      for (const [forged, Expected] of [
        [unknownCurrency, UnknownCurrencyError],
        [badScale, InvalidScaleError],
        [outOfRange, MoneyOverflowError],
      ] as const) {
        expectMoneyError(() => op(forged, usd(1n)), Expected);
        expectMoneyError(() => op(usd(1n), forged), Expected);
      }
    });

    it('validates both operands before comparing units', () => {
      // A mismatch error would otherwise be raised from unvalidated text.
      expectMoneyError(() => op(money(1n, 'NGN'), unknownCurrency), UnknownCurrencyError);
      expectMoneyError(
        () =>
          op(
            moneyAt(1n, 'USD', 6),
            forge({ kind: 'fiat', amount: 1n, currency: 'USD', scale: 6.5 }),
          ),
        InvalidScaleError,
      );
    });
  });

  it('accepts a well formed plain object, as a row mapper would produce', () => {
    const row = forge({ kind: 'fiat', amount: 250n, currency: 'KES', scale: 2 });
    const r = add(row, money(50n, 'KES'));
    expect(r).toEqual(money(300n, 'KES'));
    expectValidMoney(r);
  });

  it('never mints a result from a forged operand that carries extra fields', () => {
    const row = forge({ kind: 'fiat', amount: 1n, currency: 'USD', scale: 2, chain: 'stellar' });
    const r = negate(row);
    expect(Object.keys(r).sort()).toEqual(['amount', 'currency', 'kind', 'scale']);
  });
});

describe('operands whose fields change between reads (HIGH 1)', () => {
  it('add never relabels USD as NGN', () => {
    const flip = sequenced({ kind: 'fiat', amount: [100n], currency: ['USD', 'NGN'], scale: [2] });
    const err = thrown(() => {
      const r = add(flip.value, usd(1n));
      expect(r).toEqual(usd(101n));
    });
    if (err !== undefined) expect(err).toBeInstanceOf(MoneyError);
    expectReadOnce(flip.reads);
  });

  it('add never relabels USD as NGN when the flipping operand is second', () => {
    const flip = sequenced({ kind: 'fiat', amount: [100n], currency: ['USD', 'NGN'], scale: [2] });
    const err = thrown(() => {
      const r = add(usd(1n), flip.value);
      expect(r).toEqual(usd(101n));
    });
    if (err !== undefined) expect(err).toBeInstanceOf(MoneyError);
    expectReadOnce(flip.reads);
  });

  it('add never moves USD from scale 6 to 18', () => {
    const flip = sequenced({ kind: 'fiat', amount: [100n], currency: ['USD'], scale: [6, 18] });
    const err = thrown(() => {
      const r = add(flip.value, moneyAt(1n, 'USD', 6));
      expect(r).toEqual(moneyAt(101n, 'USD', 6));
    });
    if (err !== undefined) expect(err).toBeInstanceOf(MoneyError);
    expectReadOnce(flip.reads);
  });

  it('subtract never moves USD from scale 6 to 18', () => {
    const flip = sequenced({ kind: 'fiat', amount: [100n], currency: ['USD'], scale: [6, 18] });
    const err = thrown(() => {
      const r = subtract(flip.value, moneyAt(1n, 'USD', 6));
      expect(r).toEqual(moneyAt(99n, 'USD', 6));
    });
    if (err !== undefined) expect(err).toBeInstanceOf(MoneyError);
    expectReadOnce(flip.reads);
  });

  it('negate never relabels to an unknown currency', () => {
    const flip = sequenced({ kind: 'fiat', amount: [7n], currency: ['USD', 'BTC'], scale: [2] });
    const err = thrown(() => {
      const r = negate(flip.value);
      expect(r).toEqual(usd(-7n));
    });
    if (err !== undefined) expect(err).toBeInstanceOf(MoneyError);
    expectReadOnce(flip.reads);
  });

  it('multiply never carries a scale that changed after validation', () => {
    const flip = sequenced({ kind: 'fiat', amount: [7n], currency: ['USD'], scale: [2, 1.5] });
    const err = thrown(() => {
      const r = multiply(flip.value, 3n);
      expect(r).toEqual(usd(21n));
    });
    if (err !== undefined) expect(err).toBeInstanceOf(MoneyError);
    expectReadOnce(flip.reads);
  });

  it('multiply never uses an amount that changed after validation', () => {
    const flip = sequenced({
      kind: 'fiat',
      amount: [7n, 2n ** 200n],
      currency: ['USD'],
      scale: [2],
    });
    const err = thrown(() => {
      const r = multiply(flip.value, 1n);
      expect(r).toEqual(usd(7n));
    });
    if (err !== undefined) expect(err).toBeInstanceOf(MoneyError);
    expectReadOnce(flip.reads);
  });

  it('sum never relabels its seed or any item', () => {
    const first = sequenced({
      kind: 'fiat',
      amount: [1n],
      currency: ['USD', 'NGN'],
      scale: [2, 6],
    });
    const later = sequenced({
      kind: 'fiat',
      amount: [2n],
      currency: ['USD', 'NGN'],
      scale: [2, 6],
    });
    const err = thrown(() => {
      const r = sum([first.value, usd(10n), later.value]);
      expect(r).toEqual(usd(13n));
    });
    if (err !== undefined) expect(err).toBeInstanceOf(MoneyError);
    expectReadOnce(first.reads);
    expectReadOnce(later.reads);
  });

  it('compare never answers across a currency that flipped to match', () => {
    // Snapshot is USD against NGN, so the only consistent outcome is a throw.
    const flip = sequenced({ kind: 'fiat', amount: [1n], currency: ['USD', 'NGN'], scale: [2] });
    expectMoneyError(() => compare(flip.value, money(1n, 'NGN')), MoneyError);
    expectReadOnce(flip.reads);
  });

  it('equals never answers across a scale that flipped to match', () => {
    const flip = sequenced({ kind: 'fiat', amount: [1n], currency: ['USD'], scale: [6, 7] });
    expectMoneyError(() => equals(flip.value, moneyAt(1n, 'USD', 7)), MoneyError);
    expectReadOnce(flip.reads);
  });

  it('isZero and isNegative read the amount once', () => {
    const zero = sequenced({ kind: 'fiat', amount: [0n, 5n], currency: ['USD'], scale: [2] });
    expect(isZero(zero.value)).toBe(true);
    expectReadOnce(zero.reads);
    const neg = sequenced({ kind: 'fiat', amount: [-1n, 1n], currency: ['USD'], scale: [2] });
    expect(isNegative(neg.value)).toBe(true);
    expectReadOnce(neg.reads);
  });

  it('every operation reads each field of each operand at most once', () => {
    const ops: ((a: Money, b: Money) => unknown)[] = [
      add,
      subtract,
      compare,
      equals,
      (a, b) => sum([a, b]),
      (a) => multiply(a, 2n),
      (a) => negate(a),
      (a) => isZero(a),
      (a) => isNegative(a),
    ];
    for (const op of ops) {
      const a = sequenced({ kind: 'fiat', amount: [3n], currency: ['USD'], scale: [2] });
      const b = sequenced({ kind: 'fiat', amount: [4n], currency: ['USD'], scale: [2] });
      op(a.value, b.value);
      expectReadOnce(a.reads);
      expectReadOnce(b.reads);
    }
  });
});

describe('forged operand property (HIGH 1)', { timeout: PROPERTY_TIMEOUT_MS }, () => {
  const amountArb = fc.oneof(
    fc.bigInt({ min: MIN, max: MAX }),
    fc.constantFrom(MIN, MAX, 0n, -1n, 1n, MAX + 1n, MIN - 1n, 2n ** 200n),
    fc.constantFrom<unknown>(1, 0, 1.5, '1', null, undefined, Object(1n)),
  );
  const currencyArb = fc.oneof(
    fc.constantFrom(...CODES),
    fc.string({ maxLength: 6 }),
    fc.constantFrom<unknown>('usd', 'BTC', '__proto__', 'USD\n', 'USD ', 840, null, undefined),
  );
  const scaleArb = fc.oneof(
    fc.integer({ min: 0, max: 18 }),
    fc.integer({ min: -5, max: 40 }),
    fc.constantFrom<unknown>(1.5, Number.NaN, Number.POSITIVE_INFINITY, -0, '2', 2n, null),
  );
  const forgedArb = fc.record({
    kind: fc.constant('fiat' as const),
    amount: amountArb,
    currency: currencyArb,
    scale: scaleArb,
  });

  // Every launch currency has two minor digits, so a fiat scale runs 2 to 18.
  const isScale = (s: unknown): s is number =>
    typeof s === 'number' && Number.isSafeInteger(s) && s >= 2 && s <= 18;

  function expectedError(f: {
    kind: 'fiat';
    amount: unknown;
    currency: unknown;
    scale: unknown;
  }): ErrorClass | null {
    if (typeof f.amount !== 'bigint') return InvalidAmountError;
    if (typeof f.currency !== 'string' || !CODES.includes(f.currency)) return UnknownCurrencyError;
    if (!isScale(f.scale)) return InvalidScaleError;
    if (f.amount < MIN || f.amount > MAX) return MoneyOverflowError;
    return null;
  }

  it('every operation either throws the matching MoneyError or returns a valid result', () => {
    fc.assert(
      fc.property(forgedArb, fc.bigInt({ min: -3n, max: 3n }), (f, k) => {
        const forged = forge({ ...f });
        const Expected = expectedError(f);
        const partner =
          Expected === null
            ? moneyAt(1n, f.currency as FiatCurrencyCode, f.scale as number)
            : usd(1n);
        const runs: (() => unknown)[] = [
          () => add(forged, partner),
          () => add(partner, forged),
          () => subtract(forged, partner),
          () => subtract(partner, forged),
          () => multiply(forged, k),
          () => negate(forged),
          () => sum([forged]),
          () => sum([partner, forged]),
          () => compare(forged, partner),
          () => equals(partner, forged),
          () => isZero(forged),
          () => isNegative(forged),
        ];
        for (const run of runs) {
          const err = thrown(() => {
            const r = run();
            if (typeof r === 'object' && r !== null) expectValidMoney(r as Money);
          });
          if (Expected !== null) {
            expect(err).toBeInstanceOf(Expected);
          } else if (err !== undefined) {
            // Only overflow from the arithmetic itself is allowed on valid input.
            expect(err).toBeInstanceOf(MoneyOverflowError);
          }
        }
      }),
      RUNS,
    );
  });
});

describe('error messages from hostile operands (LOW 3)', () => {
  function expectSafeMessage(err: MoneyError): void {
    expect(err.message.length).toBeLessThanOrEqual(MAX_MESSAGE_LENGTH);
    expect(err.message).not.toMatch(/[\r\n\u2028\u2029]/);
  }

  const ops: [string, (a: Money, b: Money) => unknown][] = [
    ['add', add],
    ['subtract', subtract],
    ['compare', compare],
    ['equals', equals],
    ['sum', (a, b) => sum([a, b])],
  ];

  describe.each(ops)('%s', (_name, op) => {
    it('rejects a currency with a newline without echoing it', () => {
      const forged = forge({
        kind: 'fiat',
        amount: 1n,
        currency: 'USD\nlevel=info msg=paid',
        scale: 2,
      });
      for (const run of [() => op(forged, usd(1n)), () => op(usd(1n), forged)]) {
        const err = expectMoneyError(run, MoneyError);
        expectSafeMessage(err);
        expect(err.message).not.toContain('msg=paid');
      }
    });

    it('rejects a one megabyte currency with a bounded message', () => {
      const forged = forge({ kind: 'fiat', amount: 1n, currency: 'U'.repeat(1_000_000), scale: 2 });
      expectSafeMessage(expectMoneyError(() => op(usd(1n), forged), MoneyError));
    });

    it('rejects a Symbol currency with a MoneyError, not a TypeError', () => {
      const forged = forge({ kind: 'fiat', amount: 1n, currency: Symbol('USD'), scale: 2 });
      expectSafeMessage(expectMoneyError(() => op(forged, usd(1n)), UnknownCurrencyError));
      expectSafeMessage(expectMoneyError(() => op(usd(1n), forged), UnknownCurrencyError));
    });

    it('never calls toString, valueOf or Symbol.toPrimitive on a currency or scale', () => {
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
      expectMoneyError(
        () => op(forge({ kind: 'fiat', amount: 1n, currency: hostile, scale: 2 }), usd(1n)),
        UnknownCurrencyError,
      );
      expectMoneyError(
        () => op(usd(1n), forge({ kind: 'fiat', amount: 1n, currency: 'USD', scale: hostile })),
        InvalidScaleError,
      );
      expect(calls).toEqual([]);
    });
  });

  it('keeps genuine mismatch messages bounded and on one line', () => {
    expectSafeMessage(
      expectMoneyError(() => add(usd(1n), money(1n, 'NGN')), CurrencyMismatchError),
    );
    expectSafeMessage(
      expectMoneyError(() => add(usd(1n), moneyAt(1n, 'USD', 7)), ScaleMismatchError),
    );
  });

  it('keeps factory messages free of the rejected input', () => {
    const err = expectMoneyError(() => money(1n, 'USD\nlevel=info' as never), UnknownCurrencyError);
    expectSafeMessage(err);
    const amountErr = expectMoneyError(() => money('1\nlevel=info', 'USD'), InvalidAmountError);
    expectSafeMessage(amountErr);
    expect(amountErr.message).not.toContain('level=info');
  });
});

describe('null, undefined and holes (LOW 4)', () => {
  const m = usd(1n);
  const nothing = [null, undefined] as const;

  it('sum rejects a hole in the list', () => {
    const holey = new Array<Money>(3);
    holey[0] = m;
    holey[2] = m;
    expect(1 in holey).toBe(false);
    expectMoneyError(() => sum(holey), InvalidAmountError);
  });

  it('sum rejects null and undefined items in any position', () => {
    for (const bad of nothing) {
      expectMoneyError(() => sum([m, forge(bad)]), InvalidAmountError);
      expectMoneyError(() => sum([forge(bad), m]), InvalidAmountError);
      expectMoneyError(() => sum([forge(bad)]), InvalidAmountError);
      expectMoneyError(() => sum([m, m, forge(bad), m]), InvalidAmountError);
    }
  });

  it('sum rejects a list that is not an array', () => {
    for (const bad of [null, undefined, m, 'USD', 5n]) {
      expectMoneyError(() => sum(bad as unknown as Money[]), InvalidAmountError);
    }
  });

  it.each([
    ['add', (a: Money, b: Money) => add(a, b)],
    ['subtract', (a: Money, b: Money) => subtract(a, b)],
    ['compare', (a: Money, b: Money) => compare(a, b)],
    ['equals', (a: Money, b: Money) => equals(a, b)],
  ])('%s rejects null and undefined on either side', (_name, op) => {
    for (const bad of nothing) {
      expectMoneyError(() => op(forge(bad), m), InvalidAmountError);
      expectMoneyError(() => op(m, forge(bad)), InvalidAmountError);
      expectMoneyError(() => op(forge(bad), forge(bad)), InvalidAmountError);
    }
  });

  it.each([
    ['multiply', (a: Money) => multiply(a, 2n)],
    ['negate', (a: Money) => negate(a)],
    ['isZero', (a: Money) => isZero(a)],
    ['isNegative', (a: Money) => isNegative(a)],
  ])('%s rejects null, undefined and primitives', (_name, op) => {
    for (const bad of [null, undefined, 5n, 'USD', 1, true]) {
      expectMoneyError(() => op(forge(bad)), InvalidAmountError);
    }
  });
});

/** A token operand whose fields answer from a list, one entry per read. */
function sequencedToken(fields: {
  amount: unknown[];
  asset: unknown[];
  chain: unknown[];
  scale: unknown[];
}): { value: TokenAmount; reads: Record<string, number> } {
  const reads: Record<string, number> = { kind: 0, amount: 0, asset: 0, chain: 0, scale: 0 };
  // The target owns every key, because a field only the get trap answers is
  // refused before it is read.
  const value = new Proxy<object>(
    { kind: undefined, amount: undefined, asset: undefined, chain: undefined, scale: undefined },
    {
      get(_target, key) {
        if (key === 'kind') {
          reads['kind'] = (reads['kind'] ?? 0) + 1;
          return 'token';
        }
        if (key === 'amount' || key === 'asset' || key === 'chain' || key === 'scale') {
          const n = (reads[key] ?? 0) + 1;
          reads[key] = n;
          const list = fields[key];
          return list[Math.min(n, list.length) - 1];
        }
        return undefined;
      },
    },
  );
  return { value: value as TokenAmount, reads };
}

describe('forged token operands', () => {
  const usdc = (amount: bigint): TokenAmount => tokenAmount(amount, 'USDC', 'stellar');
  const forgeToken = (value: unknown): TokenAmount => value as TokenAmount;

  it('rejects a token row whose scale disagrees with the token table', () => {
    for (const scale of [6.5, 6, 18, 2, '7', null]) {
      const row = forgeToken({ kind: 'token', amount: 1n, asset: 'USDC', chain: 'stellar', scale });
      expectMoneyError(() => add(row, usdc(1n)), InvalidScaleError);
    }
  });

  it('rejects an unknown asset, chain or pair', () => {
    for (const [asset, chain] of [
      ['USDT', 'stellar'],
      ['USDC', 'ethereum'],
      ['usdc', 'stellar'],
      [null, 'stellar'],
      ['USDC', undefined],
    ] as const) {
      const row = forgeToken({ kind: 'token', amount: 1n, asset, chain, scale: 7 });
      expectMoneyError(() => negate(row), UnknownCurrencyError);
    }
  });

  it('reads the amount type before the pair and the pair before the scale', () => {
    expectMoneyError(
      () => isZero(forgeToken({ kind: 'token', amount: 1, asset: 'X', chain: 'Y', scale: 0 })),
      InvalidAmountError,
    );
    expectMoneyError(
      () => isZero(forgeToken({ kind: 'token', amount: 1n, asset: 'X', chain: 'Y', scale: 0 })),
      UnknownCurrencyError,
    );
  });

  it('rejects a token labelled as fiat and fiat labelled as a token', () => {
    expectMoneyError(
      () => add(forge({ kind: 'fiat', amount: 1n, currency: 'USDC', scale: 6 }), usd(1n)),
      UnknownCurrencyError,
    );
    expectMoneyError(
      () => add(forgeToken({ kind: 'token', amount: 1n, currency: 'USD', scale: 2 }), usdc(1n)),
      UnknownCurrencyError,
    );
  });

  it('never moves a token to another chain when the chain changes between reads', () => {
    const flip = sequencedToken({
      amount: [100n],
      asset: ['USDC'],
      chain: ['stellar', 'ethereum'],
      scale: [7, 6],
    });
    const err = thrown(() => {
      expect(add(flip.value, usdc(1n))).toEqual(usdc(101n));
    });
    if (err !== undefined) expect(err).toBeInstanceOf(MoneyError);
    for (const n of Object.values(flip.reads)) expect(n).toBeLessThanOrEqual(1);
  });

  it('every operation reads each token field at most once', () => {
    const ops: ((a: TokenAmount, b: TokenAmount) => unknown)[] = [
      add,
      subtract,
      compare,
      equals,
      (a, b) => sum([a, b]),
      (a) => multiply(a, 2n),
      (a) => negate(a),
      (a) => isZero(a),
      (a) => isNegative(a),
    ];
    for (const op of ops) {
      const fields = { amount: [3n], asset: ['USDC'], chain: ['stellar'], scale: [7] };
      const a = sequencedToken(fields);
      const b = sequencedToken(fields);
      op(a.value, b.value);
      for (const n of [...Object.values(a.reads), ...Object.values(b.reads)]) {
        expect(n).toBeLessThanOrEqual(1);
      }
    }
  });

  it('never combines a forged token with fiat', () => {
    const row = forgeToken({
      kind: 'token',
      amount: 1n,
      asset: 'USDC',
      chain: 'stellar',
      scale: 7,
    });
    expectMoneyError(() => add(usd(1n), row as unknown as Money), KindMismatchError);
  });
});
