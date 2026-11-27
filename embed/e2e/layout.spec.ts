// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The 320px phone: nothing scrolls sideways, every control is big enough to
// press, and the long address wraps rather than pushing the card wider.

import { expect, test, type Page } from '@playwright/test';

import { en } from '../src/i18n/en.js';
import { heading, primary, start, typeAddress, WIDGET } from './steps.ts';

async function fitsAt320(page: Page, where: string): Promise<void> {
  const widths = await page.evaluate(() => ({
    page: document.documentElement.scrollWidth,
    view: window.innerWidth,
  }));
  expect(widths.page, `${where}: the page scrolls sideways`).toBeLessThanOrEqual(widths.view);
  const card = await page.locator(`${WIDGET} .widget`).boundingBox();
  expect(card?.width ?? 0, where).toBeLessThanOrEqual(320);
  // The confirmation has no action; every question has one.
  if ((await primary(page).count()) === 0) return;
  const action = await primary(page).boundingBox();
  expect(action?.height ?? 0, `${where}: the action`).toBeGreaterThanOrEqual(44);
}

test('works at 320px wide, step by step', async ({ page }) => {
  await start(page, { width: 320 });
  await fitsAt320(page, 'wallet');
  for (const choice of await page.locator(`${WIDGET} .choice`).all()) {
    expect((await choice.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
  }
  await typeAddress(page);
  await fitsAt320(page, 'prove');
  await page.getByLabel(en['prove.signature.label']).fill('c2lnbmVk');
  await primary(page).click();
  await expect(heading(page)).toHaveText(en['done.heading']);
  await fitsAt320(page, 'done');
});

test('asks one question per step', async ({ page }) => {
  await start(page);
  await expect(page.locator(`${WIDGET} .heading`)).toHaveCount(1);
  await expect(page.locator(`${WIDGET} .primary`)).toHaveCount(1);
  await typeAddress(page);
  await expect(page.locator(`${WIDGET} .heading`)).toHaveCount(1);
  await expect(page.locator(`${WIDGET} .primary`)).toHaveCount(1);
});
