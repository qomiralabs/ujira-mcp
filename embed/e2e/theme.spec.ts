// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// Theming from the host page: a custom property set on the element repaints
// the widget, one set on an ancestor does not, and dark mode switches.

import { expect, test, type Page } from '@playwright/test';

import { primary, start, WIDGET } from './steps.ts';

function backgroundOf(page: Page, selector: string): Promise<string> {
  return page
    .locator(`${WIDGET} ${selector}`)
    .first()
    .evaluate((element) => getComputedStyle(element).backgroundColor);
}

test('a custom property on the element repaints the action', async ({ page }) => {
  await start(page);
  expect(await backgroundOf(page, '.primary')).toBe('rgb(0, 0, 0)');
  await page.addStyleTag({ content: 'ujira-onboarding { --ujira-embed-accent: #005ab4; }' });
  expect(await backgroundOf(page, '.primary')).toBe('rgb(0, 90, 180)');
});

test('a property on an ancestor does not reach the widget', async ({ page }) => {
  await start(page);
  await page.addStyleTag({ content: 'main { --ujira-embed-accent: #005ab4; }' });
  expect(await backgroundOf(page, '.primary')).toBe('rgb(0, 0, 0)');
});

test('dark mode takes the teal card of the dashboard', async ({ page }) => {
  await start(page, { mode: 'dark' });
  expect(await backgroundOf(page, '.widget')).toBe('rgb(15, 58, 69)');
  expect(await backgroundOf(page, '.primary')).toBe('rgb(234, 244, 245)');
});

test('system mode follows the reader', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await start(page, { mode: 'light' });
  expect(await backgroundOf(page, '.widget')).toBe('rgb(255, 255, 255)');
  await page.locator(WIDGET).evaluate((element) => {
    element.setAttribute('mode', 'system');
  });
  expect(await backgroundOf(page, '.widget')).toBe('rgb(15, 58, 69)');
});

test('an unusable focus width still leaves a ring', async ({ page }) => {
  await start(page);
  await page.addStyleTag({ content: 'ujira-onboarding { --ujira-embed-focus-width: 0; }' });
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  const ring = await primary(page).evaluate((element) => {
    const style = getComputedStyle(element);
    return { style: style.outlineStyle, width: style.outlineWidth };
  });
  expect(ring).toEqual({ style: 'solid', width: '2px' });
});
