// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// Browser tests for the built widget on a plain HTML page: the flow, the
// 320px layout, accessibility with axe, and theming. Build first.

import { defineConfig, devices } from '@playwright/test';

const PORT = 4178;
const BASE_URL = `http://127.0.0.1:${String(PORT)}`;
const inCi = process.env['CI'] === 'true';

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: true,
  forbidOnly: inCi,
  retries: 0,
  workers: inCi ? 2 : 1,
  reporter: inCi ? [['list'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    // Everything appears at rest, so a colour is never read mid transition.
    reducedMotion: 'reduce',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `node tools/serve.ts ${String(PORT)}`,
    url: `${BASE_URL}/host.html`,
    reuseExistingServer: !inCi,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
