// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// Amounts move between the screen and the API as strings of integer minor
// units. USDC has 7 decimals, so "10000000" is 1 USDC. Conversion is done on
// the digits themselves; a JavaScript number never holds an amount.

export const USDC_DECIMALS = 7;

export type ParsedAmount = { ok: true; minor: string } | { ok: false; error: string };

const DECIMAL = /^(\d*)(?:\.(\d*))?$/;
const MINOR = /^\d+$/;

function stripLeadingZeros(digits: string): string {
  const trimmed = digits.replace(/^0+/, '');
  return trimmed === '' ? '0' : trimmed;
}

/**
 * Reads what a person typed ("12", "12.5", "1,000.25") into minor units.
 * Commas and spaces are accepted as thousands separators; anything else that
 * is not a plain decimal number is refused with a sentence to show them.
 */
export function parseAmount(input: string, decimals: number = USDC_DECIMALS): ParsedAmount {
  const cleaned = input.trim().replace(/[,\s_]/g, '');
  if (cleaned === '') return { ok: false, error: 'Enter an amount.' };
  if (cleaned.startsWith('-')) return { ok: false, error: 'The amount cannot be negative.' };
  const match = DECIMAL.exec(cleaned);
  if (match === null) return { ok: false, error: 'Use digits and one decimal point, like 12.50.' };
  const whole = match[1] ?? '';
  const fraction = match[2] ?? '';
  if (whole === '' && fraction === '') {
    return { ok: false, error: 'Use digits and one decimal point, like 12.50.' };
  }
  if (fraction.length > decimals) {
    return { ok: false, error: `Use at most ${decimals} decimal places.` };
  }
  const minor = stripLeadingZeros(whole + fraction.padEnd(decimals, '0'));
  if (minor.length > 30) return { ok: false, error: 'That amount is too large.' };
  return { ok: true, minor };
}

/** The minor units of a whole number of tokens, for defaults and tests. */
export function wholeUnits(units: number | string, decimals: number = USDC_DECIMALS): string {
  const digits = String(units);
  if (!MINOR.test(digits)) throw new Error('wholeUnits takes a non-negative integer');
  return stripLeadingZeros(digits + '0'.repeat(decimals));
}

function groupThousands(whole: string): string {
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

export interface FormatOptions {
  readonly decimals?: number;
  /** Fraction digits always shown; more appear only when the amount has them. */
  readonly minFraction?: number;
  /** Thousands separators; off for values that go back into an input. */
  readonly grouping?: boolean;
}

/**
 * Minor units as a decimal string: "125000000" is "12.50". Shows at least
 * two decimals and up to all seven, so no part of an amount is ever hidden.
 */
export function formatAmount(minor: string, options: FormatOptions = {}): string {
  const decimals = options.decimals ?? USDC_DECIMALS;
  const minFraction = Math.min(options.minFraction ?? 2, decimals);
  const negative = minor.startsWith('-');
  const digits = negative ? minor.slice(1) : minor;
  if (!MINOR.test(digits)) return minor;
  const padded = digits.padStart(decimals + 1, '0');
  const whole = stripLeadingZeros(padded.slice(0, padded.length - decimals));
  let fraction = padded.slice(padded.length - decimals);
  while (fraction.length > minFraction && fraction.endsWith('0')) fraction = fraction.slice(0, -1);
  const shownWhole = options.grouping === false ? whole : groupThousands(whole);
  const body = fraction === '' ? shownWhole : `${shownWhole}.${fraction}`;
  return negative ? `-${body}` : body;
}

/** "12.50 USDC". */
export function formatUsdc(minor: string): string {
  return `${formatAmount(minor)} USDC`;
}

export function isMinor(value: string): boolean {
  return MINOR.test(value);
}

export function compareMinor(a: string, b: string): -1 | 0 | 1 {
  const x = BigInt(a);
  const y = BigInt(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

export function addMinor(a: string, b: string): string {
  return (BigInt(a) + BigInt(b)).toString();
}

export function subMinor(a: string, b: string): string {
  return (BigInt(a) - BigInt(b)).toString();
}

/**
 * The share of `part` in `whole` as a whole percentage from 0 to 100, for a
 * bar width. Rounded down so a bar never shows more used than there is.
 */
export function percentOf(part: string, whole: string): number {
  const w = BigInt(whole);
  if (w <= 0n) return 0;
  const p = BigInt(part);
  if (p <= 0n) return 0;
  if (p >= w) return 100;
  return Number((p * 100n) / w);
}
