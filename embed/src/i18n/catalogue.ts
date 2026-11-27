// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// Looks up copy by key. English is the source and, at the testnet launch,
// the only language a person is shown. The other languages wait in drafts/,
// each with every key, until a native speaker has reviewed them; see
// drafts/index.ts. They are not imported here, so they cost the bundle
// nothing until one ships.
//
// A tag with a region, such as en-NG, uses the language. A language that is
// not offered gets English whole, never half a screen of each.

import { en } from './en.js';

/** Every key in the catalogue. A key outside this set is a type error. */
export type MessageKey = keyof typeof en;

/** One language file: the same keys as English, translated. */
export type Catalogue = Readonly<Record<MessageKey, string>>;

/** A language file in progress: null marks a string waiting for a translator. */
export type Draft = Readonly<Record<MessageKey, string | null>>;

/** The languages a person can be shown today. */
export const LOCALES = ['en'] as const;

export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = 'en';

const READY: ReadonlyMap<string, Catalogue> = new Map<string, Catalogue>([['en', en]]);

/** The keys of a draft still waiting for a translator. */
export function flagged(draft: Draft): MessageKey[] {
  return (Object.keys(en) as MessageKey[]).filter((key) => {
    const value = draft[key];
    return typeof value !== 'string' || value.trim() === '';
  });
}

/** The language part of a tag, lower cased: en-NG and EN both give en. */
export function languageOf(tag: string): string {
  return (tag.split('-')[0] ?? '').toLowerCase();
}

function readyFor(tag: string): Locale | undefined {
  const language = languageOf(tag.trim());
  return READY.has(language) ? (language as Locale) : undefined;
}

/**
 * The language to show: the page's choice when it made one we can show,
 * then the reader's browser languages in their order, then English. A page
 * that removes the attribute leaves null behind, which counts as no choice.
 */
export function resolveLocale(
  chosen: string | null | undefined,
  browser: readonly string[] = [],
): Locale {
  if (typeof chosen === 'string' && chosen.trim() !== '') {
    return readyFor(chosen) ?? DEFAULT_LOCALE;
  }
  for (const tag of browser) {
    const found = readyFor(tag);
    if (found !== undefined) return found;
  }
  return DEFAULT_LOCALE;
}

export function catalogueFor(tag: string): Catalogue {
  return READY.get(readyFor(tag) ?? DEFAULT_LOCALE) ?? en;
}

/**
 * Fills {name} placeholders. A placeholder with no value is left as it is, so
 * a missing value shows up in the tests instead of throwing mid render.
 */
export function fill(template: string, values: Readonly<Record<string, string>> = {}): string {
  return template.replaceAll(/\{(\w+)\}/g, (match, name: string) => values[name] ?? match);
}

export type Translate = (key: MessageKey, values?: Readonly<Record<string, string>>) => string;

export function translator(tag: string): Translate {
  const catalogue = catalogueFor(tag);
  return (key, values) => fill(catalogue[key], values);
}
