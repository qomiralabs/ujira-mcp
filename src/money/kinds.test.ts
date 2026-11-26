// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// Fiat money and token amounts are separate types. Each case below is
// checked twice: the @ts-expect-error line fails typecheck if the compiler
// ever accepts the mix, and the runtime assertion proves the kind check
// still catches values that slip past the compiler (decoded rows, casts).

import { describe, expect, it } from 'vitest';

import {
  InvalidScaleError,
  KindMismatchError,
  UnknownCurrencyError,
  add,
  allocate,
  compare,
  formatMoney,
  formatTokenAmount,
  money,
  moneyAt,
  rescale,
  sum,
  toMinor,
  tokenAmount,
} from './index.js';
import type { Money, TokenAmount } from './index.js';

const usd: Money = money(1230n, 'USD');
const usdc: TokenAmount = tokenAmount(12_300_000n, 'USDC', 'stellar');

describe('the compiler and the runtime keep the kinds apart', () => {
  it('refuses to combine fiat and a token', () => {
    // @ts-expect-error fiat and token amounts never add
    expect(() => add(usd, usdc)).toThrow(KindMismatchError);
    // @ts-expect-error fiat and token amounts never compare
    expect(() => compare(usdc, usd)).toThrow(KindMismatchError);
    // @ts-expect-error a list holds one kind
    expect(() => sum([usd, usdc])).toThrow(KindMismatchError);
  });

  it('refuses tokens where only fiat makes sense', () => {
    // @ts-expect-error formatMoney takes fiat only
    expect(() => formatMoney(usdc, { locale: 'en-US' })).toThrow(KindMismatchError);
    // @ts-expect-error a token never changes scale
    expect(() => rescale(usdc, 7, 'trunc')).toThrow(KindMismatchError);
    // @ts-expect-error toMinor is for fiat working scales
    expect(() => toMinor(usdc, 'trunc')).toThrow(KindMismatchError);
  });

  it('refuses fiat where only tokens make sense', () => {
    // @ts-expect-error formatTokenAmount takes tokens only
    expect(() => formatTokenAmount(usd, { locale: 'en-US' })).toThrow(KindMismatchError);
  });

  it('refuses a scale for a token and a token code for fiat', () => {
    // @ts-expect-error a token takes its scale from the table, never an argument
    expect(() => tokenAmount(1n, 'USDC', 'stellar', 9)).toThrow(InvalidScaleError);
    // @ts-expect-error a token asset is not a fiat currency
    expect(() => moneyAt(1n, 'USDC', 6)).toThrow(UnknownCurrencyError);
  });

  it('keeps the chain on every token value', () => {
    const legs: TokenAmount[] = allocate(usdc, [1n, 1n]);
    expect(legs.map((leg) => leg.chain)).toEqual(['stellar', 'stellar']);
  });
});
