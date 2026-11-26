// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

import { InvalidAllocationError, MoneyOverflowError } from './errors.js';
import { I128_MAX, snapshot, withAmount } from './money.js';
import type { Money, TokenAmount } from './money.js';

/** Most legs one payout can be split into. */
export const MAX_ALLOCATION_LEGS = 16;

// Indices are walked from this fixed list rather than a counter, which keeps
// number arithmetic out of money code and caps the loop by construction.
const LEG_INDICES: readonly number[] = Object.freeze([...Array(MAX_ALLOCATION_LEGS).keys()]);

const OVERFLOW_MESSAGE = 'allocation exceeds the signed 128 bit range';

/**
 * Reads the length and each weight exactly once, so a proxy or getter cannot
 * pass validation with one value and be split with another.
 */
function readWeights(weights: readonly bigint[]): bigint[] {
  const list: unknown = weights;
  if (!Array.isArray(list)) {
    throw new InvalidAllocationError('weights must be an array');
  }
  const length: unknown = list.length;
  // A proxy can report any length, so only a whole count in range is
  // trusted before a single weight is read.
  if (
    typeof length !== 'number' ||
    !Number.isSafeInteger(length) ||
    length < 1 ||
    length > MAX_ALLOCATION_LEGS
  ) {
    throw new InvalidAllocationError(
      `weights must hold 1 to ${String(MAX_ALLOCATION_LEGS)} entries`,
    );
  }
  const read: bigint[] = [];
  for (const i of LEG_INDICES) {
    if (i >= length) break;
    // A hole is missing, never a value inherited from Array.prototype.
    const weight: unknown = Object.hasOwn(list, i) ? (list as readonly unknown[])[i] : undefined;
    if (typeof weight !== 'bigint' || weight <= 0n) {
      throw new InvalidAllocationError('every weight must be a bigint greater than zero');
    }
    read.push(weight);
  }
  return read;
}

/**
 * Splits `total` into one leg per weight, in weight order, so that the legs
 * always add back to exactly `total`.
 *
 * Every leg after the first is the floor of `total * weight / sum(weights)`.
 * The first leg is `total` minus all the others, so the whole rounding
 * remainder lands on it. That means 100 split 1:1:1 is 34, 33, 33, and the
 * first leg can sit more than one unit above its exact share when there are
 * three or more legs (2 split 1:1:1 is 2, 0, 0).
 *
 * Throws InvalidAllocationError for a negative total, a non array, an empty
 * list, more than MAX_ALLOCATION_LEGS weights, or any weight that is not a
 * bigint above zero. Throws MoneyOverflowError when the weights or a product
 * for a leg after the first leaves the i128 range.
 *
 * Legs keep the total's kind and unit: fiat legs keep the currency and
 * scale, token legs keep the asset and chain, so a payout split into token
 * legs can never land on another chain.
 */
export function allocate(total: Money, weights: readonly bigint[]): Money[];
export function allocate(total: TokenAmount, weights: readonly bigint[]): TokenAmount[];
export function allocate(
  total: Money | TokenAmount,
  weights: readonly bigint[],
): (Money | TokenAmount)[] {
  const t = snapshot(total);
  if (t.amount < 0n) {
    throw new InvalidAllocationError('cannot allocate a negative total');
  }
  const read = readWeights(weights);

  let weightSum = 0n;
  for (const weight of read) {
    weightSum += weight;
    if (weightSum > I128_MAX) throw new MoneyOverflowError(OVERFLOW_MESSAGE);
  }

  // The first leg's product is never formed, so it can never overflow.
  const shares: bigint[] = [];
  let allocated = 0n;
  for (const weight of read.slice(1)) {
    const product = t.amount * weight;
    if (product > I128_MAX) throw new MoneyOverflowError(OVERFLOW_MESSAGE);
    const share = product / weightSum;
    shares.push(share);
    allocated += share;
  }

  return [t.amount - allocated, ...shares].map((amount) => withAmount(t, amount));
}
