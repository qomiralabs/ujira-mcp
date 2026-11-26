// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The API contract for allocate is documented at the top of allocate.test.ts.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { allocate } from './allocate.js';
import * as moneyIndex from './index.js';
import { MoneyOverflowError, SETTLEMENT_TOKENS, money, moneyAt, tokenAmount } from './index.js';
import type { Chain, FiatCurrencyCode, Money, MoneyError, TokenAsset } from './index.js';

const MAX = 2n ** 127n - 1n;
const MIN = -(2n ** 127n);
const MAX_LEGS = 16;
const MAX_WEIGHT = 10n ** 6n;

// Fixed seed so a failure reproduces on every machine. Bump numRuns locally to
// search harder, never lower it to make a run pass.
const RUNS = { seed: 0xa110c8, numRuns: 1000 } as const;
// 1000 runs take under a second on an idle machine and several times that on a
// loaded runner, so the default 5 second timeout fails them at random. 30
// seconds covers a heavily loaded runner and still catches a real hang.
const PROPERTY_TIMEOUT_MS = 30_000;

type ErrorClass = abstract new (message?: string) => MoneyError;
const InvalidAllocationError = (moneyIndex as Record<string, unknown>)[
  'InvalidAllocationError'
] as ErrorClass;

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

function thrown(run: () => unknown): unknown {
  try {
    run();
  } catch (err) {
    return err;
  }
  return undefined;
}

const maxOf = (xs: readonly bigint[]): bigint => xs.reduce((m, x) => (x > m ? x : m), 0n);
const sumOf = (xs: readonly bigint[]): bigint => xs.reduce((acc, x) => acc + x, 0n);

function at<T>(xs: readonly T[], i: number): T {
  const x = xs[i];
  if (x === undefined) throw new Error(`no element at ${String(i)}`);
  return x;
}

// Totals are fiat at a scale from the minor unit (2) to 18, or a token on a
// chain at its decimals, so every property covers both kinds of legs.
type Unit =
  | { kind: 'fiat'; currency: FiatCurrencyCode; scale: number }
  | { kind: 'token'; asset: TokenAsset; chain: Chain; scale: number };

const unitArb: fc.Arbitrary<Unit> = fc.oneof(
  fc.record({
    kind: fc.constant('fiat' as const),
    currency: fc.constantFrom(...CODES),
    scale: fc.integer({ min: 2, max: 18 }),
  }),
  fc
    .constantFrom(...SETTLEMENT_TOKENS)
    .map((t) => ({ kind: 'token' as const, asset: t.asset, chain: t.chain, scale: t.tokenScale })),
);

// allocate has one overload per kind; the Money one carries both here so a
// single property can run over fiat and token totals alike.
const make = (amount: bigint, unit: Unit): Money =>
  unit.kind === 'fiat'
    ? moneyAt(amount, unit.currency, unit.scale)
    : (tokenAmount(amount, unit.asset, unit.chain) as unknown as Money);

/** Every field of a value except the amount. */
const unitOf = (value: object): Record<string, unknown> =>
  Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'amount'));

const weightArb = fc.oneof(
  fc.bigInt({ min: 1n, max: MAX_WEIGHT }),
  fc.constantFrom(1n, 2n, 3n, MAX_WEIGHT - 1n, MAX_WEIGHT),
);

const weightsArb = fc.array(weightArb, { minLength: 1, maxLength: MAX_LEGS });

/**
 * Weights from 1 to 10^6 and 1 to 16 legs, with a total from zero up to the
 * largest value whose products past the first leg stay inside i128. With a
 * single leg that bound is I128_MAX itself, so the whole non negative range
 * is covered. Edge totals get extra weight.
 */
const caseArb = fc
  .tuple(weightsArb, unitArb)
  .chain(([weights, unit]) => {
    const rest = weights.slice(1);
    const bound = rest.length === 0 ? MAX : MAX / maxOf(rest);
    const totalArb = fc.oneof(
      fc.bigInt({ min: 0n, max: bound }),
      fc.bigInt({ min: 0n, max: 1000n < bound ? 1000n : bound }),
      fc.bigInt({ min: bound - (1000n < bound ? 1000n : bound), max: bound }),
      fc.constantFrom(0n, 1n < bound ? 1n : bound, bound),
    );
    return totalArb.map((amount) => ({ weights, unit, amount }));
  })
  .map(({ weights, unit, amount }) => ({
    weights,
    total: make(amount, unit),
  }));

describe('allocate properties', { timeout: PROPERTY_TIMEOUT_MS }, () => {
  it('sum of legs equals total for any total and weights', () => {
    fc.assert(
      fc.property(caseArb, ({ total, weights }) => {
        const legs = allocate(total, weights);
        expect(sumOf(legs.map((leg) => leg.amount))).toBe(total.amount);
      }),
      RUNS,
    );
  });

  it('leg count equals weight count', () => {
    fc.assert(
      fc.property(caseArb, ({ total, weights }) => {
        expect(allocate(total, weights)).toHaveLength(weights.length);
      }),
      RUNS,
    );
  });

  it('every leg after the first equals the floored proportional share', () => {
    fc.assert(
      fc.property(caseArb, ({ total, weights }) => {
        const legs = allocate(total, weights);
        const w = sumOf(weights);
        for (let i = 1; i < weights.length; i += 1) {
          expect(at(legs, i).amount).toBe((total.amount * at(weights, i)) / w);
        }
        const others = sumOf(legs.slice(1).map((leg) => leg.amount));
        expect(at(legs, 0).amount).toBe(total.amount - others);
      }),
      RUNS,
    );
  });

  it('every leg after the first is at or less than one unit below its exact share', () => {
    // Exact share of leg i is total * w_i / W. Compared scaled by W to stay in integers:
    // 0 <= total * w_i - leg_i * W < W.
    fc.assert(
      fc.property(caseArb, ({ total, weights }) => {
        const legs = allocate(total, weights);
        const w = sumOf(weights);
        for (let i = 1; i < weights.length; i += 1) {
          const gap = total.amount * at(weights, i) - at(legs, i).amount * w;
          expect(gap >= 0n).toBe(true);
          expect(gap < w).toBe(true);
        }
      }),
      RUNS,
    );
  });

  it('the first leg is at or above its exact share by less than one unit per other leg', () => {
    // 0 <= leg_0 * W - total * w_0 < (n - 1) * W, and exactly 0 for a single leg.
    fc.assert(
      fc.property(caseArb, ({ total, weights }) => {
        const legs = allocate(total, weights);
        const w = sumOf(weights);
        const excess = at(legs, 0).amount * w - total.amount * at(weights, 0);
        expect(excess >= 0n).toBe(true);
        if (weights.length === 1) {
          expect(excess).toBe(0n);
        } else {
          expect(excess < BigInt(weights.length - 1) * w).toBe(true);
        }
      }),
      RUNS,
    );
  });

  it('every leg is zero or positive', () => {
    fc.assert(
      fc.property(caseArb, ({ total, weights }) => {
        for (const leg of allocate(total, weights)) expect(leg.amount >= 0n).toBe(true);
      }),
      RUNS,
    );
  });

  it("every leg has the total's currency and scale, or asset and chain", () => {
    fc.assert(
      fc.property(caseArb, ({ total, weights }) => {
        for (const leg of allocate(total, weights)) {
          expect(unitOf(leg)).toEqual(unitOf(total));
          expect(Object.isFrozen(leg)).toBe(true);
          expect(Object.keys(leg).sort()).toEqual(Object.keys(total).sort());
          expect(typeof leg.amount).toBe('bigint');
        }
      }),
      RUNS,
    );
  });

  it('output is deterministic and never mutates the inputs', () => {
    fc.assert(
      fc.property(caseArb, ({ total, weights }) => {
        const before = [...weights];
        const first = allocate(total, weights);
        const second = allocate(total, [...weights]);
        const third = allocate({ ...total }, Object.freeze([...weights]));
        expect(second).toEqual(first);
        expect(third).toEqual(first);
        expect(weights).toEqual(before);
      }),
      RUNS,
    );
  });

  it('scaling every weight by the same factor leaves the legs unchanged', () => {
    const scaledArb = fc
      .tuple(weightsArb, fc.bigInt({ min: 1n, max: 1000n }))
      .chain(([weights, k]) => {
        const rest = weights.slice(1);
        const bound = rest.length === 0 ? MAX : MAX / (maxOf(rest) * k);
        return fc.bigInt({ min: 0n, max: bound }).map((amount) => ({ weights, k, amount }));
      });
    fc.assert(
      fc.property(scaledArb, ({ weights, k, amount }) => {
        const total = money(amount, 'USD');
        const plain = allocate(total, weights);
        const scaled = allocate(
          total,
          weights.map((x) => x * k),
        );
        expect(scaled).toEqual(plain);
      }),
      RUNS,
    );
  });

  it('a single weight returns the total for any non negative i128 amount', () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.bigInt({ min: 0n, max: MAX }), fc.constantFrom(0n, 1n, MAX - 1n, MAX)),
        fc.oneof(fc.bigInt({ min: 1n, max: MAX }), fc.constantFrom(1n, MAX)),
        unitArb,
        (amount, weight, unit) => {
          const total = make(amount, unit);
          expect(allocate(total, [weight])).toEqual([total]);
        },
      ),
      RUNS,
    );
  });

  it('overflow is thrown exactly when the weight sum or a product past the first leg leaves i128', () => {
    const wideWeight = fc.oneof(
      fc.bigInt({ min: 1n, max: MAX_WEIGHT }),
      fc.bigInt({ min: 1n, max: MAX }),
      fc.bigInt({ min: 1n, max: 2n ** 64n }),
      fc.constantFrom(1n, 2n, MAX - 1n, MAX, MAX + 1n, 2n ** 126n),
    );
    const wideTotal = fc.oneof(
      fc.bigInt({ min: 0n, max: MAX }),
      fc.bigInt({ min: 0n, max: 2n ** 64n }),
      fc.constantFrom(0n, 1n, 2n, MAX / 2n, MAX / 2n + 1n, MAX),
    );
    fc.assert(
      fc.property(
        wideTotal,
        fc.array(wideWeight, { minLength: 1, maxLength: MAX_LEGS }),
        (amount, weights) => {
          const total = tokenAmount(amount, 'USDC', 'stellar');
          const overflows = sumOf(weights) > MAX || weights.slice(1).some((x) => amount * x > MAX);
          const err = thrown(() => {
            const legs = allocate(total, weights);
            expect(sumOf(legs.map((leg) => leg.amount))).toBe(amount);
            for (const leg of legs) expect(leg.amount >= 0n && leg.amount <= MAX).toBe(true);
          });
          if (overflows) {
            expect(err).toBeInstanceOf(MoneyOverflowError);
          } else {
            expect(err).toBeUndefined();
          }
        },
      ),
      RUNS,
    );
  });

  it('a negative total always throws InvalidAllocationError', () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.bigInt({ min: MIN, max: -1n }), fc.constantFrom(MIN, MIN + 1n, -1n)),
        weightsArb,
        (amount, weights) => {
          expect(InvalidAllocationError).toBeTypeOf('function');
          expect(thrown(() => allocate(money(amount, 'USD'), weights))).toBeInstanceOf(
            InvalidAllocationError,
          );
        },
      ),
      RUNS,
    );
  });

  it('any invalid weight list throws InvalidAllocationError and nothing else', () => {
    const badWeight = fc.oneof(
      fc.bigInt({ min: MIN, max: 0n }),
      fc.constantFrom<unknown>(0n, -1n, 1, 0, 1.5, Number.NaN, '1', null, undefined, true),
      fc.constant(Object(1n) as unknown),
    );
    const listArb = fc.oneof(
      // A valid length with at least one bad weight somewhere.
      fc
        .tuple(
          fc.array(weightArb as fc.Arbitrary<unknown>, { maxLength: MAX_LEGS - 1 }),
          badWeight,
          fc.nat(),
        )
        .map(([good, bad, pos]) => {
          const list = [...good];
          list.splice(pos % (good.length + 1), 0, bad);
          return list;
        }),
      // Too many legs, all otherwise valid.
      fc.array(weightArb, { minLength: MAX_LEGS + 1, maxLength: MAX_LEGS + 40 }),
      fc.constant([]),
    );
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: MAX }), listArb, (amount, list) => {
        expect(InvalidAllocationError).toBeTypeOf('function');
        const err = thrown(() => allocate(money(amount, 'NGN'), list as readonly bigint[]));
        expect(err).toBeInstanceOf(InvalidAllocationError);
      }),
      RUNS,
    );
  });
});
