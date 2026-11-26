// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// Moves money between rows and the money model, and nothing else.
//
// Out of the database: pg returns numeric and int8 as strings, because a
// JavaScript number cannot hold either exactly, and the type parsers stay as
// pg ships them. The string goes straight into the money constructors, which
// parse it as a bigint and check the range, currency and scale, so a row the
// money model would refuse is refused here rather than carried onwards.
//
// Into the database: the amount travels as the decimal text of its bigint,
// which Postgres reads into numeric exactly. A number never appears on
// either side.
//
// Internal to src/db: repositories map their rows through it, and callers
// only ever see Money and TokenAmount.

import {
  moneyAt,
  ScaleMismatchError,
  fiatCurrency,
  settlementToken,
  tokenAmount,
  type Money,
  type TokenAmount,
} from '../money/index.js';

export interface FiatAmountRow {
  readonly amount: string;
  readonly currency: string;
  readonly scale: number;
}

export interface TokenAmountRow {
  readonly amount: string;
  readonly asset: string;
  readonly chain: string;
  readonly scale: number;
}

export function fiatFromRow(row: FiatAmountRow): Money {
  const { code } = fiatCurrency(row.currency);
  return moneyAt(row.amount, code, row.scale);
}

export function tokenFromRow(row: TokenAmountRow): TokenAmount {
  const token = settlementToken(row.asset, row.chain);
  // The foreign key already ties the scale to the token, so a mismatch here
  // means the row came from somewhere that skipped it.
  if (row.scale !== token.tokenScale) {
    throw new ScaleMismatchError('the row scale is not the token scale for its asset and chain');
  }
  return tokenAmount(row.amount, token.asset, token.chain);
}

// The amount as a query parameter.
export function amountParam(value: Money | TokenAmount): string {
  return value.amount.toString();
}
