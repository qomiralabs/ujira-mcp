// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

import { settlementToken } from './currencies.js';
import type { Chain, FiatCurrencyCode, TokenAsset } from './currencies.js';
import { InvalidAmountError, InvalidRoundingModeError, InvalidScaleError } from './errors.js';
import {
  build,
  buildToken,
  minorUnits,
  parseFiatCurrency,
  parseFiatScale,
  powerOfTen,
  snapshot,
} from './money.js';
import type { Money, TokenAmount } from './money.js';
import { isPlainRecord, readOwnField } from './options.js';
import { divideRounded, parseRoundingMode } from './rescale.js';
import type { RoundingMode } from './rescale.js';

const DECIMAL = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?$/;
const NEGATIVE_ZERO = /^-0(\.0+)?$/;

// Far longer than any i128 at scale 18 (40 digits plus 18 and a sign), and
// short enough that the regex and BigInt never see a hostile megabyte.
const MAX_INPUT_LENGTH = 100;

function readText(input: unknown): string {
  if (
    typeof input !== 'string' ||
    input.length > MAX_INPUT_LENGTH ||
    !DECIMAL.test(input) ||
    NEGATIVE_ZERO.test(input)
  ) {
    throw new InvalidAmountError('amount must be a plain decimal string');
  }
  return input;
}

/** Options must be absent or an object; each field is read at most once. */
function readOptions(options: unknown): { scale: unknown; rounding: unknown } {
  if (options === undefined) return { scale: undefined, rounding: undefined };
  // A bare number is almost certainly a scale passed the old way.
  if (typeof options === 'number') {
    throw new InvalidScaleError('pass the scale as options.scale');
  }
  if (!isPlainRecord(options)) {
    throw new InvalidRoundingModeError('options must be a plain object');
  }
  return { scale: readOwnField(options, 'scale'), rounding: readOwnField(options, 'rounding') };
}

/**
 * The exact amount of `text` in units of 10^-scale. A fraction shorter than
 * `scale` is padded; a longer one needs `mode`, otherwise it throws.
 */
function amountAt(text: string, scale: number, mode: RoundingMode | undefined): bigint {
  const negative = text.startsWith('-');
  const [whole = '', fraction = ''] = (negative ? text.slice(1) : text).split('.');
  const sign = negative ? -1n : 1n;
  if (fraction.length <= scale) {
    return sign * BigInt(whole + fraction.padEnd(scale, '0'));
  }
  if (mode === undefined) {
    throw new InvalidAmountError('amount has more fraction digits than the scale allows');
  }
  // One zero per dropped digit gives the divisor as text, so its size never
  // passes through a number.
  const divisor = BigInt(`1${fraction.slice(scale).replace(/[0-9]/g, '0')}`);
  return divideRounded(sign * BigInt(whole + fraction), divisor, mode);
}

/**
 * Parses a plain decimal such as "12.30" into fiat money, at the currency's
 * minor unit unless `options.scale` asks for a finer one.
 *
 * Only ASCII digits, an optional leading minus and one optional fraction are
 * accepted. A fraction shorter than the scale is padded. A longer one throws
 * InvalidAmountError, even when the extra digits are zeros, unless
 * `options.rounding` is given, in which case the exact value is rounded.
 * Validation order: text, currency, options, scale, rounding, fraction
 * length, range.
 */
export function parseMoney(
  input: string,
  currency: FiatCurrencyCode,
  options?: { scale?: number; rounding?: RoundingMode },
): Money {
  const text = readText(input);
  const code = parseFiatCurrency(currency);
  const { scale, rounding } = readOptions(options);
  const target = scale === undefined ? minorUnits(code) : parseFiatScale(scale, code);
  const mode = rounding === undefined ? undefined : parseRoundingMode(rounding);
  return build(amountAt(text, target, mode), code, target);
}

/**
 * Parses a plain decimal token amount such as "1.234567" at the token's
 * decimals on `chain`. More fraction digits than the token has throw unless
 * `options.rounding` is given. Validation order: text, asset and chain,
 * options, rounding, fraction length, range.
 */
export function parseTokenAmount(
  input: string,
  asset: TokenAsset,
  chain: Chain,
  options?: { rounding?: RoundingMode },
): TokenAmount {
  const text = readText(input);
  const token = settlementToken(asset, chain);
  const { rounding } = readOptions(options);
  const mode = rounding === undefined ? undefined : parseRoundingMode(rounding);
  return buildToken(amountAt(text, token.tokenScale, mode), token.asset, token.chain);
}

/** Plain decimal text of `amount` units of 10^-scale, for example "-0.05". */
export function decimalText(amount: bigint, scale: number): string {
  const negative = amount < 0n;
  const magnitude = negative ? -amount : amount;
  const unit = powerOfTen(scale);
  const whole = (magnitude / unit).toString();
  const sign = negative ? '-' : '';
  if (scale === 0) return sign + whole;
  const fraction = (magnitude % unit).toString().padStart(scale, '0');
  return `${sign}${whole}.${fraction}`;
}

/**
 * Canonical plain decimal with exactly the value's scale in fraction digits:
 * "12.30" for 1230 USD cents, "0.1234567" for 1234567 USDC units on Stellar.
 * Never a negative zero, always ASCII, for data rather than display.
 */
export function toDecimalString(m: Money | TokenAmount): string {
  const value = snapshot(m);
  return decimalText(value.amount, value.scale);
}
