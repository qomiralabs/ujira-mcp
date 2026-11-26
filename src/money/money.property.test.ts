// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The API contract for this module is documented at the top of money.test.ts.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  CurrencyMismatchError,
  KindMismatchError,
  MoneyError,
  MoneyOverflowError,
  SETTLEMENT_TOKENS,
  ScaleMismatchError,
  TokenMismatchError,
  add,
  compare,
  equals,
  isNegative,
  isZero,
  moneyAt,
  multiply,
  negate,
  subtract,
  sum,
  tokenAmount,
} from './index.js';
import type { Chain, FiatCurrencyCode, Money, TokenAsset } from './index.js';

const MAX = 2n ** 127n - 1n;
const MIN = -(2n ** 127n);

// Fixed seed so a failure reproduces on every machine. Bump numRuns locally to
// search harder, never lower it to make a run pass.
const RUNS = { seed: 0x75a17a, numRuns: 1000 } as const;
// 1000 runs take under a second on an idle machine and several times that on a
// loaded runner, so the default 5 second timeout fails them at random. 30
// seconds covers a heavily loaded runner and still catches a real hang.
const PROPERTY_TIMEOUT_MS = 30_000;

const CODES: FiatCurrencyCode[] = [
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

const inRange = (x: bigint): boolean => x >= MIN && x <= MAX;

// Uniform over the full i128 range plus heavy weight at the edges and near
// zero, where off by one bugs live.
const i128 = fc.oneof(
  fc.bigInt({ min: MIN, max: MAX }),
  fc.bigInt({ min: MAX - 1000n, max: MAX }),
  fc.bigInt({ min: MIN, max: MIN + 1000n }),
  fc.bigInt({ min: -1000n, max: 1000n }),
  fc.constantFrom(MIN, MIN + 1n, -1n, 0n, 1n, MAX - 1n, MAX),
);

// Values small enough that any three of them add without overflow.
const third = fc.bigInt({ min: MIN / 3n, max: MAX / 3n });

// Factors from tiny to far beyond i128, so products land on both sides.
const factor = fc.oneof(
  fc.bigInt({ min: -1000n, max: 1000n }),
  fc.bigInt({ min: -(2n ** 130n), max: 2n ** 130n }),
  fc.constantFrom(-2n, -1n, 0n, 1n, 2n, MAX, MIN, MAX + 1n, MIN - 1n),
);

// Anything, including values just outside i128.
const anyBig = fc.oneof(
  i128,
  fc.bigInt({ min: MAX + 1n, max: MAX + 1000n }),
  fc.bigInt({ min: MIN - 1000n, max: MIN - 1n }),
  fc.bigInt({ min: -(2n ** 200n), max: 2n ** 200n }),
);

// A unit is fiat at a scale from its minor unit (2) to 18, or a token on a
// chain at that token's decimals. Properties run over both kinds.
type Unit =
  | { kind: 'fiat'; currency: FiatCurrencyCode; scale: number }
  | { kind: 'token'; asset: TokenAsset; chain: Chain; scale: number };

const fiatUnit = fc.record({
  kind: fc.constant('fiat' as const),
  currency: fc.constantFrom(...CODES),
  scale: fc.integer({ min: 2, max: 18 }),
});
const tokenUnit = fc
  .constantFrom(...SETTLEMENT_TOKENS)
  .map((t) => ({ kind: 'token' as const, asset: t.asset, chain: t.chain, scale: t.tokenScale }));
const unit: fc.Arbitrary<Unit> = fc.oneof(fiatUnit, fiatUnit, tokenUnit);

// The overloads take one kind at a time; these properties hand either kind
// through the Money overload on purpose, so the runtime checks are tested.
const m = (amount: bigint | string, u: Unit): Money =>
  u.kind === 'fiat'
    ? moneyAt(amount, u.currency, u.scale)
    : (tokenAmount(amount, u.asset, u.chain) as unknown as Money);

/** The plain object a value of `u` holding `amount` must equal. */
const shape = (u: Unit, amount: bigint): Record<string, unknown> => ({ ...u, amount });

const sameUnit = (a: Unit, b: Unit): boolean =>
  JSON.stringify(shape(a, 0n), (_k, v: unknown) => (typeof v === 'bigint' ? 0 : v)) ===
  JSON.stringify(shape(b, 0n), (_k, v: unknown) => (typeof v === 'bigint' ? 0 : v));

/** The error a binary operation on values of `a` and `b` must throw. */
function mismatchFor(a: Unit, b: Unit): new (message?: string) => MoneyError {
  if (a.kind !== b.kind) return KindMismatchError;
  if (a.kind === 'token' || b.kind === 'token') return TokenMismatchError;
  return a.currency !== b.currency ? CurrencyMismatchError : ScaleMismatchError;
}

function outcome(run: () => Money): { ok: true; value: Money } | { ok: false; error: unknown } {
  try {
    return { ok: true, value: run() };
  } catch (error) {
    return { ok: false, error };
  }
}

describe('money properties', { timeout: PROPERTY_TIMEOUT_MS }, () => {
  it('construction accepts exactly the i128 range', () => {
    fc.assert(
      fc.property(anyBig, unit, (x, u) => {
        const r = outcome(() => m(x, u));
        if (inRange(x)) {
          expect(r.ok).toBe(true);
          if (r.ok) expect(r.value.amount).toBe(x);
        } else {
          expect(r.ok).toBe(false);
          if (!r.ok) expect(r.error).toBeInstanceOf(MoneyOverflowError);
        }
      }),
      RUNS,
    );
  });

  it('string and bigint construction round trip', () => {
    fc.assert(
      fc.property(i128, unit, (x, u) => {
        const fromBig = m(x, u);
        const fromString = m(x.toString(), u);
        expect(fromString).toEqual(fromBig);
        expect(fromBig.amount.toString()).toBe(x.toString());
        expect(m(fromBig.amount.toString(), u)).toEqual(fromBig);
      }),
      RUNS,
    );
  });

  it('add and multiply throw MoneyOverflowError exactly when the true result leaves the i128 range', () => {
    fc.assert(
      fc.property(i128, i128, factor, unit, (a, b, k, u) => {
        const added = outcome(() => add(m(a, u), m(b, u)));
        if (inRange(a + b)) {
          expect(added.ok).toBe(true);
          if (added.ok) expect(added.value).toEqual(m(a + b, u));
        } else {
          expect(added.ok).toBe(false);
          if (!added.ok) expect(added.error).toBeInstanceOf(MoneyOverflowError);
        }

        const multiplied = outcome(() => multiply(m(a, u), k));
        if (inRange(a * k)) {
          expect(multiplied.ok).toBe(true);
          if (multiplied.ok) expect(multiplied.value).toEqual(m(a * k, u));
        } else {
          expect(multiplied.ok).toBe(false);
          if (!multiplied.ok) expect(multiplied.error).toBeInstanceOf(MoneyOverflowError);
        }
      }),
      RUNS,
    );
  });

  it('subtract and negate throw MoneyOverflowError exactly when the true result leaves the i128 range', () => {
    fc.assert(
      fc.property(i128, i128, unit, (a, b, u) => {
        const subtracted = outcome(() => subtract(m(a, u), m(b, u)));
        if (inRange(a - b)) {
          expect(subtracted.ok).toBe(true);
          if (subtracted.ok) expect(subtracted.value).toEqual(m(a - b, u));
        } else {
          expect(subtracted.ok).toBe(false);
          if (!subtracted.ok) expect(subtracted.error).toBeInstanceOf(MoneyOverflowError);
        }

        const negated = outcome(() => negate(m(a, u)));
        if (inRange(-a)) {
          expect(negated.ok).toBe(true);
          if (negated.ok) expect(negated.value).toEqual(m(-a, u));
        } else {
          expect(a).toBe(MIN);
          expect(negated.ok).toBe(false);
          if (!negated.ok) expect(negated.error).toBeInstanceOf(MoneyOverflowError);
        }
      }),
      RUNS,
    );
  });

  it('add is commutative', () => {
    fc.assert(
      fc.property(i128, i128, unit, (a, b, u) => {
        const ab = outcome(() => add(m(a, u), m(b, u)));
        const ba = outcome(() => add(m(b, u), m(a, u)));
        expect(ab.ok).toBe(ba.ok);
        if (ab.ok && ba.ok) expect(ab.value).toEqual(ba.value);
      }),
      RUNS,
    );
  });

  it('add is associative', () => {
    fc.assert(
      fc.property(third, third, third, unit, (a, b, c, u) => {
        const left = add(add(m(a, u), m(b, u)), m(c, u));
        const right = add(m(a, u), add(m(b, u), m(c, u)));
        expect(left).toEqual(right);
        expect(left.amount).toBe(a + b + c);
      }),
      RUNS,
    );
  });

  it('zero is the identity for add', () => {
    fc.assert(
      fc.property(i128, unit, (a, u) => {
        expect(add(m(a, u), m(0n, u))).toEqual(m(a, u));
        expect(subtract(m(a, u), m(0n, u))).toEqual(m(a, u));
      }),
      RUNS,
    );
  });

  it('add then subtract returns the original', () => {
    fc.assert(
      fc.property(i128, i128, unit, (a, b, u) => {
        fc.pre(inRange(a + b));
        expect(subtract(add(m(a, u), m(b, u)), m(b, u))).toEqual(m(a, u));
      }),
      RUNS,
    );
  });

  it('subtract equals add of the negation when both are defined', () => {
    fc.assert(
      fc.property(i128, i128, unit, (a, b, u) => {
        fc.pre(b !== MIN && inRange(a - b));
        expect(subtract(m(a, u), m(b, u))).toEqual(add(m(a, u), negate(m(b, u))));
      }),
      RUNS,
    );
  });

  it('negate is an involution away from I128_MIN', () => {
    fc.assert(
      fc.property(i128, unit, (a, u) => {
        fc.pre(a !== MIN);
        expect(negate(negate(m(a, u)))).toEqual(m(a, u));
      }),
      RUNS,
    );
  });

  it('multiply by one and by zero', () => {
    fc.assert(
      fc.property(i128, unit, (a, u) => {
        expect(multiply(m(a, u), 1n)).toEqual(m(a, u));
        expect(isZero(multiply(m(a, u), 0n))).toBe(true);
      }),
      RUNS,
    );
  });

  it('sum equals repeated add', () => {
    fc.assert(
      fc.property(fc.array(i128, { minLength: 1, maxLength: 12 }), unit, (xs, u) => {
        const items = xs.map((x) => m(x, u));
        const viaSum = outcome(() => sum(items));
        const viaAdd = outcome(() => items.reduce((acc, item) => add(acc, item)));
        expect(viaSum.ok).toBe(viaAdd.ok);
        if (viaSum.ok && viaAdd.ok) expect(viaSum.value).toEqual(viaAdd.value);
        if (!viaSum.ok) expect(viaSum.error).toBeInstanceOf(MoneyOverflowError);
      }),
      RUNS,
    );
  });

  it('sum of small values is the exact bigint total', () => {
    fc.assert(
      fc.property(
        fc.array(fc.bigInt({ min: -(2n ** 100n), max: 2n ** 100n }), {
          minLength: 1,
          maxLength: 50,
        }),
        unit,
        (xs, u) => {
          const total = xs.reduce((acc, x) => acc + x, 0n);
          expect(sum(xs.map((x) => m(x, u)))).toEqual(m(total, u));
        },
      ),
      RUNS,
    );
  });

  it('compare matches bigint ordering and equals matches compare', () => {
    fc.assert(
      fc.property(i128, i128, unit, (a, b, u) => {
        const c = compare(m(a, u), m(b, u));
        const expected = a < b ? -1 : a > b ? 1 : 0;
        expect(c).toBe(expected);
        expect(compare(m(b, u), m(a, u))).toBe(b < a ? -1 : b > a ? 1 : 0);
        expect(equals(m(a, u), m(b, u))).toBe(a === b);
        expect(isZero(m(a, u))).toBe(a === 0n);
        expect(isNegative(m(a, u))).toBe(a < 0n);
      }),
      RUNS,
    );
  });

  it('mixing kinds, currencies, scales, assets or chains always throws the matching error', () => {
    fc.assert(
      fc.property(i128, i128, unit, unit, (a, b, ua, ub) => {
        fc.pre(!sameUnit(ua, ub));
        const expected = mismatchFor(ua, ub);
        const x = m(a, ua);
        const y = m(b, ub);
        expect(() => add(x, y)).toThrow(expected);
        expect(() => subtract(x, y)).toThrow(expected);
        expect(() => compare(x, y)).toThrow(expected);
        expect(() => equals(x, y)).toThrow(expected);
        expect(() => sum([x, y])).toThrow(expected);
      }),
      RUNS,
    );
  });

  it('no operation ever yields a JS number amount or changes the unit', () => {
    const op = fc.constantFrom('add', 'subtract', 'multiply', 'negate', 'sum');
    fc.assert(
      fc.property(op, i128, i128, factor, unit, (name, a, b, k, u) => {
        const x = m(a, u);
        const y = m(b, u);
        const r = outcome(() => {
          switch (name) {
            case 'add':
              return add(x, y);
            case 'subtract':
              return subtract(x, y);
            case 'multiply':
              return multiply(x, k);
            case 'negate':
              return negate(x);
            case 'sum':
              return sum([x, y]);
          }
        });
        if (r.ok) {
          expect(typeof r.value.amount).toBe('bigint');
          expect(r.value).toEqual(shape(u, r.value.amount));
          expect(Object.isFrozen(r.value)).toBe(true);
          expect(inRange(r.value.amount)).toBe(true);
        } else {
          expect(r.error).toBeInstanceOf(MoneyError);
        }
        // Inputs never change.
        expect(x).toEqual(shape(u, a));
        expect(y).toEqual(shape(u, b));
      }),
      RUNS,
    );
  });

  it('every thrown error is a MoneyError with a string code', () => {
    fc.assert(
      fc.property(anyBig, factor, unit, (a, k, u) => {
        const attempts = [
          () => m(a, u),
          () => multiply(m(a > MAX || a < MIN ? 1n : a, u), k),
          () => negate(m(a > MAX || a < MIN ? 0n : a, u)),
        ];
        for (const attempt of attempts) {
          const r = outcome(attempt);
          if (!r.ok) {
            expect(r.error).toBeInstanceOf(MoneyError);
            expect(typeof (r.error as MoneyError).code).toBe('string');
          }
        }
      }),
      RUNS,
    );
  });
});
