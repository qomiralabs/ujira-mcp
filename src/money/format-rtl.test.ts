// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

/*
 * Contract for the ISO code appended with currencyCode: 'whenAmbiguous' in
 * right to left locales (format.ts).
 *
 * In a locale whose text direction is right to left (Intl.Locale text info),
 * the appended code is written as U+00A0, then U+2068 (first strong
 * isolate), the ISO code, and U+2069 (pop directional isolate). The isolate
 * keeps the Latin code from pulling the "$" and the digits around, so a
 * positive and a negative amount lay out the same way. Left to right
 * locales get exactly the output they had before: no isolate characters.
 * Nothing else changes: without the option, or for a currency that does
 * not print "$", right to left output has no isolates either.
 *
 * formatTokenAmount always shows its asset code, so in a right to left
 * locale the code is always isolated the same way: U+00A0, U+2068, the
 * asset, U+2069. The direction comes from the same lookup as fiat, with the
 * same fallbacks. Left to right token output is byte for byte what it was.
 * The fiat only currencyCode option has no effect on token amounts.
 */

import { describe, expect, it } from 'vitest';

import { formatMoney, formatTokenAmount } from './format.js';
import { money, tokenAmount } from './index.js';
import type { TokenAmount } from './index.js';

const NBSP = '\u00a0';
const FSI = '\u2068';
const PDI = '\u2069';
const MINUS = '\u2212';
const ambiguous = { currencyCode: 'whenAmbiguous' } as const;

// Bidi controls that ICU or this module may place around the number.
const BIDI_CONTROLS = /[\u200e\u200f\u061c\u2066-\u2069]/g;

describe('the appended code in right to left locales', () => {
  it.each(['ar-EG', 'ur-PK'])(
    'isolates the code for a positive and a negative COP amount in %s',
    (locale) => {
      const positive = formatMoney(money(150_000n, 'COP'), { locale, ...ambiguous });
      const negative = formatMoney(money(-150_000n, 'COP'), { locale, ...ambiguous });
      for (const s of [positive, negative]) {
        expect(s.endsWith(`${NBSP}${FSI}COP${PDI}`)).toBe(true);
        expect(s.match(/\u2068/g)).toHaveLength(1);
        expect(s.match(/\u2069/g)).toHaveLength(1);
      }
      // Same layout: the negative is the positive plus a minus sign and marks.
      expect(negative.replace(BIDI_CONTROLS, '').replace(MINUS, '')).toBe(
        positive.replace(BIDI_CONTROLS, ''),
      );
    },
  );

  it('isolates the code for every dollar currency in a right to left locale', () => {
    for (const currency of ['USD', 'COP', 'MXN'] as const) {
      const s = formatMoney(money(-150n, currency), { locale: 'he-IL', ...ambiguous });
      expect(s.endsWith(`${NBSP}${FSI}${currency}${PDI}`)).toBe(true);
    }
  });

  it('adds no isolates without the option or for a currency without "$"', () => {
    for (const locale of ['ar-EG', 'ur-PK', 'fa-IR', 'he-IL']) {
      const plain = formatMoney(money(-150_000n, 'COP'), { locale });
      expect(plain).not.toMatch(/[\u2068\u2069]/);
      const never = formatMoney(money(-150_000n, 'COP'), { locale, currencyCode: 'never' });
      expect(never).toBe(plain);
      const naira = formatMoney(money(-150_000n, 'NGN'), { locale, ...ambiguous });
      expect(naira).toBe(formatMoney(money(-150_000n, 'NGN'), { locale }));
    }
  });
});

describe('left to right output is unchanged', () => {
  it.each(['en-US', 'en-NG', 'es-CO', 'es-MX', 'pt-BR', 'de-DE', 'fr-FR'])(
    'appends the code without isolates in %s',
    (locale) => {
      for (const amount of [150_000n, -150_000n]) {
        const m = money(amount, 'COP');
        const s = formatMoney(m, { locale, ...ambiguous });
        expect(s).not.toMatch(/[\u2068\u2069]/);
        expect(s).toBe(`${formatMoney(m, { locale })}${NBSP}COP`);
      }
    },
  );

  it('keeps the exact en-US bytes', () => {
    expect(formatMoney(money(-150n, 'USD'), { locale: 'en-US', ...ambiguous })).toBe(
      `${MINUS}$1.50${NBSP}USD`,
    );
  });
});

/**
 * Runs `run` with parts of Intl.Locale.prototype removed or broken, the way
 * an engine without text info looks, and puts them back afterwards.
 */
function withLocaleApi(
  changes: {
    getTextInfo?: 'remove' | 'throw';
    textInfo?: 'remove' | 'throw';
    maximize?: 'throw';
  },
  run: () => void,
): void {
  const proto = Intl.Locale.prototype as unknown as Record<string, unknown>;
  const saved = new Map<string, PropertyDescriptor>();
  for (const key of ['getTextInfo', 'textInfo', 'maximize']) {
    const descriptor = Object.getOwnPropertyDescriptor(proto, key);
    if (descriptor !== undefined) saved.set(key, descriptor);
  }
  try {
    const broken = (): never => {
      throw new RangeError('text info is unavailable');
    };
    if (changes.getTextInfo === 'remove') delete proto['getTextInfo'];
    if (changes.getTextInfo === 'throw') {
      Object.defineProperty(proto, 'getTextInfo', { configurable: true, value: broken });
    }
    if (changes.textInfo === 'remove') delete proto['textInfo'];
    if (changes.textInfo === 'throw') {
      Object.defineProperty(proto, 'textInfo', { configurable: true, get: broken });
    }
    if (changes.maximize === 'throw') {
      Object.defineProperty(proto, 'maximize', {
        configurable: true,
        value: () => {
          throw new RangeError('maximize is unavailable');
        },
      });
    }
    run();
  } finally {
    for (const [key, descriptor] of saved) Object.defineProperty(proto, key, descriptor);
  }
}

describe('direction lookup on engines without text info', () => {
  const amounts = [150_000n, -150_000n];
  const render = (locale: string): string[] =>
    amounts.map((amount) => formatMoney(money(amount, 'COP'), { locale, ...ambiguous }));
  // ar-EG and ur-PK fall back to Arab and he-IL to Hebr, so each right to
  // left script in the fallback set that a launch locale uses is exercised.
  const LOCALES = ['ar-EG', 'ur-PK', 'he-IL', 'en-US'];
  // Taken with the full API in place, before any test changes the prototype.
  const expected = new Map(LOCALES.map((locale) => [locale, render(locale)]));

  it('finds right to left isolates in the baseline for ar-EG, ur-PK and he-IL only', () => {
    expect(expected.get('ar-EG')?.every((s) => s.includes(FSI))).toBe(true);
    expect(expected.get('ur-PK')?.every((s) => s.includes(FSI))).toBe(true);
    expect(expected.get('he-IL')?.every((s) => s.includes(FSI))).toBe(true);
    expect(expected.get('en-US')?.some((s) => s.includes(FSI))).toBe(false);
  });

  it.each(LOCALES)('gives the same output with getTextInfo removed in %s', (locale) => {
    withLocaleApi({ getTextInfo: 'remove' }, () => {
      expect(render(locale)).toEqual(expected.get(locale));
    });
    // With the script fallback broken as well, only the textInfo accessor can answer.
    withLocaleApi({ getTextInfo: 'remove', maximize: 'throw' }, () => {
      expect(render(locale)).toEqual(expected.get(locale));
    });
  });

  it.each(LOCALES)(
    'gives the same output with getTextInfo and textInfo both removed in %s',
    (locale) => {
      withLocaleApi({ getTextInfo: 'remove', textInfo: 'remove' }, () => {
        expect(render(locale)).toEqual(expected.get(locale));
      });
    },
  );

  it.each(LOCALES)(
    'falls through a throwing getTextInfo to the textInfo accessor in %s',
    (locale) => {
      withLocaleApi({ getTextInfo: 'throw', maximize: 'throw' }, () => {
        expect(render(locale)).toEqual(expected.get(locale));
      });
    },
  );

  it.each(LOCALES)(
    'falls through a throwing getTextInfo and textInfo to the script lookup in %s',
    (locale) => {
      withLocaleApi({ getTextInfo: 'throw', textInfo: 'throw' }, () => {
        expect(render(locale)).toEqual(expected.get(locale));
      });
    },
  );

  it('never throws, and falls back to plain left to right output, when nothing is available', () => {
    withLocaleApi({ getTextInfo: 'remove', textInfo: 'remove', maximize: 'throw' }, () => {
      for (const locale of LOCALES) {
        for (const s of render(locale)) expect(s).not.toMatch(/[\u2068\u2069]/);
      }
    });
  });

  it('restores the Intl.Locale API after each case', () => {
    const proto = Intl.Locale.prototype as unknown as Record<string, unknown>;
    expect(typeof proto['maximize']).toBe('function');
    expect(typeof proto['getTextInfo']).toBe('function');
    expect(Object.getOwnPropertyDescriptor(proto, 'textInfo')).toBeDefined();
  });
});

const RTL_LOCALES = ['ar-EG', 'he-IL', 'ur-PK', 'fa-IR'];
const TOKENS: [string, (amount: bigint) => TokenAmount][] = [
  ['USDC', (whole) => tokenAmount(whole * 12_345_670n, 'USDC', 'stellar')],
  ['USDC', (whole) => tokenAmount(whole * 12_345_670_000n, 'USDC', 'stellar')],
];

describe('token codes in right to left locales', () => {
  for (const locale of RTL_LOCALES) {
    it.each(TOKENS)(
      `isolates the code for a positive and a negative %s in ${locale}`,
      (asset, make) => {
        const positive = formatTokenAmount(make(1n), { locale });
        const negative = formatTokenAmount(make(-1n), { locale });
        for (const s of [positive, negative]) {
          expect(s.endsWith(`${NBSP}${FSI}${asset}${PDI}`)).toBe(true);
          expect(s.match(/\u2068/g)).toHaveLength(1);
          expect(s.match(/\u2069/g)).toHaveLength(1);
        }
        expect(negative).toContain(MINUS);
        // Same layout: the negative is the positive plus a minus sign and marks.
        expect(negative.replace(BIDI_CONTROLS, '').replace(MINUS, '')).toBe(
          positive.replace(BIDI_CONTROLS, ''),
        );
      },
    );
  }

  it('isolates the asset code and never shows the chain', () => {
    const shown = formatTokenAmount(tokenAmount(-12_345_670n, 'USDC', 'stellar'), {
      locale: 'ar-EG',
    });
    expect(shown.endsWith(`${NBSP}${FSI}USDC${PDI}`)).toBe(true);
    expect(shown.toLowerCase()).not.toContain('stellar');
  });
});

describe('left to right token output is unchanged', () => {
  it('keeps the exact bytes', () => {
    expect(
      formatTokenAmount(tokenAmount(-12_345_670n, 'USDC', 'stellar'), { locale: 'en-US' }),
    ).toBe(`${MINUS}1.23${NBSP}USDC`);
    expect(formatTokenAmount(tokenAmount(1_234_567n, 'USDC', 'stellar'), { locale: 'en-US' })).toBe(
      `0.12${NBSP}USDC`,
    );
    expect(
      formatTokenAmount(tokenAmount(-12_345_670_000n, 'USDC', 'stellar'), { locale: 'de-DE' }),
    ).toBe(`${MINUS}1.234,57${NBSP}USDC`);
    expect(
      formatTokenAmount(tokenAmount(12_345_678_900_000n, 'USDC', 'stellar'), { locale: 'fr-FR' }),
    ).toBe(`1${NBSP}234${NBSP}567,89${NBSP}USDC`);
  });

  it.each([
    'en-US',
    'en-NG',
    'en-KE',
    'pt-BR',
    'es-CO',
    'de-DE',
    'fr-FR',
    'sv-SE',
    'bn-BD',
    'my-MM',
  ])('adds no isolate characters in %s', (locale) => {
    for (const [asset, make] of TOKENS) {
      for (const sign of [1n, -1n]) {
        const s = formatTokenAmount(make(sign), { locale });
        expect(s).not.toMatch(/[\u2066-\u2069]/);
        expect(s.endsWith(`${NBSP}${asset}`)).toBe(true);
      }
    }
  });
});

describe('token direction uses the fiat lookup and its fallbacks', () => {
  const renderToken = (locale: string): string[] =>
    [1n, -1n].map((sign) =>
      formatTokenAmount(tokenAmount(sign * 12_345_670n, 'USDC', 'stellar'), { locale }),
    );
  const LOCALES = ['ar-EG', 'he-IL', 'en-US'];
  const expected = new Map(LOCALES.map((locale) => [locale, renderToken(locale)]));

  it.each(LOCALES)('gives the same output from each fallback in %s', (locale) => {
    withLocaleApi({ getTextInfo: 'remove' }, () => {
      expect(renderToken(locale)).toEqual(expected.get(locale));
    });
    withLocaleApi({ getTextInfo: 'remove', textInfo: 'remove' }, () => {
      expect(renderToken(locale)).toEqual(expected.get(locale));
    });
    withLocaleApi({ getTextInfo: 'throw', textInfo: 'throw' }, () => {
      expect(renderToken(locale)).toEqual(expected.get(locale));
    });
  });

  it('agrees with fiat about which locales are right to left', () => {
    for (const locale of [...RTL_LOCALES, 'en-US', 'de-DE']) {
      const fiat = formatMoney(money(-150n, 'USD'), { locale, ...ambiguous }).includes(FSI);
      const token = formatTokenAmount(tokenAmount(-1n, 'USDC', 'stellar'), { locale }).includes(
        FSI,
      );
      expect(token).toBe(fiat);
    }
  });

  it('falls back to plain left to right output when nothing is available', () => {
    withLocaleApi({ getTextInfo: 'remove', textInfo: 'remove', maximize: 'throw' }, () => {
      for (const locale of LOCALES) {
        for (const s of renderToken(locale)) expect(s).not.toMatch(/[\u2068\u2069]/);
      }
    });
  });
});

describe('currencyCode on token amounts', () => {
  it('is ignored, whatever its value', () => {
    for (const locale of ['en-US', 'ar-EG']) {
      const token = tokenAmount(-12_345_670n, 'USDC', 'stellar');
      const plain = formatTokenAmount(token, { locale });
      for (const currencyCode of ['whenAmbiguous', 'never', 'bogus']) {
        const options = { locale, currencyCode } as unknown as { locale: string };
        expect(formatTokenAmount(token, options)).toBe(plain);
      }
    }
  });
});
