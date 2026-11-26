// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

import { KindMismatchError, allocate, isNegative, isZero } from '../money/index.js';
import type { TokenAmount } from '../money/index.js';
import { InvalidLegsError } from './errors.js';

/** Most legs one payout is split into. */
export const MAX_LEGS = 4;

export interface LegAllocation {
  /** Position in the payout, from 0. Leg 0 carries any rounding remainder. */
  readonly index: number;
  readonly amount: TokenAmount;
}

/**
 * Splits a payout total into one leg per weight, in weight order. Legs always
 * add back to exactly the total, and the rounding remainder lands on leg 0,
 * so the mandate's checks, which run on the total, see the same number the
 * legs pay out.
 *
 * Throws InvalidLegsError for a total that is not above zero, for fewer than
 * one or more than MAX_LEGS weights, and for a split that would leave any leg
 * with nothing (2 split 1:1:1, say), since a zero transfer is not a payout.
 * Weights that are not bigints above zero, or that overflow, throw the money
 * module's InvalidAllocationError or MoneyOverflowError.
 */
export function allocateLegs(
  total: TokenAmount,
  weights: readonly bigint[],
): readonly LegAllocation[] {
  const list: unknown = weights;
  // Read once: a proxy could report a different length on every read.
  const length: unknown = Array.isArray(list) ? list.length : undefined;
  if (typeof length !== 'number' || length < 1 || length > MAX_LEGS) {
    throw new InvalidLegsError(`a payout has 1 to ${String(MAX_LEGS)} legs`);
  }
  if (isZero(total) || isNegative(total)) {
    throw new InvalidLegsError('a payout total must be above zero');
  }
  const legs = allocate(total, weights);
  // The type says token, but a decoded row or a cast can still carry fiat.
  const fiat = legs.some((leg) => (leg as { kind: string }).kind !== 'token');
  if (fiat) throw new KindMismatchError('payout legs are token amounts, got fiat money');
  // The final guard: whatever the inputs claimed, no leg leaves here at zero.
  if (legs.some((leg) => leg.amount <= 0n)) {
    throw new InvalidLegsError('every leg must be above zero; use fewer legs or other weights');
  }
  return Object.freeze(legs.map((amount, index) => Object.freeze({ index, amount })));
}
