// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// Shared steps for the browser tests. Locators reach through the shadow root
// the way a person reaches the controls: by what they are, not where they are.

import { expect, type Locator, type Page } from '@playwright/test';

import { encodeAccountAddress } from '../src/destination.js';
import { en } from '../src/i18n/en.js';

export const WIDGET = 'ujira-onboarding';
/** A real Stellar address, checksum and all, that belongs to nobody we know. */
export const WALLET = encodeAccountAddress(new Uint8Array(32).fill(7));

export interface OpenOptions {
  token?: string;
  mode?: 'light' | 'dark';
  wallet?: boolean;
  width?: number;
}

export function heading(page: Page): Locator {
  return page.locator(`${WIDGET} .heading`);
}

export function primary(page: Page): Locator {
  return page.locator(`${WIDGET} .primary`);
}

export function alert(page: Page): Locator {
  return page.locator(`${WIDGET} .alert`);
}

export async function open(page: Page, options: OpenOptions = {}): Promise<void> {
  await page.setViewportSize({ width: options.width ?? 420, height: 900 });
  const query = new URLSearchParams();
  if (options.token !== undefined) query.set('token', options.token);
  if (options.mode !== undefined) query.set('mode', options.mode);
  if (options.wallet === true) query.set('wallet', '1');
  const search = query.toString();
  await page.goto(`/host.html${search === '' ? '' : `?${search}`}`);
}

/** Opens the page and waits for the first question. */
export async function start(page: Page, options: OpenOptions = {}): Promise<void> {
  await open(page, options);
  await expect(heading(page)).toHaveText(en['wallet.heading']);
}

/** Another wallet and a typed address, ending on the proof step. */
export async function typeAddress(page: Page): Promise<void> {
  await page.getByRole('radio', { name: en['wallet.other.name'] }).check();
  await primary(page).click();
  await expect(heading(page)).toHaveText(en['destination.wallet.heading']);
  await page.getByLabel(en['destination.wallet.label']).fill(WALLET);
  await primary(page).click();
  await expect(heading(page)).toHaveText(en['prove.heading']);
}
