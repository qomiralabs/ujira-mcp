// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The overview on /v1 in a real browser, in mock mode with the overview
// moved over: a project with money and payouts, then a new project with only
// its first steps. Screenshots go to e2e/screenshots at 375, 768 and 1440
// wide, in light and dark, and each photographed screen passes an axe scan.

import { expect, test, type Page } from '@playwright/test';

import { expectAccessible } from './axe';

const WIDTHS = [375, 768, 1440] as const;
const SCHEMES = ['light', 'dark'] as const;
const SHOTS = 'e2e/screenshots';

async function shot(page: Page, name: string, width: number, scheme: string) {
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: `${SHOTS}/${name}-${width}-${scheme}.png`, fullPage: true });
  await expectAccessible(page, `${name} at ${String(width)} in ${scheme}`);
}

async function signIn(page: Page) {
  await page.getByRole('button', { name: /Continue with Demo wallet/ }).click();
  await page.getByLabel('Organisation name').fill('Acme Ltd');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible();
}

async function noSideScroll(page: Page) {
  const wide = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  expect(wide).toBe(false);
}

for (const width of WIDTHS) {
  for (const scheme of SCHEMES) {
    test(`overview on /v1 at ${width} in ${scheme}`, async ({ browser }) => {
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

      await page.goto('/app/?mock=1&v1=overview');
      await signIn(page);
      const balance = page.getByRole('region', { name: 'Total balance' });
      await expect(balance.getByText('1,880.00', { exact: false }).first()).toBeVisible();
      await expect(page.getByRole('link', { name: /1 payout waiting/ })).toBeVisible();
      await expect(page.getByRole('heading', { name: 'This period' })).toBeVisible();
      await expect(
        page.getByRole('region', { name: 'Recent payouts' }).getByRole('button'),
      ).toHaveCount(3);
      await noSideScroll(page);
      await shot(page, 'overview-v1', width, scheme);

      // A new principal: nothing yet but the steps to take.
      await page.goto('/app/?mock=1&v1=overview&demo=off');
      await signIn(page);
      const steps = page.getByRole('region', { name: 'First steps' });
      await expect(steps.getByRole('link', { name: 'Create a mandate' })).toBeVisible();
      await expect(page.getByRole('heading', { name: 'This period' })).toHaveCount(0);
      await noSideScroll(page);
      await shot(page, 'overview-v1-empty', width, scheme);

      expect(problems).toEqual([]);
      await context.close();
    });
  }
}
