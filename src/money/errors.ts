// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

export type MoneyErrorCode =
  | 'MONEY_OVERFLOW'
  | 'CURRENCY_MISMATCH'
  | 'SCALE_MISMATCH'
  | 'UNKNOWN_CURRENCY'
  | 'INVALID_AMOUNT'
  | 'INVALID_SCALE'
  | 'INVALID_ALLOCATION'
  | 'INVALID_ROUNDING'
  | 'INVALID_LOCALE'
  | 'INVALID_FORMAT_OPTION'
  | 'KIND_MISMATCH'
  | 'TOKEN_MISMATCH'
  | 'RATE_MISMATCH';

/**
 * Base class for every money failure. Callers branch on `code`, which stays
 * stable across releases, rather than on message text.
 */
export abstract class MoneyError extends Error {
  abstract readonly code: MoneyErrorCode;
}

// Each subclass spells its own name out so minified builds keep readable names.

export class MoneyOverflowError extends MoneyError {
  override readonly name = 'MoneyOverflowError';
  readonly code = 'MONEY_OVERFLOW';
}

export class CurrencyMismatchError extends MoneyError {
  override readonly name = 'CurrencyMismatchError';
  readonly code = 'CURRENCY_MISMATCH';
}

export class ScaleMismatchError extends MoneyError {
  override readonly name = 'ScaleMismatchError';
  readonly code = 'SCALE_MISMATCH';
}

export class UnknownCurrencyError extends MoneyError {
  override readonly name = 'UnknownCurrencyError';
  readonly code = 'UNKNOWN_CURRENCY';
}

export class InvalidAmountError extends MoneyError {
  override readonly name = 'InvalidAmountError';
  readonly code = 'INVALID_AMOUNT';
}

export class InvalidScaleError extends MoneyError {
  override readonly name = 'InvalidScaleError';
  readonly code = 'INVALID_SCALE';
}

export class InvalidAllocationError extends MoneyError {
  override readonly name = 'InvalidAllocationError';
  readonly code = 'INVALID_ALLOCATION';
}

export class InvalidRoundingModeError extends MoneyError {
  override readonly name = 'InvalidRoundingModeError';
  readonly code = 'INVALID_ROUNDING';
}

export class InvalidLocaleError extends MoneyError {
  override readonly name = 'InvalidLocaleError';
  readonly code = 'INVALID_LOCALE';
}

export class InvalidFormatOptionError extends MoneyError {
  override readonly name = 'InvalidFormatOptionError';
  readonly code = 'INVALID_FORMAT_OPTION';
}

/** Fiat money and a token amount were combined. They never mix implicitly. */
export class KindMismatchError extends MoneyError {
  override readonly name = 'KindMismatchError';
  readonly code = 'KIND_MISMATCH';
}

/** Two token amounts differ in asset or chain. Kept so a second token or chain cannot mix silently. */
export class TokenMismatchError extends MoneyError {
  override readonly name = 'TokenMismatchError';
  readonly code = 'TOKEN_MISMATCH';
}

/**
 * A conversion source that is not the rate's base, or a target that is not
 * its quote, for example an NGN per USD rate applied to a KES target.
 */
export class RateMismatchError extends MoneyError {
  override readonly name = 'RateMismatchError';
  readonly code = 'RATE_MISMATCH';
}
