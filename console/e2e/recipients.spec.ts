// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The recipients screen on /v1 in a real browser, in mock mode with the
// recipients screen moved over: one line per recipient, the sheet that says
// why a wallet cannot be paid, and an invite link made and revoked.
// Screenshots go to e2e/screenshots at 375, 768 and 1440 wide, in light and dark.

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
  await expect(page.getByRole('heading', { level: 1, name: 'Recipients' })).toBeVisible();
}

for (const width of WIDTHS) {
  for (const scheme of SCHEMES) {
    test(`recipients on /v1 at ${width} in ${scheme}`, async ({ browser }) => {
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

      await page.goto('/app/recipients?mock=1&v1=recipients');
      await signIn(page);
      await expect(page.getByText('4 recipients')).toBeVisible();
      const rows = page.locator('.rlist .rrow');
      await expect(rows).toHaveCount(4);
      // Every row is one line.
      const heights = await rows.evaluateAll((all) =>
        all.map((r) => Math.round(r.getBoundingClientRect().height)),
      );
      expect(new Set(heights).size).toBe(1);
      const wide = await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
      );
      expect(wide).toBe(false);
      await shot(page, 'recipients-v1-list', width, scheme);

      await page.getByRole('button', { name: 'Open Musa, No USDC' }).click();
      const sheet = page.getByRole('dialog', { name: 'Recipient' });
      await expect(sheet.getByText('This wallet cannot hold USDC yet.')).toBeVisible();
      await expect(sheet.getByRole('button', { name: 'Check again' })).toBeVisible();
      await shot(page, 'recipients-v1-why', width, scheme);
      await page.keyboard.press('Escape');
      await expect(sheet).toBeHidden();

      await page.getByRole('button', { name: 'Open Zainab, No wallet' }).click();
      await sheet.getByRole('button', { name: 'Make a link' }).click();
      const link = sheet.getByLabel('Invite link for Zainab');
      await expect(link).toHaveValue(/\/embed\/v1\/invite#token=ujes_test_/);
      await shot(page, 'recipients-v1-invite', width, scheme);
      await sheet.getByRole('button', { name: 'Revoke' }).click();
      await expect(sheet.getByText('Revoked')).toBeVisible();
      await expect(link).toBeHidden();

      // The open recipient lives in the URL, so a reload opens it again.
      expect(new URL(page.url()).searchParams.get('open')).toMatch(/^[0-9a-f-]{36}$/);

      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: 'Add a recipient' }).first().click();
      await page.getByLabel('Name').fill('Amara');
      await page.getByRole('button', { name: 'Add recipient' }).click();
      await expect(page.getByText(/Send them an invite link to add their wallet/)).toBeVisible();
      await expect(page.getByText('5 recipients')).toBeVisible();
      await shot(page, 'recipients-v1-added', width, scheme);

      expect(problems).toEqual([]);
      await context.close();
    });
  }
}
