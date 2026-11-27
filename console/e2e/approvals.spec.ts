// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The approvals queue on /v1 in a real browser, in mock mode with the
// approvals screen moved over: one line per payout, J to choose, A to open
// the confirm, the Demo wallet to sign, and the queue empty once the server
// shows the decision. Screenshots go to e2e/screenshots at 375, 768 and 1440
// wide, in light and dark.

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
  await expect(page.getByRole('heading', { level: 1, name: 'Approvals' })).toBeVisible();
}

for (const width of WIDTHS) {
  for (const scheme of SCHEMES) {
    test(`approvals on /v1 at ${width} in ${scheme}`, async ({ browser }) => {
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

      await page.goto('/app/approvals?mock=1&v1=approvals');
      await signIn(page);
      const queue = page.getByRole('region', { name: 'Approvals queue' });
      await expect(page.getByText('1 payout', { exact: true })).toBeVisible();
      await expect(queue.getByRole('row')).toHaveCount(2);
      const row = queue.locator('tbody tr.arow').first();
      await expect(row.getByText('Approval from 250.00 USDC')).toBeVisible();
      await expect(row.getByText('4,580.00 USDC')).toBeVisible();
      const approve = row.getByRole('button', { name: 'Approve 300.00 USDC to Kofi' });
      await expect(approve).toBeEnabled();
      // The page itself never scrolls sideways; the queue scrolls in its card.
      const wide = await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
      );
      expect(wide).toBe(false);
      // The decision is in reach at every width, never off to the side.
      const box = await approve.boundingBox();
      expect(box).not.toBeNull();
      expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(width);
      await shot(page, 'approvals-v1-queue', width, scheme);

      await page.keyboard.press('j');
      await expect(row).toHaveClass(/arow-on/);
      await page.keyboard.press('a');
      const dialog = page.getByRole('dialog', { name: 'Approve 300.00 USDC to Kofi?' });
      await expect(dialog).toBeVisible();
      await shot(page, 'approvals-v1-confirm', width, scheme);

      await dialog.getByRole('button', { name: 'Approve' }).click();
      await dialog.getByRole('button', { name: 'Sign in Demo wallet' }).click();
      await expect(page.getByText('Nothing waiting for approval.')).toBeVisible();
      await expect(page.getByText('Approved 300.00 USDC to Kofi.')).toBeVisible();
      await shot(page, 'approvals-v1-empty', width, scheme);

      expect(problems).toEqual([]);
      await context.close();
    });
  }
}
