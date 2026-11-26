// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The API contract for formatMoney is documented at the top of parse.test.ts.
// Expected strings come from the ICU data in the pinned Node release (see
// .nvmrc); U+00A0 and U+202F spaces are written as escapes so they are visible.

import { describe, expect, it } from 'vitest';

import { formatMoney, formatTokenAmount } from './format.js';
import * as moneyIndex from './index.js';
import {
  InvalidAmountError,
  InvalidScaleError,
  KindMismatchError,
  MoneyOverflowError,
  UnknownCurrencyError,
  money,
  moneyAt,
  tokenAmount,
} from './index.js';
import type { FiatCurrencyCode, MoneyError } from './index.js';

const MAX = 2n ** 127n - 1n;
const MIN = -(2n ** 127n);
const NBSP = '\u00a0';
// Display output uses the true minus sign in every locale.
const MINUS = '\u2212';

type ErrorClass = abstract new (message?: string) => MoneyError;
const exported = (name: string): ErrorClass =>
  (moneyIndex as Record<string, unknown>)[name] as ErrorClass;
const InvalidRoundingModeError = exported('InvalidRoundingModeError');
const InvalidLocaleError = exported('InvalidLocaleError');

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

function expectMoneyError(run: () => unknown, Expected: ErrorClass): MoneyError {
  const err = thrown(run);
  expect(Expected).toBeTypeOf('function');
  expect(err).toBeInstanceOf(Expected);
  return err as MoneyError;
}

/** Groups an unsigned digit string in threes with commas, the en-US way. */
function group(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

describe('formatMoney acceptance', () => {
  it('12345670 USDC units at Stellar scale 7 format as 1.23 in en-US', () => {
    expect(
      formatTokenAmount(tokenAmount(12_345_670n, 'USDC', 'stellar'), { locale: 'en-US' }),
    ).toBe(`1.23${NBSP}USDC`);
  });

  it('9007199254740993.01 USD formats without precision loss', () => {
    // 2^53 + 1 cannot be held by a number; it would print as ...992.
    expect(formatMoney(money(900719925474099301n, 'USD'), { locale: 'en-US' })).toBe(
      '$9,007,199,254,740,993.01',
    );
  });

  it('formats NGN in en-NG, KES in en-KE and BRL in pt-BR', () => {
    expect(formatMoney(money(2_000_000n, 'NGN'), { locale: 'en-NG' })).toBe('₦20,000.00');
    expect(formatMoney(money(150_000n, 'KES'), { locale: 'en-KE' })).toBe(`KSh${NBSP}1,500.00`);
    expect(formatMoney(money(123_456n, 'BRL'), { locale: 'pt-BR' })).toBe(`R$${NBSP}1.234,56`);
  });
});

describe('brand symbols in each home locale', () => {
  const cases: [FiatCurrencyCode, string, string][] = [
    ['NGN', 'en-NG', '₦1,234,567.89'],
    ['KES', 'en-KE', `KSh${NBSP}1,234,567.89`],
    ['GHS', 'en-GH', 'GH₵1,234,567.89'],
    ['ZAR', 'en-ZA', `R${NBSP}1${NBSP}234${NBSP}567,89`],
    ['PHP', 'en-PH', '₱1,234,567.89'],
    ['INR', 'en-IN', '₹12,34,567.89'],
    ['BRL', 'pt-BR', `R$${NBSP}1.234.567,89`],
    ['COP', 'es-CO', `$${NBSP}1.234.567,89`],
    ['MXN', 'es-MX', '$1,234,567.89'],
    ['USD', 'en-US', '$1,234,567.89'],
    ['EUR', 'de-DE', `1.234.567,89${NBSP}€`],
    ['GBP', 'en-GB', '£1,234,567.89'],
  ];

  it.each(cases)('%s in %s is %s', (currency, locale, expected) => {
    expect(formatMoney(money(123_456_789n, currency), { locale })).toBe(expected);
  });

  it('keeps the brand symbol outside the home locale', () => {
    expect(formatMoney(money(100n, 'NGN'), { locale: 'en-US' })).toBe('₦1.00');
    expect(formatMoney(money(150_000n, 'KES'), { locale: 'en-US' })).toBe(`KSh${NBSP}1,500.00`);
    expect(formatMoney(money(150n, 'USD'), { locale: 'en-NG' })).toBe('$1.50');
  });

  it('shows KSh, never Ksh or KES, for a negative amount too', () => {
    const s = formatMoney(money(-150_000n, 'KES'), { locale: 'en-KE' });
    expect(s).toBe(`${MINUS}KSh${NBSP}1,500.00`);
  });
});

describe('display scale', () => {
  it('always shows two decimals for fiat, at the minor unit or any finer scale', () => {
    expect(formatMoney(money(2_000_000n, 'NGN'), { locale: 'en-NG' })).toBe('₦20,000.00');
    expect(formatMoney(moneyAt(200_000_005n, 'NGN', 4), { locale: 'en-NG' })).toBe('₦20,000.00');
    expect(formatMoney(moneyAt(500_000n, 'USD', 6), { locale: 'en-US' })).toBe('$0.50');
  });

  it('rounds half-even by default', () => {
    expect(formatMoney(moneyAt(1005n, 'USD', 3), { locale: 'en-US' })).toBe('$1.00');
    expect(formatMoney(moneyAt(1015n, 'USD', 3), { locale: 'en-US' })).toBe('$1.02');
    expect(
      formatTokenAmount(tokenAmount(12_250_000n, 'USDC', 'stellar'), { locale: 'en-US' }),
    ).toBe(`1.22${NBSP}USDC`);
  });

  it('applies an explicit rounding mode', () => {
    const m = moneyAt(200_000_005n, 'NGN', 4);
    expect(formatMoney(m, { locale: 'en-NG', rounding: 'ceil' })).toBe('₦20,000.01');
    expect(formatMoney(m, { locale: 'en-NG', rounding: 'floor' })).toBe('₦20,000.00');
    expect(formatMoney(moneyAt(1005n, 'USD', 3), { locale: 'en-US', rounding: 'half-up' })).toBe(
      '$1.01',
    );
    expect(
      formatTokenAmount(tokenAmount(12_345_670n, 'USDC', 'stellar'), {
        locale: 'en-US',
        rounding: 'ceil',
      }),
    ).toBe(`1.24${NBSP}USDC`);
  });

  it('formats Stellar USDC at scale 7, large amounts included', () => {
    expect(
      formatTokenAmount(tokenAmount(12_345_678n, 'USDC', 'stellar'), { locale: 'en-US' }),
    ).toBe(`1.23${NBSP}USDC`);
    const large = tokenAmount(12_340_050_000n, 'USDC', 'stellar');
    expect(formatTokenAmount(large, { locale: 'en-US' })).toBe(`1,234.00${NBSP}USDC`);
    expect(formatTokenAmount(large, { locale: 'en-US', rounding: 'half-up' })).toBe(
      `1,234.01${NBSP}USDC`,
    );
  });

  it('groups token amounts the locale way', () => {
    expect(
      formatTokenAmount(tokenAmount(12_345_678_900_000n, 'USDC', 'stellar'), { locale: 'pt-BR' }),
    ).toBe(`1.234.567,89${NBSP}USDC`);
  });
});

describe('signs and extremes', () => {
  it('prints a negative amount with a minus sign', () => {
    expect(formatMoney(money(-150n, 'USD'), { locale: 'en-US' })).toBe(`${MINUS}$1.50`);
  });

  it('never prints a negative zero', () => {
    expect(formatMoney(moneyAt(-4n, 'USD', 3), { locale: 'en-US' })).toBe('$0.00');
    expect(formatMoney(moneyAt(-5n, 'USD', 3), { locale: 'en-US' })).toBe('$0.00');
    expect(formatTokenAmount(tokenAmount(-1n, 'USDC', 'stellar'), { locale: 'en-US' })).toBe(
      `0.00${NBSP}USDC`,
    );
    expect(formatMoney(moneyAt(-5n, 'USD', 3), { locale: 'en-US', rounding: 'half-up' })).toBe(
      `${MINUS}$0.01`,
    );
  });

  it('keeps every digit of I128_MAX and I128_MIN', () => {
    const maxDigits = MAX.toString();
    const minDigits = (-MIN).toString();
    expect(formatMoney(money(MAX, 'USD'), { locale: 'en-US' })).toBe(
      `$${group(maxDigits.slice(0, -2))}.${maxDigits.slice(-2)}`,
    );
    expect(formatMoney(money(MIN, 'USD'), { locale: 'en-US' })).toBe(
      `${MINUS}$${group(minDigits.slice(0, -2))}.${minDigits.slice(-2)}`,
    );
    // At the widest working scale the digits past cents are rounded away.
    const cents = (MAX / 10n ** 16n).toString();
    expect(formatMoney(moneyAt(MAX, 'USD', 18), { locale: 'en-US', rounding: 'floor' })).toBe(
      `$${group(cents.slice(0, -2))}.${cents.slice(-2)}`,
    );
  });
});

describe('digits are always ASCII', () => {
  it.each(['ar-EG', 'en-US-u-nu-arab', 'hi-IN-u-nu-deva', 'fa-IR', 'bn-BD'])(
    'uses latn digits in %s',
    (locale) => {
      const s = formatMoney(money(123_456_789n, 'NGN'), { locale });
      expect(s.replace(/[0-9]/g, '')).not.toMatch(/\p{Nd}/u);
      expect(s).toContain('567');
      expect(s).toContain('₦');
    },
  );
});

describe('formatMoney rejects bad input', () => {
  it('rejects missing or malformed options and locales', () => {
    const m = money(100n, 'USD');
    const bad: unknown[] = [
      undefined,
      null,
      'en-US',
      {},
      { locale: undefined },
      { locale: null },
      { locale: 1 },
      { locale: ['en-US'] },
      { locale: Object('en-US') as unknown },
      { locale: '' },
      { locale: '!!' },
      { locale: 'en_US' },
      { locale: 'en-US\n' },
    ];
    for (const options of bad) {
      expectMoneyError(() => formatMoney(m, loose(options)), InvalidLocaleError);
    }
  });

  it('never calls toString on a locale and keeps it out of the message', () => {
    const calls: string[] = [];
    const hostile = {
      toString() {
        calls.push('toString');
        return 'en-US';
      },
      [Symbol.toPrimitive]() {
        calls.push('toPrimitive');
        return 'en-US';
      },
    };
    expectMoneyError(
      () => formatMoney(money(1n, 'USD'), loose({ locale: hostile })),
      InvalidLocaleError,
    );
    expect(calls).toEqual([]);
    const err = expectMoneyError(
      () => formatMoney(money(1n, 'USD'), { locale: 'x\nlevel=info msg=paid' }),
      InvalidLocaleError,
    );
    expect(err.message).not.toContain('msg=paid');
    expect(err.message.length).toBeLessThanOrEqual(200);
    expect(err.message).not.toMatch(/[\r\n]/);
  });

  it('rejects a bad rounding mode after the locale', () => {
    const m = money(100n, 'USD');
    for (const rounding of [null, 'HALF_EVEN', 'round', '', 0]) {
      expectMoneyError(
        () => formatMoney(m, loose({ locale: 'en-US', rounding })),
        InvalidRoundingModeError,
      );
    }
    expectMoneyError(
      () => formatMoney(m, loose({ locale: '!!', rounding: 'bogus' })),
      InvalidLocaleError,
    );
  });

  const forged: [string, unknown, ErrorClass][] = [
    ['null', null, InvalidAmountError],
    ['a number amount', { kind: 'fiat', amount: 1, currency: 'USD', scale: 2 }, InvalidAmountError],
    [
      'an unknown currency',
      { kind: 'fiat', amount: 1n, currency: 'BTC', scale: 2 },
      UnknownCurrencyError,
    ],
    [
      'a negative scale',
      { kind: 'fiat', amount: 1n, currency: 'USD', scale: -1 },
      InvalidScaleError,
    ],
    [
      'an out of range amount',
      { kind: 'fiat', amount: MAX + 1n, currency: 'USD', scale: 2 },
      MoneyOverflowError,
    ],
  ];

  it.each(forged)('rejects a forged operand with %s before the options', (_l, value, Expected) => {
    expectMoneyError(() => formatMoney(loose(value), { locale: 'en-US' }), Expected);
    expectMoneyError(() => formatMoney(loose(value), loose(null)), Expected);
  });

  it('reads each operand field and each option once', () => {
    const reads = { kind: 0, amount: 0, currency: 0, scale: 0, locale: 0, rounding: 0 };
    const answers: Record<keyof typeof reads, unknown[]> = {
      kind: ['fiat', 'token'],
      amount: [123_456n, 1n],
      currency: ['KES', 'BTC'],
      scale: [2, 19],
      locale: ['en-KE', '!!'],
      rounding: ['half-even', 'bogus'],
    };
    const counted = (keys: (keyof typeof reads)[]): unknown =>
      new Proxy(Object.fromEntries(keys.map((name) => [name, undefined])), {
        get(_target, key) {
          const k = keys.find((name) => name === key);
          if (k === undefined) return undefined;
          reads[k] += 1;
          const list = answers[k];
          return list[Math.min(reads[k], list.length) - 1];
        },
      });
    const value = counted(['kind', 'amount', 'currency', 'scale']);
    const options = counted(['locale', 'rounding']);
    expect(formatMoney(loose(value), loose(options))).toBe(`KSh${NBSP}1,234.56`);
    for (const n of Object.values(reads)) expect(n).toBeLessThanOrEqual(1);
  });

  it('is deterministic and does not mutate its input', () => {
    const m = money(123_456_789n, 'GHS');
    const a = formatMoney(m, { locale: 'en-GH' });
    const b = formatMoney(m, { locale: 'en-GH' });
    expect(a).toBe(b);
    expect(m).toEqual(money(123_456_789n, 'GHS'));
  });
});

describe('fiat and token formatting stay apart', () => {
  it('formatMoney refuses a token amount before reading the options', () => {
    expectMoneyError(
      () => formatMoney(loose(tokenAmount(12_345_670n, 'USDC', 'stellar')), { locale: 'en-US' }),
      KindMismatchError,
    );
    expectMoneyError(
      () => formatMoney(loose(tokenAmount(1n, 'USDC', 'stellar')), loose(null)),
      KindMismatchError,
    );
  });

  it('formatTokenAmount refuses fiat money before reading the options', () => {
    expectMoneyError(
      () => formatTokenAmount(loose(money(150n, 'USD')), { locale: 'en-US' }),
      KindMismatchError,
    );
  });

  it('formatTokenAmount never shows the chain, only the asset code', () => {
    const shown = formatTokenAmount(tokenAmount(12_345_670n, 'USDC', 'stellar'), {
      locale: 'en-US',
    });
    expect(shown).toBe(`1.23${NBSP}USDC`);
    expect(shown.toLowerCase()).not.toContain('stellar');
  });

  it('formatTokenAmount validates the locale and the rounding like formatMoney', () => {
    const t = tokenAmount(1n, 'USDC', 'stellar');
    for (const options of [undefined, null, {}, { locale: '!!' }, { locale: 'x'.repeat(65) }]) {
      expectMoneyError(() => formatTokenAmount(t, loose(options)), InvalidLocaleError);
    }
    expectMoneyError(
      () => formatTokenAmount(t, loose({ locale: 'en-US', rounding: 'round' })),
      InvalidRoundingModeError,
    );
  });

  it('formatTokenAmount rejects a forged token whose scale disagrees with the table', () => {
    const forged = loose({ kind: 'token', amount: 1n, asset: 'USDC', chain: 'stellar', scale: 6 });
    expectMoneyError(() => formatTokenAmount(forged, { locale: 'en-US' }), InvalidScaleError);
  });
});

// The currencyCode option and its contract are documented in dollar-sign.test.ts.
describe('currency code for ambiguous dollar signs', () => {
  const InvalidFormatOptionError = exported('InvalidFormatOptionError');
  const ambiguous = { currencyCode: 'whenAmbiguous' } as const;

  it('COP and MXN show their code when ambiguous', () => {
    expect(formatMoney(money(150_000n, 'COP'), { locale: 'en-US', ...ambiguous })).toBe(
      `$1,500.00${NBSP}COP`,
    );
    expect(formatMoney(money(150_000n, 'MXN'), { locale: 'es-MX', ...ambiguous })).toBe(
      `$1,500.00${NBSP}MXN`,
    );
    expect(formatMoney(money(150_000n, 'USD'), { locale: 'en-US', ...ambiguous })).toBe(
      `$1,500.00${NBSP}USD`,
    );
    expect(formatMoney(money(123_456n, 'COP'), { locale: 'es-CO', ...ambiguous })).toBe(
      `$${NBSP}1.234,56${NBSP}COP`,
    );
  });

  it('NGN and USDC are unchanged when ambiguous', () => {
    expect(formatMoney(money(2_000_000n, 'NGN'), { locale: 'en-NG', ...ambiguous })).toBe(
      '₦20,000.00',
    );
    // Tokens format with formatTokenAmount, which never takes the option.
    expect(
      formatTokenAmount(
        tokenAmount(12_345_670n, 'USDC', 'stellar'),
        loose({ locale: 'en-US', ...ambiguous }),
      ),
    ).toBe(`1.23${NBSP}USDC`);
    for (const currency of ['KES', 'GHS', 'ZAR', 'PHP', 'INR', 'BRL', 'EUR', 'GBP'] as const) {
      const m = money(123_456n, currency);
      expect(formatMoney(m, { locale: 'en-US', ...ambiguous })).toBe(
        formatMoney(m, { locale: 'en-US' }),
      );
    }
    const large = tokenAmount(12_340_000_000n, 'USDC', 'stellar');
    expect(formatTokenAmount(large, loose({ locale: 'en-US', ...ambiguous }))).toBe(
      formatTokenAmount(large, { locale: 'en-US' }),
    );
  });

  it('never appends the code by default or with never', () => {
    const cop = money(150_000n, 'COP');
    expect(formatMoney(cop, { locale: 'en-US' })).toBe('$1,500.00');
    expect(formatMoney(cop, { locale: 'en-US', currencyCode: 'never' })).toBe('$1,500.00');
  });

  it('appends the code after a negative amount and with any rounding', () => {
    expect(formatMoney(money(-150n, 'USD'), { locale: 'en-US', ...ambiguous })).toBe(
      `${MINUS}$1.50${NBSP}USD`,
    );
    expect(
      formatMoney(moneyAt(1005n, 'MXN', 3), { locale: 'en-US', rounding: 'ceil', ...ambiguous }),
    ).toBe(`$1.01${NBSP}MXN`);
  });

  it('rejects any other currencyCode after the locale and rounding checks', () => {
    const m = money(100n, 'USD');
    const values: unknown[] = ['always', 'WHEN_AMBIGUOUS', '', null, true, 1, Object('never')];
    for (const currencyCode of values) {
      expectMoneyError(
        () => formatMoney(m, loose({ locale: 'en-US', currencyCode })),
        InvalidFormatOptionError,
      );
    }
    expectMoneyError(
      () => formatMoney(m, loose({ locale: '!!', currencyCode: 'bogus' })),
      InvalidLocaleError,
    );
    expectMoneyError(
      () => formatMoney(m, loose({ locale: 'en-US', rounding: 'bogus', currencyCode: 'bogus' })),
      InvalidRoundingModeError,
    );
  });

  it('reads currencyCode at most once', () => {
    let reads = 0;
    const answers: unknown[] = ['whenAmbiguous', 'bogus'];
    const options = {
      locale: 'en-US',
      get currencyCode() {
        reads += 1;
        return answers[Math.min(reads, answers.length) - 1];
      },
    };
    expect(formatMoney(money(150n, 'COP'), loose(options))).toBe(`$1.50${NBSP}COP`);
    expect(reads).toBeLessThanOrEqual(1);
  });

  it('reads currencyCode only from a plain options object', () => {
    const cop = money(150n, 'COP');
    const inherited = Object.create({ locale: 'en-US', currencyCode: 'whenAmbiguous' }) as object;
    expectMoneyError(() => formatMoney(cop, loose(inherited)), InvalidLocaleError);
    const bare = Object.assign(Object.create(null) as object, {
      locale: 'en-US',
      currencyCode: 'whenAmbiguous',
    });
    expect(formatMoney(cop, loose(bare))).toBe(`$1.50${NBSP}COP`);
  });

  it('ignores a currencyCode inherited from Object.prototype', () => {
    const proto = Object.prototype as Record<string, unknown>;
    proto['currencyCode'] = 'whenAmbiguous';
    try {
      expect(formatMoney(money(150n, 'COP'), { locale: 'en-US' })).toBe('$1.50');
    } finally {
      delete proto['currencyCode'];
    }
  });
});
