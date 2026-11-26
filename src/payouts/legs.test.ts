// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  I128_MAX,
  InvalidAllocationError,
  MoneyOverflowError,
  money,
  tokenAmount,
} from '../money/index.js';
import type { Money, TokenAmount } from '../money/index.js';
import { InvalidLegsError, PayoutError } from './errors.js';
import { MAX_LEGS, allocateLegs } from './legs.js';

// Fixed seed so a failure reproduces on every machine. Raise numRuns locally
// to search harder.
const RUNS = { seed: 0x1e65, numRuns: 1000 } as const;
const PROPERTY_TIMEOUT_MS = 60_000;

const usdc = (amount: bigint): TokenAmount => tokenAmount(amount, 'USDC', 'stellar');
const amounts = (legs: readonly { amount: TokenAmount }[]): bigint[] =>
  legs.map((leg) => leg.amount.amount);

function legsError(run: () => unknown): InvalidLegsError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(InvalidLegsError);
    expect(error).toBeInstanceOf(PayoutError);
    expect((error as InvalidLegsError).code).toBe('INVALID_LEGS');
    expect((error as InvalidLegsError).name).toBe('InvalidLegsError');
    return error as InvalidLegsError;
  }
  throw new Error('expected InvalidLegsError');
}

describe('allocateLegs', () => {
  it('caps a payout at four legs', () => {
    expect(MAX_LEGS).toBe(4);
  });

  it('gives a wallet payout one leg holding the whole total', () => {
    const legs = allocateLegs(usdc(25_000_000n), [1n]);
    expect(legs).toEqual([{ index: 0, amount: usdc(25_000_000n) }]);
  });

  it('puts the rounding remainder on the first leg', () => {
    expect(amounts(allocateLegs(usdc(100n), [1n, 1n, 1n]))).toEqual([34n, 33n, 33n]);
    expect(amounts(allocateLegs(usdc(10n), [1n, 2n]))).toEqual([4n, 6n]);
    expect(amounts(allocateLegs(usdc(7n), [1n, 1n, 1n, 1n]))).toEqual([4n, 1n, 1n, 1n]);
  });

  it('numbers legs from zero in weight order and keeps the asset and chain', () => {
    const legs = allocateLegs(usdc(9n), [1n, 1n, 1n]);
    expect(legs.map((leg) => leg.index)).toEqual([0, 1, 2]);
    for (const leg of legs) {
      expect(leg.amount.asset).toBe('USDC');
      expect(leg.amount.chain).toBe('stellar');
      expect(Object.isFrozen(leg)).toBe(true);
    }
    expect(Object.isFrozen(legs)).toBe(true);
  });

  it('refuses a zero or negative total', () => {
    legsError(() => allocateLegs(usdc(0n), [1n]));
    legsError(() => allocateLegs(usdc(-1n), [1n]));
  });

  it('refuses no legs and more than four', () => {
    legsError(() => allocateLegs(usdc(100n), []));
    const error = legsError(() => allocateLegs(usdc(100n), [1n, 1n, 1n, 1n, 1n]));
    expect(error.message).toBe('a payout has 1 to 4 legs');
  });

  it('refuses a split that would leave a leg with nothing', () => {
    legsError(() => allocateLegs(usdc(2n), [1n, 1n, 1n]));
    legsError(() => allocateLegs(usdc(100n), [1000n, 1n]));
  });

  it('refuses weights that are not bigints above zero with the money error', () => {
    for (const weights of [[0n], [-1n], [1n, 0n], [1] as unknown as bigint[]]) {
      expect(() => allocateLegs(usdc(100n), weights)).toThrow(InvalidAllocationError);
    }
  });

  it('refuses weights that would overflow', () => {
    expect(() => allocateLegs(usdc(I128_MAX), [1n, I128_MAX])).toThrow(MoneyOverflowError);
  });

  it('refuses a weight list that is not an array', () => {
    legsError(() => allocateLegs(usdc(100n), 'abc' as unknown as bigint[]));
    legsError(() => allocateLegs(usdc(100n), { length: 2 } as unknown as bigint[]));
  });

  it('refuses fiat money, since payouts settle in tokens', () => {
    const fiat: Money = money(100n, 'USD');
    expect(() => allocateLegs(fiat as unknown as TokenAmount, [1n])).toThrow(/token amount/);
  });
});

describe('allocateLegs properties', { timeout: PROPERTY_TIMEOUT_MS }, () => {
  const total = fc.bigInt({ min: 1n, max: 10n ** 30n });
  const weights = fc.array(fc.bigInt({ min: 1n, max: 10n ** 6n }), {
    minLength: 1,
    maxLength: MAX_LEGS,
  });

  it('either splits exactly or refuses because a leg would be zero', () => {
    fc.assert(
      fc.property(total, weights, (t, w) => {
        const weightSum = w.reduce((a, b) => a + b, 0n);
        const shares = w.slice(1).map((weight) => (t * weight) / weightSum);
        const first = t - shares.reduce((a, b) => a + b, 0n);
        const expected = [first, ...shares];
        if (expected.some((amount) => amount <= 0n)) {
          legsError(() => allocateLegs(usdc(t), w));
          return;
        }
        const legs = allocateLegs(usdc(t), w);
        expect(amounts(legs)).toEqual(expected);
        expect(legs).toHaveLength(w.length);
        expect(amounts(legs).reduce((a, b) => a + b, 0n)).toBe(t);
      }),
      RUNS,
    );
  });

  it('always sums to the total with every leg above zero when each leg can get a unit', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 4n, max: 10n ** 30n }),
        fc.integer({ min: 1, max: MAX_LEGS }),
        (t, n) => {
          const legs = allocateLegs(
            usdc(t),
            Array.from({ length: n }, () => 1n),
          );
          expect(legs).toHaveLength(n);
          expect(amounts(legs).reduce((a, b) => a + b, 0n)).toBe(t);
          for (const leg of legs) expect(leg.amount.amount > 0n).toBe(true);
          // Equal weights put every unit of the remainder on leg zero.
          const rest = amounts(legs).slice(1);
          for (const amount of rest) expect(amount).toBe(t / BigInt(n));
        },
      ),
      RUNS,
    );
  });
});
