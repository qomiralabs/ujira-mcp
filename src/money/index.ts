// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

export { MAX_ALLOCATION_LEGS, allocate } from './allocate.js';
export {
  CurrencyMismatchError,
  InvalidAllocationError,
  InvalidAmountError,
  InvalidFormatOptionError,
  InvalidLocaleError,
  InvalidRoundingModeError,
  InvalidScaleError,
  KindMismatchError,
  MoneyError,
  MoneyOverflowError,
  RateMismatchError,
  ScaleMismatchError,
  TokenMismatchError,
  UnknownCurrencyError,
} from './errors.js';
export type { MoneyErrorCode } from './errors.js';
export {
  FIAT_CURRENCIES,
  SETTLEMENT_TOKENS,
  TOKEN_DISPLAY_SCALE,
  fiatCurrency,
  isFiatCurrencyCode,
  isTokenAsset,
  settlementToken,
} from './currencies.js';
export type {
  Chain,
  FiatCurrency,
  FiatCurrencyCode,
  SettlementToken,
  TokenAsset,
} from './currencies.js';
export {
  I128_MAX,
  I128_MIN,
  MAX_SCALE,
  add,
  compare,
  equals,
  isNegative,
  isZero,
  money,
  moneyAt,
  multiply,
  negate,
  subtract,
  sum,
  tokenAmount,
} from './money.js';
export type { Money, TokenAmount } from './money.js';
export { dollarSignAmbiguous, formatMoney, formatTokenAmount } from './format.js';
export type { CurrencyCodeDisplay } from './format.js';
export { parseMoney, parseTokenAmount, toDecimalString } from './parse.js';
export { ROUNDING_MODES, rescale, toMinor } from './rescale.js';
export type { RoundingMode } from './rescale.js';
