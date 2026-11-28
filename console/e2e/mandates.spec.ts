// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The mandate screens on /v1 in a real browser, in mock mode with the
// mandates screen moved over: the list, create with a new recipient in three
// signatures, pause and resume, and revoke with the name typed back. Screenshots go to
// e2e/screenshots at 375, 768 and 1440 wide, in light and dark, and each
// screen photographed passes an axe scan.

import { expect, test, type Page } from '@playwright/test';

import { expectAccessible } from './axe';

const WIDTHS = [375, 768, 1440] as const;
const SCHEMES = ['light', 'dark'] as const;
const SHOTS = 'e2e/screenshots';
const ADA = 'GBT7ITQKEX3Z2YWIYLPRQ5W3JLA2TJ3JTABB765ZYNG7VLX5YYUPI3DT';

async function shot(page: Page, name: string, width: number, scheme: string) {
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: `${SHOTS}/${name}-${width}-${scheme}.png`, fullPage: true });
  // Every screen that is photographed is also scanned, in the same state.
  await expectAccessible(page, `${name} at ${String(width)} in ${scheme}`);
}

async function sign(page: Page) {
  await page.getByRole('button', { name: 'Sign in Demo wallet' }).click();
}

for (const width of WIDTHS) {
  for (const scheme of SCHEMES) {
    test(`mandates on /v1 at ${width} in ${scheme}`, async ({ browser }) => {
      // Four signatures and five scans: more than the default minute on a slow runner.
      test.slow();
      const context = await browser.newContext({
        viewport: { width, height: width < 800 ? 812 : 900 },
        colorScheme: scheme,
        reducedMotion: 'reduce',
      });
      const page = await context.newPage();
      const problems: string[] = [];
      page.on('console', (m) => {
        if (m.type() === 'error' || m.type() === 'warning') problems.push(m.text());
      });
      page.on('pageerror', (e) => problems.push(e.message));

      await page.goto('/app/mandates?mock=1&v1=mandates');
      await page.getByRole('button', { name: /Continue with Demo wallet/ }).click();
      await page.getByLabel('Organisation name').fill('Acme Ltd');
      await page.getByRole('button', { name: 'Create organisation' }).click();
      await expect(page.getByRole('heading', { level: 1, name: 'Mandates' })).toBeVisible();
      await expect(page.getByRole('link', { name: /Weekly payouts/ })).toBeVisible();
      await shot(page, 'mandates-v1-list', width, scheme);

      await page.getByRole('link', { name: 'Create a mandate' }).first().click();
      await page.getByLabel('Name', { exact: true }).fill('Grants round');
      // A recipient belongs to one mandate, so the form takes a new name and wallet.
      await page.getByRole('button', { name: 'Add someone' }).click();
      const row = page.getByRole('group', { name: 'Person 1' });
      await row.getByLabel('Stellar wallet').fill(ADA);
      await row.getByLabel('Their name').fill('Ada');
      await expect(
        page.getByText('3 signatures: create, one for each person, then fund.'),
      ).toBeVisible();
      await shot(page, 'mandates-v1-create', width, scheme);
      await page.getByRole('button', { name: 'Review and sign' }).click();
      await sign(page);
      await expect(page.getByRole('heading', { name: 'Sign step 2 of 3' })).toBeVisible();
      await expect(page.getByRole('heading', { name: /Allow Ada/ })).toBeVisible();
      await shot(page, 'mandates-v1-allow', width, scheme);
      await sign(page);
      await expect(page.getByRole('heading', { name: 'Sign step 3 of 3' })).toBeVisible();
      await sign(page);
      await expect(page.getByRole('heading', { name: 'Your mandate is live' })).toBeVisible();
      await page.getByRole('link', { name: 'Open your mandate' }).click();

      await expect(page.getByRole('heading', { name: 'Grants round' })).toBeVisible();
      await expect(page.getByRole('img', { name: /40\.00 USDC remaining/ })).toBeVisible();
      await shot(page, 'mandates-v1-detail', width, scheme);

      await page.getByRole('button', { name: 'Pause payouts' }).click();
      await sign(page);
      await expect(page.getByText('Paused', { exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'Resume payouts' }).click();
      await sign(page);
      await expect(page.getByText('Active', { exact: true })).toBeVisible();

      await page.getByRole('button', { name: 'Revoke', exact: true }).click();
      const dialog = page.getByRole('dialog');
      const confirm = dialog.getByRole('button', { name: 'Revoke for good' });
      await expect(confirm).toBeDisabled();
      await dialog.getByLabel('Type Grants round to confirm').fill('Grants round');
      await expect(confirm).toBeEnabled();
      await shot(page, 'mandates-v1-revoke', width, scheme);
      await confirm.click();
      await dialog.getByRole('button', { name: 'Sign in Demo wallet' }).click();
      await expect(dialog).toBeHidden();
      await expect(page.getByText('Revoked', { exact: true })).toBeVisible();

      expect(problems).toEqual([]);
      await context.close();
    });
  }
}
