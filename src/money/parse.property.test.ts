// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The API contract is documented at the top of parse.test.ts.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  InvalidAmountError,
  MoneyError,
  MoneyOverflowError,
  SETTLEMENT_TOKENS,
  moneyAt,
  tokenAmount,
} from './index.js';
import type { FiatCurrencyCode } from './index.js';
import { parseMoney, parseTokenAmount, toDecimalString } from './parse.js';
import type { RoundingMode } from './rescale.js';

const MAX = 2n ** 127n - 1n;
const MIN = -(2n ** 127n);
const MODES: readonly RoundingMode[] = ['half-even', 'half-up', 'floor', 'ceil', 'trunc'];

// Fixed seed so a failure reproduces on every machine. Bump numRuns locally to
// search harder, never lower it to make a run pass.
const RUNS = { seed: 0x9a75e, numRuns: 1000 } as const;
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

// Independent of the implementation: the grammar from the contract.
const GRAMMAR = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?$/;

const i128 = fc.oneof(
  fc.bigInt({ min: MIN, max: MAX }),
  fc.bigInt({ min: -10_000n, max: 10_000n }),
  fc.constantFrom(MIN, MIN + 1n, -1n, 0n, 1n, MAX - 1n, MAX),
);
// Fiat holds its minor unit (2 for every launch currency) up to 18.
const scaleArb = fc.integer({ min: 2, max: 18 });
const codeArb = fc.constantFrom(...CODES);

/** Reference decimal printer, written without the code under test. */
function decimal(amount: bigint, scale: number): string {
  const negative = amount < 0n;
  const digits = (negative ? -amount : amount).toString().padStart(scale + 1, '0');
  const int = digits.slice(0, digits.length - scale);
  const frac = digits.slice(digits.length - scale);
  return `${negative ? '-' : ''}${int}${scale > 0 ? `.${frac}` : ''}`;
}

/** Reference: round n / d (d > 0) to an integer with a mode. */
function roundDiv(n: bigint, d: bigint, mode: RoundingMode): bigint {
  const q = n / d;
  const r = n % d;
  if (r === 0n) return q;
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

/** A canonical decimal string with at most `scale` fraction digits, in range at scale. */
const canonicalArb = scaleArb.chain((scale) =>
  fc.tuple(fc.constant(scale), fc.integer({ min: 0, max: scale }), i128).map(([s, f, raw]) => {
    // Keep the value representable at s once padded from f digits.
    const bound = MAX / 10n ** BigInt(s - f);
    const v = raw > bound ? raw % (bound + 1n) : raw < -bound ? raw % (bound + 1n) : raw;
    return { scale: s, fracDigits: f, text: decimal(v, f), value: v };
  }),
);

describe('parse properties', { timeout: PROPERTY_TIMEOUT_MS }, () => {
  it('parseMoney(toDecimalString(m)) equals m for any m', () => {
    fc.assert(
      fc.property(i128, codeArb, scaleArb, (amount, currency, scale) => {
        const m = moneyAt(amount, currency, scale);
        const text = toDecimalString(m);
        expect(text).toBe(decimal(amount, scale));
        expect(parseMoney(text, currency, { scale })).toEqual(m);
      }),
      RUNS,
    );
  });

  it('parseTokenAmount(toDecimalString(t)) equals t for any token amount', () => {
    fc.assert(
      fc.property(i128, fc.constantFrom(...SETTLEMENT_TOKENS), (amount, token) => {
        const t = tokenAmount(amount, token.asset, token.chain);
        const text = toDecimalString(t);
        expect(text).toBe(decimal(amount, token.tokenScale));
        expect(parseTokenAmount(text, token.asset, token.chain)).toEqual(t);
      }),
      RUNS,
    );
  });

  it('toDecimalString(parseMoney(s)) equals s padded to scale', () => {
    fc.assert(
      fc.property(canonicalArb, codeArb, ({ scale, fracDigits, text, value }, currency) => {
        // A zero printed from a negative raw value is "0", never "-0".
        expect(GRAMMAR.test(text)).toBe(true);
        const m = parseMoney(text, currency, { scale });
        const padded = decimal(value * 10n ** BigInt(scale - fracDigits), scale);
        expect(toDecimalString(m)).toBe(padded);
        expect(m.amount).toBe(value * 10n ** BigInt(scale - fracDigits));
      }),
      RUNS,
    );
  });

  it('excess fraction digits always throw without a mode and match the reference with one', () => {
    const excessArb = fc.record({
      scale: fc.integer({ min: 2, max: 16 }),
      extra: fc.integer({ min: 1, max: 20 }),
      amount: fc.oneof(
        fc.bigInt({ min: -(10n ** 30n), max: 10n ** 30n }),
        fc.constantFrom(5n, -5n, 15n, -15n, 25n),
      ),
      mode: fc.constantFrom(...MODES),
    });
    fc.assert(
      fc.property(excessArb, ({ scale, extra, amount, mode }) => {
        const text = decimal(amount, scale + extra);
        if (text.length > 100) return;
        const err = (() => {
          try {
            parseMoney(text, 'USD', { scale });
          } catch (e) {
            return e;
          }
          return undefined;
        })();
        expect(err).toBeInstanceOf(InvalidAmountError);
        const want = roundDiv(amount, 10n ** BigInt(extra), mode);
        expect(parseMoney(text, 'USD', { scale, rounding: mode }).amount).toBe(want);
      }),
      RUNS,
    );
  });

  it('any string either matches the grammar and parses, or throws a MoneyError', () => {
    // Fuzz the parser with arbitrary text, digit soup and near misses.
    const near = fc
      .array(
        fc.constantFrom('0', '1', '9', '-', '+', '.', ',', 'e', ' ', '_', '\u0661', '\uff11', '\n'),
        { maxLength: 24 },
      )
      .map((parts) => parts.join(''));
    const textArb = fc.oneof(
      fc.string({ maxLength: 40 }),
      fc.string({ unit: 'binary', maxLength: 40 }),
      near,
    );
    fc.assert(
      fc.property(textArb, scaleArb, (text, scale) => {
        let result: unknown;
        let err: unknown;
        try {
          result = parseMoney(text, 'USD', { scale });
        } catch (e) {
          err = e;
        }
        const fraction = text.split('.')[1] ?? '';
        const shouldParse =
          text.length <= 100 &&
          GRAMMAR.test(text) &&
          !/^-0(\.0+)?$/.test(text) &&
          fraction.length <= scale;
        if (err !== undefined) {
          expect(err).toBeInstanceOf(MoneyError);
          if (shouldParse) expect(err).toBeInstanceOf(MoneyOverflowError);
          else expect(err).toBeInstanceOf(InvalidAmountError);
        } else {
          expect(shouldParse).toBe(true);
          expect(toDecimalString(result as never)).toBe(
            decimal((result as { amount: bigint }).amount, scale),
          );
        }
      }),
      RUNS,
    );
  });
});
