// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The receipts screen on /v1 in a real browser, in mock mode with the
// receipts screen moved over: one line per receipt, a receipt in the side
// sheet, Verify against Stellar, the CSV download and a filter that survives
// a reload. Screenshots go to e2e/screenshots at 375, 768 and 1440 wide, in
// light and dark, and each photographed screen passes an axe scan.

import { readFile } from 'node:fs/promises';

import { expect, test, type Page } from '@playwright/test';

import { expectAccessible } from './axe';

const WIDTHS = [375, 768, 1440] as const;
const SCHEMES = ['light', 'dark'] as const;
const SHOTS = 'e2e/screenshots';

async function shot(page: Page, name: string, width: number, scheme: string) {
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: `${SHOTS}/${name}-${width}-${scheme}.png`, fullPage: true });
  // Every screen that is photographed is also scanned, in the same state.
  await expectAccessible(page, `${name} at ${String(width)} in ${scheme}`);
}

async function signIn(page: Page) {
  await page.getByRole('button', { name: /Continue with Demo wallet/ }).click();
  await page.getByLabel('Organisation name').fill('Acme Ltd');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Receipts' })).toBeVisible();
}

for (const width of WIDTHS) {
  for (const scheme of SCHEMES) {
    test(`receipts on /v1 at ${width} in ${scheme}`, async ({ browser }) => {
      // Two scans, a download and a reload in one walk: more than the default allows on a busy machine.
      test.slow();
      const context = await browser.newContext({
        viewport: { width, height: width < 800 ? 812 : 900 },
        colorScheme: scheme,
        reducedMotion: 'reduce',
        acceptDownloads: true,
      });
      const page = await context.newPage();
      const problems: string[] = [];
      page.on('console', (m) => {
        if (m.type() === 'error' || m.type() === 'warning') problems.push(m.text());
      });
      page.on('pageerror', (e) => problems.push(e.message));

      await page.goto('/app/receipts?mock=1&v1=receipts');
      await signIn(page);
      const table = page.getByRole('region', { name: 'Receipts table' });
      await expect(page.getByText('2 receipts')).toBeVisible();
      await expect(table.getByRole('row')).toHaveCount(3);
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
      await shot(page, 'receipts-v1-list', width, scheme);

      // The CSV is the server's export of the view, saved by the browser.
      const [download] = await Promise.all([
        page.waitForEvent('download'),
        page.getByRole('button', { name: 'Export CSV' }).click(),
      ]);
      expect(download.suggestedFilename()).toMatch(/^ujira-receipts-\d{4}-\d{2}-\d{2}\.csv$/);
      const csv = await readFile(await download.path(), 'utf8');
      expect(csv.trim().split('\n')).toHaveLength(3);
      expect(csv).toContain(',Ada,');

      await table
        .getByRole('row')
        .filter({ hasText: 'Ada' })
        .getByRole('button', { name: /^Open receipt/ })
        .click();
      const sheet = page.getByRole('dialog', { name: 'Receipt' });
      await expect(sheet.getByText('Chain reference', { exact: true })).toBeVisible();
      await sheet.getByRole('button', { name: 'Verify' }).click();
      await expect(sheet.getByText('Matches Stellar')).toBeVisible();
      const explorer = sheet.getByRole('link', { name: /See it on Stellar Expert/ });
      await expect(explorer).toHaveAttribute('href', /^https:\/\/stellar\.expert\//);
      await shot(page, 'receipts-v1-verified', width, scheme);
      await page.keyboard.press('Escape');
      await expect(sheet).toBeHidden();

      await page.getByLabel('Outcome').selectOption({ label: 'Blocked' });
      await expect(page.getByText('1 receipt', { exact: true })).toBeVisible();
      expect(new URL(page.url()).searchParams.get('outcome')).toBe('blocked');

      // A reload starts the mock from nothing; the view comes back from the URL.
      await page.reload();
      await signIn(page);
      await expect(page.getByLabel('Outcome')).toHaveValue('blocked');
      await expect(page.getByText('1 receipt', { exact: true })).toBeVisible();

      expect(problems).toEqual([]);
      await context.close();
    });
  }
}
