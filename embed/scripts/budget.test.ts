// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  BUDGET_BYTES,
  checkBundle,
  checkNames,
  checkTotal,
  DEV_MARKER,
  licenceNotices,
  PAGE_WIDE_MARKER,
} from './budget.ts';

const NOTICES = [
  '/**\n * @license\n * Copyright 2017 Google LLC\n * SPDX-License-Identifier: BSD-3-Clause\n */',
  '/**\n * @license\n * Copyright 2019 Google LLC\n * SPDX-License-Identifier: BSD-3-Clause\n */',
].join('\n');

const GOOD = `${NOTICES}\ncustomElements.define("ujira-onboarding",class{});`;

/** Text that gzip cannot shrink much, so a budget can be crossed on purpose. */
function noise(bytes: number): string {
  return randomBytes(bytes).toString('base64');
}

describe('the bundle check', () => {
  it('passes a small production bundle that defines the element', () => {
    expect(checkBundle(GOOD).problems).toEqual([]);
  });

  it('fails above 60 KB gzipped', () => {
    expect(BUDGET_BYTES).toBe(61_440);
    const report = checkBundle(`${GOOD}/*${noise(80_000)}*/`);
    expect(report.gzipBytes).toBeGreaterThan(BUDGET_BYTES);
    expect(report.problems.join('\n')).toContain('over the 60.0 KB budget');
  });

  it('fails on the development build of the renderer', () => {
    expect(checkBundle(`${GOOD}console.warn("${DEV_MARKER}")`).problems).toEqual([
      'the bundle carries the development build of the renderer',
    ]);
  });

  it('knows the marker from the renderer itself, so the check cannot go blind', () => {
    const lit = join(import.meta.dirname, '..', 'node_modules', '@lit', 'reactive-element');
    const development = readFileSync(join(lit, 'development', 'reactive-element.js'), 'utf8');
    const production = readFileSync(join(lit, 'reactive-element.js'), 'utf8');
    expect(development).toContain(DEV_MARKER);
    expect(production).not.toContain(DEV_MARKER);
  });

  it('fails when the Albedo library is in the main file, where it would watch every click', () => {
    expect(checkBundle(`${GOOD}if(href.indexOf("${PAGE_WIDE_MARKER}")===0)`).problems).toEqual([
      'the bundle loads the Albedo library up front; it must load only when Albedo is chosen',
    ]);
  });

  it('knows the marker from the Albedo library itself', () => {
    const albedo = join(import.meta.dirname, '..', 'node_modules', '@albedo-link', 'intent');
    expect(readFileSync(join(albedo, 'src', 'web+stellar-handler.js'), 'utf8')).toContain(
      PAGE_WIDE_MARKER,
    );
  });

  it('fails when the main file and its chunks together pass the budget', () => {
    const half = noise(40_000);
    expect(checkTotal([GOOD])).toEqual([]);
    expect(checkTotal([`${GOOD}/*${half}*/`, `/*${half}*/`]).join('\n')).toContain(
      'together over the 60.0 KB budget',
    );
  });

  it('fails on a file name the server would not serve', () => {
    expect(checkNames(['ujira-embed.js', 'ujira-embed-albedo-0f3a9c.js'])).toEqual([]);
    expect(checkNames(['src-Cx524MVM.js', 'a_b.js'])).toEqual([
      'src-Cx524MVM.js is not a name the server serves under /embed/v1/',
      'a_b.js is not a name the server serves under /embed/v1/',
    ]);
  });

  it('fails when the element is not defined', () => {
    expect(checkBundle(NOTICES).problems).toEqual([
      'the bundle does not define the widget element',
    ]);
  });

  it('fails when a notice is dropped or an unreviewed one arrives', () => {
    const dropped = checkBundle('customElements.define("ujira-onboarding",class{});');
    expect(dropped.problems[0]).toContain('stopped carrying');
    const extra = checkBundle(`${GOOD}/** @license Copyright 2024 Someone Else */`);
    expect(extra.problems[0]).toContain('nobody reviewed: Copyright 2024 Someone Else');
  });

  it('reads the copyright line of each licence block only', () => {
    expect(licenceNotices(`${NOTICES}/* Copyright 2026 Qomira Labs */`)).toEqual([
      'Copyright 2017 Google LLC',
      'Copyright 2019 Google LLC',
    ]);
  });
});
