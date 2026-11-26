// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The engine's original helpers, from before the money module. They work on
// bare bigints at the Stellar scale and stay exported, unchanged, through
// src/money.ts for the code and the published package that already use them.

import { z } from 'zod';

import { I128_MAX } from './money.js';

/** Stellar assets carry seven decimal places; one unit is 10^7 minor units. */
export const STELLAR_DECIMALS = 7;

/**
 * An amount in integer minor units, given as a decimal string so no float can
 * ever stand in for it. Positive and within i128.
 */
export const minorUnits = z
  .string()
  .regex(/^[1-9][0-9]{0,38}$/, 'a positive whole number of minor units, as a string')
  .transform((s) => BigInt(s))
  .refine((v) => v <= I128_MAX, 'too large');

/** Renders minor units as a decimal string for people, never for arithmetic. */
export function formatUnits(amount: bigint, decimals = STELLAR_DECIMALS): string {
  const negative = amount < 0n;
  const abs = negative ? -amount : amount;
  const scale = 10n ** BigInt(decimals);
  const whole = abs / scale;
  const frac = (abs % scale).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole.toString()}${frac === '' ? '' : `.${frac}`}`;
}

/** Whole units to minor units, for examples and tests that think in units. */
export function units(whole: number, decimals = STELLAR_DECIMALS): bigint {
  if (!Number.isSafeInteger(whole)) throw new RangeError('units takes a whole number');
  return BigInt(whole) * 10n ** BigInt(decimals);
}
