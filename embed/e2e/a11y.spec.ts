// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// axe on every step, in light and dark, against WCAG 2.1 AA. axe reads
// into the open shadow root, so the widget's own markup is what is checked.

import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

import { en } from '../src/i18n/en.js';
import { alert, heading, primary, start, typeAddress, WIDGET } from './steps.ts';

async function violations(page: Page): Promise<string[]> {
  const result = await new AxeBuilder({ page })
    .include(WIDGET)
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  return result.violations.map(
    (v) => `${v.id}: ${v.nodes.map((node) => node.target.join(' ')).join(', ')}`,
  );
}

for (const mode of ['light', 'dark'] as const) {
  test(`every step passes axe in ${mode} mode`, async ({ page }) => {
    await start(page, { mode });
    expect(await violations(page), 'wallet').toEqual([]);

    await primary(page).click();
    await expect(alert(page)).toHaveText(en['wallet.missing']);
    expect(await violations(page), 'wallet with a problem').toEqual([]);

    await typeAddress(page);
    expect(await violations(page), 'prove').toEqual([]);

    await primary(page).click();
    await expect(alert(page)).toHaveText(en['prove.signature.missing']);
    expect(await violations(page), 'prove with a problem').toEqual([]);

    await page.getByLabel(en['prove.signature.label']).fill('c2lnbmVk');
    await primary(page).click();
    await expect(heading(page)).toHaveText(en['done.heading']);
    expect(await violations(page), 'done').toEqual([]);
  });
}

test('the address step passes axe with a problem on the memo', async ({ page }) => {
  await start(page);
  await page.getByRole('radio', { name: en['wallet.other.name'] }).check();
  await primary(page).click();
  await page.getByLabel(en['destination.memo.label']).fill('invoice 12');
  await primary(page).click();
  await expect(alert(page)).toHaveText(en['destination.wallet.missing']);
  expect(await violations(page)).toEqual([]);
});

test('can be driven from the keyboard alone', async ({ page }) => {
  await start(page);
  await page.keyboard.press('Tab');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(heading(page)).toHaveText(en['destination.wallet.heading']);
  await expect(page.locator(`${WIDGET} .heading`)).toBeFocused();
});
