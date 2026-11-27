// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The whole flow in a browser, through the real HTTP client: a plain page
// with one script tag and <ujira-onboarding token=...>.

import { expect, test } from '@playwright/test';

import { en } from '../src/i18n/en.js';
import { alert, heading, open, primary, start, typeAddress, WALLET, WIDGET } from './steps.ts';

test('renders from a token on a plain page, in light mode, with the UJIRA footer', async ({
  page,
}) => {
  await start(page);
  await expect(page.locator(`${WIDGET} .progress`)).toHaveText('Step 1 of 3');
  await expect(page.locator(`${WIDGET} .footer`)).toHaveText('Payouts by UJIRA');
  const surface = await page
    .locator(`${WIDGET} .widget`)
    .evaluate((element) => getComputedStyle(element).backgroundColor);
  expect(surface).toBe('rgb(255, 255, 255)');
});

test('another wallet: paste the address, sign by hand, done', async ({ page }) => {
  await start(page);
  await typeAddress(page);
  await expect(page.locator(`${WIDGET} .sign-text`)).toContainText('confirm your payout address');
  await page.getByLabel(en['prove.signature.label']).fill('c2lnbmVk');
  await primary(page).click();
  await expect(heading(page)).toHaveText(en['done.heading']);
  const completed = await page.evaluate(
    () => (window as unknown as { completed: unknown[] }).completed,
  );
  // The test server keeps one fake per token across tests, so only the shape of the id is fixed.
  expect(completed).toEqual([
    {
      wallet: 'other',
      destination: WALLET,
      memo: '',
      methodId: expect.stringMatching(/^method-\d{4}$/),
    },
  ]);
});

test('a page wallet signs the proof in one press', async ({ page }) => {
  await start(page, { wallet: true });
  await typeAddress(page);
  await expect(primary(page)).toHaveText(en['prove.action']);
  await primary(page).click();
  await expect(heading(page)).toHaveText(en['done.heading']);
});

test('Freighter not installed is said in plain words', async ({ page }) => {
  await start(page);
  await page.getByRole('radio', { name: en['wallet.freighter.name'] }).check();
  await primary(page).click();
  await expect(heading(page)).toHaveText(en['connect.heading']);
  await primary(page).click();
  await expect(alert(page)).toHaveText(en['connect.missing']);
});

test('a wallet that cannot receive yet is told what to do', async ({ page }) => {
  await start(page, { token: 'ujes_test_no-trustline' });
  await typeAddress(page);
  await page.getByLabel(en['prove.signature.label']).fill('c2lnbmVk');
  await primary(page).click();
  await expect(alert(page)).toHaveText(en['receive.noTrustline']);
});

test('a refused or missing token stops with a message, not a broken form', async ({ page }) => {
  await open(page, { token: 'ujes_live_unknown' });
  await expect(alert(page)).toHaveText(en['widget.expired']);
  await open(page, { token: '' });
  await expect(alert(page)).toHaveText(en['widget.notReady']);
  await open(page, { token: 'ujes_test_closed' });
  await expect(alert(page)).toHaveText(en['widget.closed']);
});
