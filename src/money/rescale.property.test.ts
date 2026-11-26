// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The API contract for rescale is documented at the top of parse.test.ts.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { MoneyOverflowError, compare, moneyAt } from './index.js';
import type { FiatCurrencyCode, Money } from './index.js';
import { rescale } from './rescale.js';
import type { RoundingMode } from './rescale.js';

const MAX = 2n ** 127n - 1n;
const MIN = -(2n ** 127n);
const MODES: readonly RoundingMode[] = ['half-even', 'half-up', 'floor', 'ceil', 'trunc'];

// Fixed seed so a failure reproduces on every machine. Bump numRuns locally to
// search harder, never lower it to make a run pass.
const RUNS = { seed: 0x5ca1e, numRuns: 1000 } as const;
// 1000 runs take under a second on an idle machine and several times that on a
// loaded runner, so the default 5 second timeout fails them at random. 30
// seconds covers a heavily loaded runner and still catches a real hang.
const PROPERTY_TIMEOUT_MS = 30_000;

const CODES: FiatCurrencyCode[] = ['USD', 'NGN', 'KES', 'BRL', 'EUR'];

const i128 = fc.oneof(
  fc.bigInt({ min: MIN, max: MAX }),
  fc.bigInt({ min: -100_000n, max: 100_000n }),
  fc.constantFrom(MIN, MIN + 1n, -1n, 0n, 1n, MAX - 1n, MAX),
);
// Exact ties and near ties at every drop width, where rounding bugs hide.
const tieArb = fc
  .tuple(
    fc.integer({ min: 1, max: 18 }),
    fc.bigInt({ min: -1000n, max: 1000n }),
    fc.constantFrom(-1n, 0n, 1n),
  )
  .map(([d, k, nudge]) => 10n ** BigInt(d) * k + 10n ** BigInt(d) / 2n + nudge);
const amountArb = fc.oneof(i128, tieArb);
// Fiat holds its minor unit (2 for every launch currency) up to 18.
const scaleArb = fc.integer({ min: 2, max: 18 });
const modeArb = fc.constantFrom(...MODES);
const codeArb = fc.constantFrom(...CODES);

/** Reference: round n / d (d > 0) to an integer with a mode. */
function roundDiv(n: bigint, d: bigint, mode: RoundingMode): bigint {
  const q = n / d;
  if (n % d === 0n) return q;
  const down = n < 0n ? q - 1n : q;
  const up = down + 1n;
  const twice = 2n * (n - down * d);
  switch (mode) {
    case 'floor':
      return down;
    case 'ceil':
      return up;
    case 'trunc':
      return q;
    case 'half-up':
      if (twice === d) return n < 0n ? down : up;
      return twice < d ? down : up;
    case 'half-even':
      if (twice === d) return down % 2n === 0n ? down : up;
      return twice < d ? down : up;
  }
}

function attempt(run: () => Money): { value?: Money; err?: unknown } {
  try {
    return { value: run() };
  } catch (err) {
    return { err };
  }
}

describe('rescale properties', { timeout: PROPERTY_TIMEOUT_MS }, () => {
  it('scaling up then down returns the original', () => {
    fc.assert(
      fc.property(
        amountArb,
        codeArb,
        scaleArb,
        scaleArb,
        modeArb,
        modeArb,
        (amount, currency, a, b, upMode, downMode) => {
          const from = Math.min(a, b);
          const to = Math.max(a, b);
          const m = moneyAt(amount, currency, from);
          const up = attempt(() => rescale(m, to, upMode));
          if (up.value === undefined) {
            expect(up.err).toBeInstanceOf(MoneyOverflowError);
            return;
          }
          expect(rescale(up.value, from, downMode)).toEqual(m);
        },
      ),
      RUNS,
    );
  });

  it('rounding modes match a bigint reference', () => {
    fc.assert(
      fc.property(amountArb, scaleArb, scaleArb, modeArb, (amount, from, to, mode) => {
        const m = moneyAt(amount, 'USD', from);
        const got = attempt(() => rescale(m, to, mode));
        if (to >= from) {
          const want = amount * 10n ** BigInt(to - from);
          if (want > MAX || want < MIN) {
            expect(got.err).toBeInstanceOf(MoneyOverflowError);
          } else {
            expect(got.err).toBeUndefined();
            expect(got.value?.amount).toBe(want);
          }
        } else {
          expect(got.err).toBeUndefined();
          expect(got.value?.amount).toBe(roundDiv(amount, 10n ** BigInt(from - to), mode));
        }
        if (got.value !== undefined) {
          expect(got.value.scale).toBe(to);
          expect(got.value.currency).toBe('USD');
          expect(Object.isFrozen(got.value)).toBe(true);
        }
      }),
      RUNS,
    );
  });

  it('floor and ceil bracket the exact value, trunc never grows it, half modes stay within half a unit', () => {
    fc.assert(
      fc.property(amountArb, fc.integer({ min: 1, max: 18 }), scaleArb, (amount, drop, to) => {
        const from = Math.min(18, to + drop);
        const d = 10n ** BigInt(from - to);
        const m = moneyAt(amount, 'USD', from);
        const at = (mode: RoundingMode): bigint => rescale(m, to, mode).amount;
        const floor = at('floor');
        const ceil = at('ceil');
        expect(floor * d <= amount && amount <= ceil * d).toBe(true);
        expect(ceil - floor <= 1n).toBe(true);
        const trunc = at('trunc');
        const abs = (x: bigint): bigint => (x < 0n ? -x : x);
        expect(abs(trunc * d) <= abs(amount)).toBe(true);
        for (const mode of ['half-even', 'half-up'] as const) {
          expect(abs(at(mode) * d - amount) * 2n <= d).toBe(true);
        }
      }),
      RUNS,
    );
  });

  it('every mode is monotonic', () => {
    fc.assert(
      fc.property(amountArb, amountArb, scaleArb, scaleArb, modeArb, (x, y, from, to, mode) => {
        if (to > from) return;
        const [lo, hi] = x <= y ? [x, y] : [y, x];
        const a = rescale(moneyAt(lo, 'EUR', from), to, mode);
        const b = rescale(moneyAt(hi, 'EUR', from), to, mode);
        expect(compare(a, b) <= 0).toBe(true);
      }),
      RUNS,
    );
  });

  it('negating the input mirrors floor and ceil and keeps trunc and half-up symmetric', () => {
    fc.assert(
      fc.property(amountArb, scaleArb, scaleArb, (amount, from, to) => {
        if (to > from || amount === MIN) return;
        const pos = moneyAt(amount, 'USD', from);
        const neg = moneyAt(-amount, 'USD', from);
        expect(rescale(neg, to, 'floor').amount).toBe(-rescale(pos, to, 'ceil').amount);
        expect(rescale(neg, to, 'trunc').amount).toBe(-rescale(pos, to, 'trunc').amount);
        expect(rescale(neg, to, 'half-up').amount).toBe(-rescale(pos, to, 'half-up').amount);
        expect(rescale(neg, to, 'half-even').amount).toBe(-rescale(pos, to, 'half-even').amount);
      }),
      RUNS,
    );
  });
});
