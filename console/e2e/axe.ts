// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// An axe scan of the page as it is now, against WCAG 2.2 A and AA. Any
// violation fails the test, with each rule and the elements it found listed,
// so the failure says what to fix without opening a trace.

import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22a', 'wcag22aa'];

export async function expectAccessible(page: Page, where: string): Promise<void> {
  const { violations } = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  const found = violations.map((v) => {
    // The target, plus what axe measured there, such as the two colours and the ratio.
    const targets = v.nodes
      .slice(0, 5)
      .map((n) => {
        const why = n.any[0]?.message ?? n.all[0]?.message ?? n.none[0]?.message ?? '';
        return `${n.target.join(' ')}${why === '' ? '' : ` (${why})`}`;
      })
      .join(' | ');
    return `${v.id} (${v.impact ?? 'unknown'}): ${v.help} at ${targets}`;
  });
  expect(found, `axe violations on ${where}`).toEqual([]);
}
