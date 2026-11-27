// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// axe on every step, in light and dark, against WCAG 2.1 AA. axe reads
// into the open shadow root, so the widget's own markup is what is checked.

import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';

import { en } from '../src/i18n/en.js';
import { alert, heading, primary, start, typeAddress, WALLET, WIDGET } from './steps.ts';

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

/** The wallet choices in the order the arrow keys walk them. */
const CHOICES = [en['wallet.freighter.name'], en['wallet.albedo.name'], en['wallet.other.name']];

function choice(page: Page, name: string): Locator {
  return page.getByRole('radio', { name });
}

test('walks every wallet choice with the arrow keys', async ({ page }) => {
  await start(page);
  await page.keyboard.press('Tab');
  await expect(choice(page, CHOICES[0] ?? '')).toBeFocused();
  for (const name of CHOICES.slice(1)) {
    await page.keyboard.press('ArrowDown');
    await expect(choice(page, name)).toBeFocused();
    await expect(choice(page, name)).toBeChecked();
  }
  // The group wraps, as a radio group should.
  await page.keyboard.press('ArrowDown');
  await expect(choice(page, CHOICES[0] ?? '')).toBeChecked();
  await page.keyboard.press('ArrowUp');
  await expect(choice(page, CHOICES[2] ?? '')).toBeChecked();
});

test('can be driven from the keyboard alone, from the wallet to done', async ({ page }) => {
  await start(page);
  await page.keyboard.press('Tab');
  await page.keyboard.press('ArrowUp');
  await expect(choice(page, en['wallet.other.name'])).toBeChecked();
  await page.keyboard.press('Enter');
  await expect(heading(page)).toHaveText(en['destination.wallet.heading']);
  await expect(heading(page)).toBeFocused();

  await page.keyboard.press('Tab');
  await expect(page.getByLabel(en['destination.wallet.label'])).toBeFocused();
  await page.keyboard.type(WALLET);
  await page.keyboard.press('Enter');
  await expect(heading(page)).toHaveText(en['prove.heading']);
  await expect(heading(page)).toBeFocused();

  const signature = page.getByLabel(en['prove.signature.label']);
  for (let presses = 0; presses < 5; presses++) {
    await page.keyboard.press('Tab');
    if (await signature.evaluate((node) => node.matches(':focus'))) break;
  }
  await expect(signature).toBeFocused();
  await page.keyboard.type('c2lnbmVk');
  await page.keyboard.press('Enter');
  await expect(heading(page)).toHaveText(en['done.heading']);
  await expect(heading(page)).toBeFocused();
});

test('reaches the Albedo connect step from the keyboard', async ({ page }) => {
  await start(page);
  await page.keyboard.press('Tab');
  await page.keyboard.press('ArrowDown');
  await expect(choice(page, en['wallet.albedo.name'])).toBeChecked();
  await page.keyboard.press('Enter');
  await expect(heading(page)).toHaveText(en['connect.albedo.heading']);
  await expect(heading(page)).toBeFocused();
  // Pressing it would open Albedo's own window on albedo.link, so the test stops at the button.
  await page.keyboard.press('Tab');
  await expect(primary(page)).toBeFocused();
  await expect(primary(page)).toHaveText(en['connect.albedo.action']);
});
