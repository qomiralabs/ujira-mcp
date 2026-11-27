// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The developers screen on /v1 in a real browser, in mock mode with the
// screen moved over: make a key, see its text once, close it and find only
// the prefix left, then revoke it after a confirm. Screenshots go to
// e2e/screenshots at 375, 768 and 1440 wide, in light and dark, and each of
// those screens passes an axe scan.

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
  await expect(page.getByRole('heading', { level: 1, name: 'Developers' })).toBeVisible();
}

for (const width of WIDTHS) {
  for (const scheme of SCHEMES) {
    test(`developers on /v1 at ${width} in ${scheme}`, async ({ browser }) => {
      const context = await browser.newContext({
        viewport: { width, height: width < 800 ? 812 : 900 },
        colorScheme: scheme,
        reducedMotion: 'reduce',
      });
      await context.grantPermissions(['clipboard-read', 'clipboard-write']);
      const page = await context.newPage();
      const problems: string[] = [];
      page.on('console', (m) => {
        if (m.type() === 'error' || m.type() === 'warning') problems.push(m.text());
      });
      page.on('pageerror', (e) => problems.push(e.message));

      await page.goto('/app/developers?mock=1&v1=developers');
      await signIn(page);
      const keys = page.getByRole('region', { name: /^API keys/ });
      await expect(keys.getByText('0 of 20 active')).toBeVisible();
      await expect(
        page.getByRole('region', { name: 'Connect Claude to Weekly payouts' }),
      ).toBeVisible();

      await keys.getByRole('button', { name: 'Create key' }).click();
      const create = page.getByRole('dialog', { name: 'Create a key' });
      await create.getByLabel('Name').fill('Payroll runner');
      await shot(page, 'developers-v1-create', width, scheme);
      await create.getByRole('button', { name: 'Create key' }).click();

      const reveal = page.getByRole('dialog', { name: 'Your new key' });
      const secret = await reveal.getByLabel('Your new API key').inputValue();
      expect(secret).toMatch(/^ujk_test_[a-z2-7]{16}_[a-z2-7]{59}$/);
      await shot(page, 'developers-v1-reveal', width, scheme);
      await reveal.getByRole('button', { name: 'Done' }).click();
      await expect(reveal).toBeHidden();

      await expect(keys.getByText('1 of 20 active')).toBeVisible();
      expect(await page.content()).not.toContain(secret);
      // The page never scrolls sideways.
      const wide = await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
      );
      expect(wide).toBe(false);
      await shot(page, 'developers-v1', width, scheme);

      await keys.getByRole('button', { name: 'Revoke Payroll runner' }).click();
      const confirm = page.getByRole('dialog', { name: 'Revoke Payroll runner?' });
      await confirm.getByRole('button', { name: 'Revoke key' }).click();
      await expect(confirm).toBeHidden();
      await expect(keys.getByText('0 of 20 active')).toBeVisible();
      await expect(keys.getByText('Revoked', { exact: true })).toBeVisible();

      expect(problems).toEqual([]);
      await context.close();
    });
  }
}
