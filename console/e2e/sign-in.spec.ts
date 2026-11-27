// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The sign in flow in a real browser, in mock mode: sign in with the demo
// wallet, name the organisation, land on the page asked for, switch project
// and sign out. Screenshots of each screen go to e2e/screenshots at the three
// widths the console is designed for, in light and dark, and each screen
// photographed passes an axe scan.

import { expect, test, type Page } from '@playwright/test';

import { expectAccessible } from './axe';

const WIDTHS = [375, 768, 1440] as const;
const SCHEMES = ['light', 'dark'] as const;
const SHOTS = 'e2e/screenshots';

async function shot(page: Page, name: string, width: number, scheme: string) {
  // Fonts come from Google Fonts; wait for them so the screenshot is the real look.
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: `${SHOTS}/${name}-${width}-${scheme}.png`, fullPage: true });
  // Every screen that is photographed is also scanned, in the same state.
  await expectAccessible(page, `${name} at ${String(width)} in ${scheme}`);
}

for (const width of WIDTHS) {
  for (const scheme of SCHEMES) {
    test(`sign in at ${width} in ${scheme}`, async ({ browser }) => {
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

      await page.goto('/app/receipts?mock=1');
      await expect(
        page.getByRole('heading', { level: 1, name: 'Sign in with your wallet' }),
      ).toBeVisible();
      await shot(page, 'sign-in', width, scheme);

      await page.getByRole('button', { name: /Continue with Demo wallet/ }).click();
      await expect(
        page.getByRole('heading', { level: 1, name: 'Name your organisation' }),
      ).toBeVisible();
      await page.getByLabel('Organisation name').click();
      await page.getByRole('button', { name: 'Create organisation' }).click();
      await expect(page.getByText('Enter your organisation name.')).toBeVisible();
      await shot(page, 'organisation', width, scheme);

      await page.getByLabel('Organisation name').fill('Acme Ltd');
      await page.getByRole('button', { name: 'Create organisation' }).click();
      await expect(page.getByRole('heading', { level: 1, name: 'Receipts' })).toBeVisible();
      expect(new URL(page.url()).pathname).toBe('/app/receipts');

      const switcher = page.getByRole('button', { name: /Switch project or sign out/ });
      await expect(switcher).toContainText('Acme Ltd');
      await switcher.click();
      await page.getByRole('button', { name: 'New project in Acme Ltd' }).click();
      await page.getByLabel('Project name').fill('Grants');
      await page.getByRole('button', { name: 'Create', exact: true }).click();
      await expect(switcher).toContainText('Grants');
      await expect(switcher).toBeFocused();
      await switcher.click();
      const signOut = page.getByRole('button', { name: 'Sign out', exact: true });
      await expect(signOut).toBeVisible();
      await shot(page, 'signed-in', width, scheme);

      await signOut.click();
      await expect(page.getByText('You are signed out.')).toBeVisible();
      const stored = await page.evaluate(() => {
        const all: string[] = [];
        for (const store of [localStorage, sessionStorage]) {
          for (let i = 0; i < store.length; i++) {
            const key = store.key(i) ?? '';
            all.push(key, store.getItem(key) ?? '');
          }
        }
        return all.join('\n');
      });
      expect(stored).not.toContain('signature');
      expect(stored).not.toContain('ujira.console.wallet');

      expect(problems).toEqual([]);
      await context.close();
    });
  }
}
