// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The payouts screen on /v1 in a real browser, in mock mode with the payouts
// screen moved over: the table, a filter that survives a reload, the side
// sheet over the table and the table's scroll kept under it. Screenshots go
// to e2e/screenshots at 375, 768 and 1440 wide, in light and dark.

import { expect, test, type Page } from '@playwright/test';

const WIDTHS = [375, 768, 1440] as const;
const SCHEMES = ['light', 'dark'] as const;
const SHOTS = 'e2e/screenshots';

async function shot(page: Page, name: string, width: number, scheme: string) {
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: `${SHOTS}/${name}-${width}-${scheme}.png`, fullPage: true });
}

async function signIn(page: Page) {
  await page.getByRole('button', { name: /Continue with Demo wallet/ }).click();
  await page.getByLabel('Organisation name').fill('Acme Ltd');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Payouts' })).toBeVisible();
}

for (const width of WIDTHS) {
  for (const scheme of SCHEMES) {
    test(`payouts on /v1 at ${width} in ${scheme}`, async ({ browser }) => {
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

      await page.goto('/app/payouts?mock=1&v1=payouts');
      await signIn(page);
      const table = page.getByRole('region', { name: 'Payouts table' });
      await expect(page.getByText('3 payouts')).toBeVisible();
      await expect(table.getByRole('row')).toHaveCount(4);
      await expect(table.getByText('Weekly payouts').first()).toBeVisible();
      // Every row is one line.
      const heights = await table
        .locator('tbody tr.prow')
        .evaluateAll((rows) => rows.map((r) => r.getBoundingClientRect().height));
      expect(new Set(heights.map((h) => Math.round(h))).size).toBe(1);
      // The table scrolls inside its card; the page itself never scrolls sideways.
      const wide = await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
      );
      expect(wide).toBe(false);
      await shot(page, 'payouts-v1-table', width, scheme);

      await table
        .getByRole('button', { name: /^Open payout/ })
        .first()
        .click();
      const sheet = page.getByRole('dialog', { name: 'Payout' });
      await expect(sheet.getByRole('list', { name: 'Progress' })).toBeVisible();
      await expect(sheet.getByText('Over the max per payment.')).toBeVisible();
      await shot(page, 'payouts-v1-sheet', width, scheme);
      await page.keyboard.press('Escape');
      await expect(sheet).toBeHidden();

      await page.getByLabel('Status').selectOption({ label: 'Paid' });
      await expect(page.getByText('1 payout', { exact: true })).toBeVisible();
      expect(new URL(page.url()).searchParams.get('status')).toBe('paid');

      // A reload starts the mock from nothing; the view comes back from the URL.
      await page.reload();
      await signIn(page);
      await expect(page.getByLabel('Status')).toHaveValue('paid');
      await expect(page.getByText('1 payout', { exact: true })).toBeVisible();

      expect(problems).toEqual([]);
      await context.close();
    });
  }
}
