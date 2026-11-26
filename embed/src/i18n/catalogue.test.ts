// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  catalogueFor,
  DEFAULT_LOCALE,
  fill,
  flagged,
  languageOf,
  LOCALES,
  resolveLocale,
  translator,
  type MessageKey,
} from './catalogue.js';
import { DRAFT_LOCALES, DRAFTS } from './drafts/index.js';
import { en } from './en.js';

const SRC = join(import.meta.dirname, '..');

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'drafts' ? [] : sources(path);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [path] : [];
  });
}

describe('the catalogue at the testnet launch', () => {
  it('offers English only', () => {
    expect(LOCALES).toEqual(['en']);
    expect(DEFAULT_LOCALE).toBe('en');
    expect(catalogueFor('en')).toBe(en);
    expect(catalogueFor('en-NG')).toBe(en);
  });

  it('gives English to every reader, whatever the page or the browser asks for', () => {
    for (const locale of DRAFT_LOCALES) {
      expect(resolveLocale(locale, [])).toBe('en');
      expect(resolveLocale('', [`${locale}-KE`])).toBe('en');
      expect(catalogueFor(locale)).toBe(en);
    }
    expect(resolveLocale(null, ['de-DE'])).toBe('en');
    expect(resolveLocale(undefined)).toBe('en');
  });

  it('reads a tag with a region as its language', () => {
    expect(languageOf('en-NG')).toBe('en');
    expect(languageOf('EN')).toBe('en');
    expect(languageOf('')).toBe('');
  });

  it('fills placeholders and leaves a missing one visible', () => {
    expect(fill('Step {step} of {total}', { step: '1', total: '3' })).toBe('Step 1 of 3');
    expect(fill('Back to {step}')).toBe('Back to {step}');
    expect(translator('en')('widget.progress', { step: '2', total: '3' })).toBe('Step 2 of 3');
  });
});

describe('the drafts', () => {
  it('keep every other language in the code, none of them reviewed yet', () => {
    expect(DRAFT_LOCALES).toEqual(['ha', 'yo', 'ig', 'sw', 'fr', 'pt', 'es']);
    for (const locale of DRAFT_LOCALES) {
      expect(DRAFTS[locale].reviewed, locale).toBe(false);
    }
  });

  it('carry exactly the English keys, so a translator sees every string', () => {
    const keys = Object.keys(en).sort();
    for (const locale of DRAFT_LOCALES) {
      expect(Object.keys(DRAFTS[locale].draft).sort(), locale).toEqual(keys);
    }
  });

  it('flag a string nobody has translated rather than guess it', () => {
    for (const locale of DRAFT_LOCALES) {
      expect(flagged(DRAFTS[locale].draft).length, locale).toBeGreaterThan(0);
    }
    expect(flagged(en)).toEqual([]);
  });

  it('keep the footer byline as the brand line', () => {
    for (const locale of DRAFT_LOCALES) {
      const byline = DRAFTS[locale].draft['footer.byline'];
      expect(byline === null || byline === en['footer.byline'], locale).toBe(true);
    }
  });

  it('are never imported by the widget, so they cost the bundle nothing', () => {
    const importers = sources(SRC).filter((file) =>
      /from\s+['"][^'"]*drafts\//.test(readFileSync(file, 'utf8')),
    );
    expect(importers).toEqual([]);
  });
});

describe('every key', () => {
  it('is used somewhere in the widget, so nothing waits for a translator in vain', () => {
    const code = sources(SRC)
      .filter((file) => !file.endsWith(join('i18n', 'en.ts')))
      .map((file) => readFileSync(file, 'utf8'))
      .join('\n');
    const unused = (Object.keys(en) as MessageKey[]).filter((key) => !code.includes(`'${key}'`));
    expect(unused).toEqual([]);
  });
});
