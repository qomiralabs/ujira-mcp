// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// Captures every step in light and dark at the review widths, for a design
// review. Writes only into the folder it is given. Build first.
//
//   node tools/screenshots.ts <folder>

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { chromium, type Page } from '@playwright/test';

import { encodeAccountAddress } from '../src/destination.ts';
import { startServer } from './serve.ts';

const WIDTHS = [320, 375, 768, 1440];
const MODES = ['light', 'dark'] as const;
const WIDGET = 'ujira-onboarding';
// The same address the browser tests use: valid checksum, nobody's.
const WALLET = encodeAccountAddress(new Uint8Array(32).fill(7));

const folder = process.argv[2];
if (folder === undefined) {
  process.stderr.write('Usage: node tools/screenshots.ts <folder>\n');
  process.exit(2);
}

async function press(page: Page): Promise<void> {
  await page.locator(`${WIDGET} .primary`).click();
}

async function shoot(page: Page, name: string): Promise<void> {
  await page.locator(`${WIDGET} .heading`).first().waitFor();
  // Away from the action, so nothing is caught in its hover state.
  await page.mouse.move(0, 0);
  const path = join(folder ?? '.', `${name}.png`);
  await page.screenshot({ path, animations: 'disabled' });
  process.stdout.write(`${path}\n`);
}

const running = await startServer(join(import.meta.dirname, '..'), 4179);
mkdirSync(folder, { recursive: true });
const browser = await chromium.launch();

try {
  for (const mode of MODES) {
    for (const width of WIDTHS) {
      const shot = (step: string): string => `embed-${step}-${String(width)}-${mode}`;
      const context = await browser.newContext({
        viewport: { width, height: 900 },
        deviceScaleFactor: 2,
        colorScheme: mode,
        reducedMotion: 'reduce',
      });
      const page = await context.newPage();
      await page.goto(`${running.url}/host.html?mode=${mode}`);
      await page.locator(`${WIDGET} .choice`).first().waitFor();
      await page.locator(`${WIDGET} input[value="freighter"]`).check();
      await shoot(page, shot('1-wallet'));
      await press(page);
      await shoot(page, shot('2-connect'));
      await page.locator(`${WIDGET} .text-button`).click();
      await page.locator(`${WIDGET} input[value="other"]`).check();
      await press(page);
      await page.locator(`${WIDGET} input#answer`).fill(WALLET);
      await shoot(page, shot('2-address'));
      await press(page);
      await page.locator(`${WIDGET} .sign-text`).waitFor();
      await shoot(page, shot('3-prove'));
      await page.locator(`${WIDGET} input#signature`).fill('c2lnbmVk');
      await press(page);
      await page.locator(`${WIDGET} .statement`).waitFor();
      await shoot(page, shot('4-done'));
      await context.close();
    }
  }
} finally {
  await browser.close();
  await running.close();
}
