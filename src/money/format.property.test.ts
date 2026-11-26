// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The API contract for formatMoney is documented at the top of parse.test.ts.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { formatMoney, formatTokenAmount } from './format.js';
import { moneyAt, tokenAmount } from './index.js';
import type { Chain, FiatCurrencyCode, TokenAsset } from './index.js';
import { parseMoney } from './parse.js';
import type { RoundingMode } from './rescale.js';

const MAX = 2n ** 127n - 1n;
const MIN = -(2n ** 127n);
const NBSP = '\u00a0';
const MODES: readonly RoundingMode[] = ['half-even', 'half-up', 'floor', 'ceil', 'trunc'];

// Fixed seed so a failure reproduces on every machine. Bump numRuns locally to
// search harder, never lower it to make a run pass.
const RUNS = { seed: 0xf0a7, numRuns: 1000 } as const;
// 1000 runs take under a second on an idle machine and several times that on a
// loaded runner, so the default 5 second timeout fails them at random. 30
// seconds covers a heavily loaded runner and still catches a real hang.
const PROPERTY_TIMEOUT_MS = 30_000;

const i128 = fc.oneof(
  fc.bigInt({ min: MIN, max: MAX }),
  fc.bigInt({ min: -100_000n, max: 100_000n }),
  fc.constantFrom(MIN, -1n, 0n, 1n, MAX),
);

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

/** Reference en-US rendering of an amount in hundredths with a prefix symbol and U+2212 minus. */
function enUS(hundredths: bigint, symbol: string): string {
  const negative = hundredths < 0n;
  const digits = (negative ? -hundredths : hundredths).toString().padStart(3, '0');
  const int = digits.slice(0, -2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '\u2212' : ''}${symbol}${int}.${digits.slice(-2)}`;
}

describe('format properties', { timeout: PROPERTY_TIMEOUT_MS }, () => {
  it('parse then format round trips for any two decimal USD amount', () => {
    fc.assert(
      fc.property(i128, (amount) => {
        const negative = amount < 0n;
        const digits = (negative ? -amount : amount).toString().padStart(3, '0');
        const text = `${negative ? '-' : ''}${digits.slice(0, -2)}.${digits.slice(-2)}`;
        const m = parseMoney(text, 'USD');
        expect(formatMoney(m, { locale: 'en-US' })).toBe(enUS(amount, '$'));
      }),
      RUNS,
    );
  });

  it('display rounding matches the bigint reference for every mode and scale', () => {
    fc.assert(
      fc.property(
        i128,
        // Fiat scales run from the minor unit (2) to 18, so display only rounds.
        fc.integer({ min: 2, max: 18 }),
        fc.constantFrom(...MODES),
        fc.constantFrom<[FiatCurrencyCode, string]>(['USD', '$'], ['NGN', '₦'], ['GBP', '£']),
        (amount, scale, mode, [currency, symbol]) => {
          const m = moneyAt(amount, currency, scale);
          const shown = roundDiv(amount, 10n ** BigInt(scale - 2), mode);
          expect(formatMoney(m, { locale: 'en-US', rounding: mode })).toBe(enUS(shown, symbol));
        },
      ),
      RUNS,
    );
  });

  it('token amounts show two decimals and the asset code', () => {
    fc.assert(
      fc.property(
        i128,
        fc.constantFrom<[TokenAsset, Chain, number]>(['USDC', 'stellar', 7]),
        (amount, [asset, chain, scale]) => {
          const shown = roundDiv(amount, 10n ** BigInt(scale - 2), 'half-even');
          expect(formatTokenAmount(tokenAmount(amount, asset, chain), { locale: 'en-US' })).toBe(
            `${enUS(shown, '')}${NBSP}${asset}`,
          );
        },
      ),
      RUNS,
    );
  });

  it('is deterministic across locales and never prints a negative zero', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: -10_000n, max: 10_000n }),
        fc.constantFrom('en-NG', 'en-KE', 'pt-BR', 'es-CO', 'en-IN', 'de-DE'),
        (amount, locale) => {
          const m = moneyAt(amount, 'NGN', 6);
          const a = formatMoney(m, { locale });
          expect(formatMoney(m, { locale })).toBe(a);
          if (roundDiv(amount, 10n ** 4n, 'half-even') === 0n) expect(a).not.toMatch(/[-\u2212]/);
        },
      ),
      RUNS,
    );
  });
});
