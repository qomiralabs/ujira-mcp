// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

import { fiatCurrency, isFiatCurrencyCode, settlementToken } from './currencies.js';
import type { Chain, FiatCurrencyCode, TokenAsset } from './currencies.js';
import {
  CurrencyMismatchError,
  InvalidAmountError,
  InvalidScaleError,
  KindMismatchError,
  MoneyOverflowError,
  ScaleMismatchError,
  TokenMismatchError,
  UnknownCurrencyError,
} from './errors.js';
import { isPlainRecord, readOwnField, readOwnIndex } from './options.js';

// Soroban stores amounts as i128, so anything wider could never settle there.
export const I128_MIN: bigint = -(2n ** 127n);
export const I128_MAX: bigint = 2n ** 127n - 1n;

// The finest scale fiat may be held at, for rates, caps and conversions.
// Settlement tokens are narrower: USDC on Stellar uses 7.
export const MAX_SCALE = 18;

/**
 * A fiat amount in minor units at `scale`. The scale is the currency's ISO
 * minor unit unless the value was built finer with moneyAt; it is never
 * coarser. Build it with money or moneyAt, never by hand.
 */
export interface Money {
  readonly kind: 'fiat';
  readonly amount: bigint;
  readonly currency: FiatCurrencyCode;
  readonly scale: number;
}

/**
 * A settlement token amount in raw on-chain units. The scale is always the
 * token's decimals on its chain, and the chain stays part of the value, so
 * one asset on two chains would be two different values by construction.
 * Build it with tokenAmount.
 */
export interface TokenAmount {
  readonly kind: 'token';
  readonly amount: bigint;
  readonly asset: TokenAsset;
  readonly chain: Chain;
  readonly scale: number;
}

// 10^0 through 10^MAX_SCALE, built from bigint exponents so that no number
// is ever converted to a bigint.
const POWERS_OF_TEN: readonly bigint[] = Object.freeze(
  [0n, 1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n, 9n, 10n, 11n, 12n, 13n, 14n, 15n, 16n, 17n, 18n].map(
    (exponent) => 10n ** exponent,
  ),
);

const SCALE_MESSAGE = `scale must be an integer from 0 to ${String(MAX_SCALE)}`;

/**
 * True only for a safe integer from 0 to MAX_SCALE. Every scale is checked
 * with this before it indexes a table, so a value the table does not hold
 * can never be answered by a polluted Array or Object prototype.
 */
export function isScaleNumber(scale: unknown): scale is number {
  return (
    typeof scale === 'number' && Number.isSafeInteger(scale) && scale >= 0 && scale <= MAX_SCALE
  );
}

/**
 * 10 to the power of a scale. A scale outside 0 to MAX_SCALE throws
 * InvalidScaleError. The table is read through its own entries as well as
 * the scale check, so if the two ever disagree the missing entry throws
 * instead of resolving through Array.prototype.
 */
export function powerOfTen(scale: number): bigint {
  const power = isScaleNumber(scale) ? readOwnIndex(POWERS_OF_TEN, scale) : undefined;
  if (typeof power !== 'bigint') throw new InvalidScaleError(SCALE_MESSAGE);
  return power;
}

const CANONICAL_INTEGER = /^-?(0|[1-9][0-9]*)$/;

// I128_MIN has 39 digits. Longer strings are rejected before BigInt parses
// them, so a hostile megabyte of nines costs nothing.
const MAX_I128_DIGITS = 39;

const OVERFLOW_MESSAGE = 'amount is outside the signed 128 bit range';

/** Throws MoneyOverflowError outside i128, otherwise returns the value. */
export function checked(value: bigint): bigint {
  if (value < I128_MIN || value > I128_MAX) {
    throw new MoneyOverflowError(OVERFLOW_MESSAGE);
  }
  return value;
}

/** Returns the parsed amount, or null when it is well formed but too long to be in range. */
function parseAmount(amount: unknown): bigint | null {
  if (typeof amount === 'bigint') return amount;
  if (typeof amount !== 'string' || !CANONICAL_INTEGER.test(amount) || amount === '-0') {
    throw new InvalidAmountError('amount must be a bigint or a canonical integer string');
  }
  const digits = amount.startsWith('-') ? amount.slice(1) : amount;
  return digits.length > MAX_I128_DIGITS ? null : BigInt(amount);
}

function rangeChecked(parsed: bigint | null): bigint {
  if (parsed === null) throw new MoneyOverflowError(OVERFLOW_MESSAGE);
  return checked(parsed);
}

/** Validates a fiat currency code. Token assets are not fiat and throw. */
export function parseFiatCurrency(currency: unknown): FiatCurrencyCode {
  if (!isFiatCurrencyCode(currency)) {
    throw new UnknownCurrencyError('unknown fiat currency code');
  }
  return currency;
}

/** The ISO minor unit of a validated fiat currency, the default scale for its money. */
export function minorUnits(currency: FiatCurrencyCode): number {
  return fiatCurrency(currency).minorUnits;
}

/**
 * Validates a fiat scale: an integer from the currency's minor unit up to
 * MAX_SCALE. Finer scales hold working values such as limits at 10^-6 USD;
 * coarser ones would let a whole-unit amount pass for minor units.
 */
export function parseFiatScale(scale: unknown, currency: FiatCurrencyCode): number {
  if (!isScaleNumber(scale) || scale < minorUnits(currency)) {
    throw new InvalidScaleError(
      `scale must be an integer from the currency's minor unit to ${String(MAX_SCALE)}`,
    );
  }
  // Every fiat minor unit is above zero today, so a negative zero can never
  // get this far; a currency with no minor digits would need it collapsed.
  return scale;
}

// Exported for sibling modules. Lint keeps it inside the money module and the
// indexes never re-export it. It validates on its own anyway, so a caller in
// this module cannot mint a value money() would refuse.
export function build(amount: bigint, currency: FiatCurrencyCode, scale: number): Money {
  const code = parseFiatCurrency(currency);
  const normalScale = parseFiatScale(scale, code);
  // The range check uses < and >, which compare a number or a string with a
  // bigint without throwing, so the type has to be checked on its own.
  const value: unknown = amount;
  if (typeof value !== 'bigint') {
    throw new InvalidAmountError('money amount must be a bigint');
  }
  return Object.freeze({
    kind: 'fiat',
    amount: checked(value),
    currency: code,
    scale: normalScale,
  });
}

/** Token counterpart of build: validates the pair and takes the scale from the token table. */
export function buildToken(amount: bigint, asset: TokenAsset, chain: Chain): TokenAmount {
  const token = settlementToken(asset, chain);
  const value: unknown = amount;
  if (typeof value !== 'bigint') {
    throw new InvalidAmountError('token amount must be a bigint');
  }
  return Object.freeze({
    kind: 'token',
    amount: checked(value),
    asset: token.asset,
    chain: token.chain,
    scale: token.tokenScale,
  });
}

/**
 * Fiat money at the currency's ISO minor unit, so `money('1230', 'USD')` is
 * 12.30 dollars. Use moneyAt for a finer working scale. A third argument is
 * refused rather than ignored, so a call written for an older signature
 * fails loudly instead of building at the wrong scale.
 */
export function money(amount: bigint | string, currency: FiatCurrencyCode): Money;
export function money(
  amount: bigint | string,
  currency: FiatCurrencyCode,
  ...unexpected: readonly unknown[]
): Money {
  const parsed = parseAmount(amount);
  const code = parseFiatCurrency(currency);
  if (unexpected.length !== 0) {
    throw new InvalidScaleError('money takes no scale; use moneyAt for a finer scale');
  }
  return build(rangeChecked(parsed), code, minorUnits(code));
}

/**
 * Fiat money at an explicit scale from the currency's minor unit up to
 * MAX_SCALE, for example limits held at 10^-6 USD. A coarser scale throws
 * InvalidScaleError. Validation order: amount, currency, scale, range.
 */
export function moneyAt(amount: bigint | string, currency: FiatCurrencyCode, scale: number): Money {
  const parsed = parseAmount(amount);
  const code = parseFiatCurrency(currency);
  const normalScale = parseFiatScale(scale, code);
  return build(rangeChecked(parsed), code, normalScale);
}

/**
 * A token amount in raw on-chain units, at the token's decimals on `chain`:
 * `tokenAmount('1234567', 'USDC', 'stellar')` is 0.1234567 USDC. An asset and
 * chain pair outside the settlement table throws UnknownCurrencyError, and a
 * fourth argument throws InvalidScaleError. Validation order: amount, asset
 * and chain, range.
 */
export function tokenAmount(amount: bigint | string, asset: TokenAsset, chain: Chain): TokenAmount;
export function tokenAmount(
  amount: bigint | string,
  asset: TokenAsset,
  chain: Chain,
  ...unexpected: readonly unknown[]
): TokenAmount {
  const parsed = parseAmount(amount);
  const token = settlementToken(asset, chain);
  // A token's scale is never an argument, so one passed anyway is refused.
  if (unexpected.length !== 0) {
    throw new InvalidScaleError('a token amount takes its scale from the token table');
  }
  return buildToken(rangeChecked(parsed), token.asset, token.chain);
}

/** A value from a snapshot: validated, unfrozen, never handed to callers. */
type Unit = Money | TokenAmount;

/**
 * Operands can be rows from a mapper or anything an untyped caller passes,
 * and a getter can answer differently on every read. So each field is read
 * exactly once, validated like the constructors do, and only this copy is
 * used. `kind` is read first and decides which fields follow.
 */
export function snapshot(value: Money): Money;
export function snapshot(value: TokenAmount): TokenAmount;
export function snapshot(value: Money | TokenAmount): Money | TokenAmount;
export function snapshot(value: Money | TokenAmount): Money | TokenAmount {
  const candidate: unknown = value;
  // A plain record only, and only its own fields, so a polluted or custom
  // prototype can never supply a field the caller did not set.
  if (!isPlainRecord(candidate)) {
    throw new InvalidAmountError('expected a plain money or token amount');
  }
  const kind = readOwnField(candidate, 'kind');
  if (kind === 'fiat') {
    const amount = readOwnField(candidate, 'amount');
    const currency = readOwnField(candidate, 'currency');
    const scale = readOwnField(candidate, 'scale');
    if (typeof amount !== 'bigint') {
      throw new InvalidAmountError('money amount must be a bigint');
    }
    const code = parseFiatCurrency(currency);
    const normalScale = parseFiatScale(scale, code);
    return { kind: 'fiat', amount: checked(amount), currency: code, scale: normalScale };
  }
  if (kind === 'token') {
    const amount = readOwnField(candidate, 'amount');
    const asset = readOwnField(candidate, 'asset');
    const chain = readOwnField(candidate, 'chain');
    const scale = readOwnField(candidate, 'scale');
    if (typeof amount !== 'bigint') {
      throw new InvalidAmountError('token amount must be a bigint');
    }
    const token = settlementToken(asset as string, chain as string);
    // A row whose scale disagrees with the token table is mis-decoded, not
    // a value at some other precision.
    if (scale !== token.tokenScale) {
      throw new InvalidScaleError('token scale must match the token table');
    }
    return {
      kind: 'token',
      amount: checked(amount),
      asset: token.asset,
      chain: token.chain,
      scale: token.tokenScale,
    };
  }
  throw new InvalidAmountError('expected a money or token amount');
}

/** Snapshot that also requires fiat, for functions that only make sense for fiat. */
export function snapshotFiat(value: Money): Money {
  const unit = snapshot(value as Money | TokenAmount);
  if (unit.kind !== 'fiat') {
    throw new KindMismatchError('expected fiat money, got a token amount');
  }
  return unit;
}

/** Snapshot that also requires a token amount. */
export function snapshotToken(value: TokenAmount): TokenAmount {
  const unit = snapshot(value as Money | TokenAmount);
  if (unit.kind !== 'token') {
    throw new KindMismatchError('expected a token amount, got fiat money');
  }
  return unit;
}

/** A frozen value of the same unit as `unit` holding `amount`. */
export function withAmount(unit: Money, amount: bigint): Money;
export function withAmount(unit: TokenAmount, amount: bigint): TokenAmount;
export function withAmount(unit: Unit, amount: bigint): Unit;
export function withAmount(unit: Unit, amount: bigint): Unit {
  return unit.kind === 'fiat'
    ? build(amount, unit.currency, unit.scale)
    : buildToken(amount, unit.asset, unit.chain);
}

// Only ever called on validated snapshots, so the text it interpolates is a
// known code, a chain name or a small integer, never caller supplied. The
// kind is checked first so the error names the real problem.
function assertSameUnit(a: Unit, b: Unit): void {
  if (a.kind === 'fiat' && b.kind === 'fiat') {
    if (a.currency !== b.currency) {
      throw new CurrencyMismatchError(`cannot combine ${a.currency} with ${b.currency}`);
    }
    if (a.scale !== b.scale) {
      throw new ScaleMismatchError(
        `cannot combine ${a.currency} at scale ${String(a.scale)} with scale ${String(b.scale)}`,
      );
    }
    return;
  }
  if (a.kind === 'token' && b.kind === 'token') {
    // One asset on one chain today, so the types say these always match.
    // Read as plain strings, the check still guards a second token or chain
    // the moment the table gains one.
    const [assetA, assetB, chainA, chainB]: string[] = [a.asset, b.asset, a.chain, b.chain];
    if (assetA !== assetB || chainA !== chainB) {
      throw new TokenMismatchError(
        `cannot combine ${a.asset} on ${a.chain} with ${b.asset} on ${b.chain}`,
      );
    }
    return;
  }
  throw new KindMismatchError('cannot combine fiat money with a token amount');
}

function pair(a: Unit, b: Unit): [Unit, Unit] {
  const x = snapshot(a);
  const y = snapshot(b);
  assertSameUnit(x, y);
  return [x, y];
}

export function add(a: Money, b: Money): Money;
export function add(a: TokenAmount, b: TokenAmount): TokenAmount;
export function add(a: Unit, b: Unit): Unit {
  const [x, y] = pair(a, b);
  return withAmount(x, x.amount + y.amount);
}

export function subtract(a: Money, b: Money): Money;
export function subtract(a: TokenAmount, b: TokenAmount): TokenAmount;
export function subtract(a: Unit, b: Unit): Unit {
  const [x, y] = pair(a, b);
  return withAmount(x, x.amount - y.amount);
}

export function multiply(a: Money, factor: bigint): Money;
export function multiply(a: TokenAmount, factor: bigint): TokenAmount;
export function multiply(a: Unit, factor: bigint): Unit {
  const x = snapshot(a);
  const k: unknown = factor;
  if (typeof k !== 'bigint') {
    throw new InvalidAmountError('factor must be a bigint');
  }
  return withAmount(x, x.amount * k);
}

export function negate(a: Money): Money;
export function negate(a: TokenAmount): TokenAmount;
export function negate(a: Unit): Unit {
  const x = snapshot(a);
  return withAmount(x, -x.amount);
}

export function sum(items: readonly Money[]): Money;
export function sum(items: readonly TokenAmount[]): TokenAmount;
export function sum(items: readonly Unit[]): Unit {
  const list: unknown = items;
  if (!Array.isArray(list)) {
    throw new InvalidAmountError('sum expects an array of money values');
  }
  let total: Unit | undefined;
  // A hole is read as missing rather than through Array.prototype, so it
  // fails validation like null does even if that prototype is polluted.
  for (const index of list.keys()) {
    const item: unknown = Object.hasOwn(list, index)
      ? (list as readonly unknown[])[index]
      : undefined;
    const next = snapshot(item as Unit);
    if (total === undefined) {
      total = next;
      continue;
    }
    assertSameUnit(total, next);
    // Checking after every step matches repeated add, so a total that would
    // dip out of range and come back still throws.
    total = { ...total, amount: checked(total.amount + next.amount) };
  }
  if (total === undefined) {
    throw new InvalidAmountError('cannot sum an empty list, its currency is unknown');
  }
  return withAmount(total, total.amount);
}

export function compare(a: Money, b: Money): -1 | 0 | 1;
export function compare(a: TokenAmount, b: TokenAmount): -1 | 0 | 1;
export function compare(a: Unit, b: Unit): -1 | 0 | 1 {
  const [x, y] = pair(a, b);
  if (x.amount < y.amount) return -1;
  return x.amount > y.amount ? 1 : 0;
}

export function equals(a: Money, b: Money): boolean;
export function equals(a: TokenAmount, b: TokenAmount): boolean;
export function equals(a: Unit, b: Unit): boolean {
  return compare(a as Money, b as Money) === 0;
}

export function isZero(a: Money | TokenAmount): boolean {
  return snapshot(a).amount === 0n;
}

export function isNegative(a: Money | TokenAmount): boolean {
  return snapshot(a).amount < 0n;
}
