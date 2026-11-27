// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// What the built widget must be: inside its size budget, the production
// build of the renderer, the element it promises, and carrying the licence
// notices of what it bundles. Pure, so each rule is tested on its own.

import { gzipSync } from 'node:zlib';

/** 60 KB gzipped, on the wire. */
export const BUDGET_BYTES = 60 * 1024;

/** The element the bundle must define, so the budget cannot measure something else. */
export const TAG_NAME = 'ujira-onboarding';

/** What Lit's development build says about itself, and its production build never does. */
export const DEV_MARKER = 'Lit is in dev mode';

/**
 * What only Albedo's library has: on load it watches every click on the page
 * for web+stellar links. That is no business of a page that never chose
 * Albedo, so the library loads as its own file, when the person picks it.
 */
export const PAGE_WIDE_MARKER = 'web+stellar:';

/** The copyright line of every licence block the bundle carries. */
export function licenceNotices(code: string): string[] {
  return [...code.matchAll(/\/\*[\s\S]*?\*\//g)]
    .map((match) => match[0])
    .filter((block) => block.includes('@license'))
    .map((block) => (/Copyright [^\n*]+/.exec(block) ?? [''])[0].trim())
    .filter((line) => line !== '');
}

/**
 * The notices the bundle is expected to carry, pinned so the check fails in
 * both directions: fewer, and a dependency's notice was dropped from a file
 * we hand to other people's pages; more, and a dependency arrived without
 * its licence being looked at.
 */
export const EXPECTED_NOTICES: readonly string[] = [
  'Copyright 2017 Google LLC',
  'Copyright 2019 Google LLC',
];

export interface Report {
  bytes: number;
  gzipBytes: number;
  problems: string[];
}

export function gzipSize(code: string): number {
  return gzipSync(code, { level: 9 }).byteLength;
}

export function checkBundle(code: string, budget = BUDGET_BYTES): Report {
  const bytes = Buffer.byteLength(code);
  const gzipBytes = gzipSize(code);
  const problems: string[] = [];
  const kb = (value: number): string => (value / 1024).toFixed(1);
  if (gzipBytes > budget) {
    problems.push(`${kb(gzipBytes)} KB gzipped is over the ${kb(budget)} KB budget`);
  }
  if (code.includes(DEV_MARKER)) {
    problems.push('the bundle carries the development build of the renderer');
  }
  if (code.includes(PAGE_WIDE_MARKER)) {
    problems.push(
      'the bundle loads the Albedo library up front; it must load only when Albedo is chosen',
    );
  }
  if (!code.includes(TAG_NAME) || !code.includes('customElements.define')) {
    problems.push('the bundle does not define the widget element');
  }
  const notices = [...new Set(licenceNotices(code))].sort();
  const expected = [...EXPECTED_NOTICES].sort();
  const missing = expected.filter((line) => !notices.includes(line));
  const extra = notices.filter((line) => !expected.includes(line));
  if (missing.length > 0) problems.push(`the bundle stopped carrying: ${missing.join('; ')}`);
  if (extra.length > 0) {
    problems.push(`the bundle carries a notice nobody reviewed: ${extra.join('; ')}`);
  }
  return { bytes, gzipBytes, problems };
}

/** The names the server answers under /embed/v1/; any other file would be a 404. */
export const SERVED_NAME = /^[a-z0-9][a-z0-9-]*\.js$/;

export function checkNames(names: readonly string[]): string[] {
  return names
    .filter((name) => !SERVED_NAME.test(name))
    .map((name) => `${name} is not a name the server serves under /embed/v1/`);
}

/** The main file and every chunk it may load, held to the same budget together. */
export function checkTotal(files: readonly string[], budget = BUDGET_BYTES): string[] {
  const total = files.reduce((sum, code) => sum + gzipSize(code), 0);
  const kb = (value: number): string => (value / 1024).toFixed(1);
  return total > budget
    ? [`${kb(total)} KB gzipped for all the files together over the ${kb(budget)} KB budget`]
    : [];
}
