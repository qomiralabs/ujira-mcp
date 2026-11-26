// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

/*
 * Contract for telling dollar sign currencies apart (format.ts, exported from
 * ./index.js).
 *
 * Several fiat currencies print with the same "$" brand symbol: USD, COP and
 * MXN. Tokens print with their asset code and never use "$".
 *
 * dollarSignAmbiguous(currencies: readonly (FiatCurrencyCode | TokenAsset)[]): boolean
 *   True when the set holds two or more distinct fiat currencies whose
 *   symbol is "$". Duplicates count once and order does not matter. Tokens
 *   and other fiat currencies never count. Principal views pass the
 *   currencies of the principal's corridors, so filtering a table never
 *   changes how amounts are formatted.
 *   currencies must be an array (InvalidFormatOptionError otherwise), and
 *   every entry must be a known currency code, holes included
 *   (UnknownCurrencyError otherwise). Each entry is read once and no entry
 *   has toString called on it.
 *
 * formatMoney(m, { locale, rounding?, currencyCode? })
 *   currencyCode is 'never' (the default, today's output exactly) or
 *   'whenAmbiguous'. With 'whenAmbiguous', a fiat amount whose symbol is "$"
 *   is followed by U+00A0 and its ISO code, for example "$1,500.00 COP" with
 *   a no break space. Other fiat currencies and tokens are unchanged.
 *   Recipient views never pass it. Any other value throws
 *   InvalidFormatOptionError (code 'INVALID_FORMAT_OPTION'), after the locale
 *   and rounding checks. options.currencyCode is read at most once, and a
 *   value inherited from Object.prototype is ignored.
 */

import { describe, expect, it } from 'vitest';

import * as root from '../index.js';
import * as moneyIndex from './index.js';
import { MoneyError, UnknownCurrencyError } from './index.js';
import type { FiatCurrencyCode, TokenAsset } from './index.js';

type CurrencyCode = FiatCurrencyCode | TokenAsset;

type ErrorClass = abstract new (message?: string) => MoneyError;
const index = moneyIndex as Record<string, unknown>;
const InvalidFormatOptionError = index['InvalidFormatOptionError'] as ErrorClass;
const dollarSignAmbiguous = index['dollarSignAmbiguous'] as (
  currencies: readonly CurrencyCode[],
) => boolean;

function loose(value: unknown): never {
  return value as never;
}

function thrown(run: () => unknown): unknown {
  try {
    run();
  } catch (err) {
    return err;
  }
  return undefined;
}

describe('exports', () => {
  it('exposes dollarSignAmbiguous and InvalidFormatOptionError from the index only', () => {
    expect(dollarSignAmbiguous).toBeTypeOf('function');
    expect((root as Record<string, unknown>)['dollarSignAmbiguous']).toBeUndefined();
    expect(InvalidFormatOptionError).toBeTypeOf('function');
    expect((root as Record<string, unknown>)['InvalidFormatOptionError']).toBeUndefined();
  });

  it('gives InvalidFormatOptionError a stable name and code', () => {
    const Ctor = InvalidFormatOptionError as unknown as new (message?: string) => MoneyError;
    const err = new Ctor('boom');
    expect(err).toBeInstanceOf(MoneyError);
    expect(err.name).toBe('InvalidFormatOptionError');
    expect(err.code).toBe('INVALID_FORMAT_OPTION');
  });
});

describe('dollarSignAmbiguous', () => {
  const table: [string, CurrencyCode[], boolean][] = [
    ['USD only', ['USD'], false],
    ['USD and COP', ['USD', 'COP'], true],
    ['NGN and KES', ['NGN', 'KES'], false],
    ['USD and USDC', ['USD', 'USDC'], false],
    ['COP and MXN', ['COP', 'MXN'], true],
    ['USD, COP and MXN', ['USD', 'COP', 'MXN'], true],
    ['MXN and a token', ['MXN', 'USDC'], false],
    ['USD twice', ['USD', 'USD'], false],
    ['USD and COP in any order with others', ['NGN', 'COP', 'USDC', 'USD'], true],
    ['an empty set', [], false],
    [
      'every fiat but one dollar',
      ['NGN', 'KES', 'GHS', 'ZAR', 'PHP', 'INR', 'BRL', 'EUR', 'GBP', 'USD'],
      false,
    ],
  ];

  it.each(table)('%s gives %s', (_label, currencies, expected) => {
    expect(dollarSignAmbiguous(currencies)).toBe(expected);
  });

  it('does not mutate its input', () => {
    const currencies: CurrencyCode[] = ['USD', 'COP'];
    dollarSignAmbiguous(currencies);
    expect(currencies).toEqual(['USD', 'COP']);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'USD,COP'],
    ['a Set', new Set(['USD', 'COP'])],
    ['an array like object', { length: 2, 0: 'USD', 1: 'COP' }],
  ])('throws InvalidFormatOptionError when currencies is %s', (_label, currencies) => {
    expect(thrown(() => dollarSignAmbiguous(loose(currencies)))).toBeInstanceOf(
      InvalidFormatOptionError,
    );
  });

  it.each([
    ['an unknown code', ['USD', 'XXX']],
    ['a lower case code', ['usd', 'COP']],
    ['a number', ['USD', 840]],
    ['null', ['USD', null]],
    ['a hole', new Array<unknown>(2).fill('USD', 0, 1)],
  ])('throws UnknownCurrencyError for %s in the set', (_label, currencies) => {
    expect(thrown(() => dollarSignAmbiguous(loose(currencies)))).toBeInstanceOf(
      UnknownCurrencyError,
    );
  });

  it('never calls toString on an entry and keeps it out of the message', () => {
    const calls: string[] = [];
    const hostile = {
      toString() {
        calls.push('toString');
        return 'USD';
      },
    };
    const err = thrown(() => dollarSignAmbiguous(loose(['COP', hostile])));
    expect(err).toBeInstanceOf(UnknownCurrencyError);
    expect(calls).toEqual([]);
    const text = thrown(() => dollarSignAmbiguous(loose(['COP', 'X\nlevel=info'])));
    expect((text as MoneyError).message).not.toContain('level=info');
  });

  it('reads each entry once', () => {
    let reads = 0;
    const proxy = new Proxy(['USD', 'COP'], {
      get(target, key, receiver) {
        if (key === '1') reads += 1;
        return Reflect.get(target, key, receiver) as unknown;
      },
    });
    expect(dollarSignAmbiguous(loose(proxy))).toBe(true);
    expect(reads).toBe(1);
  });
});
