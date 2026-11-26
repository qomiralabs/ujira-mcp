// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// Browser flows against the built console in mock mode, so they need no
// server, wallet or network. Run `vite build` first; CI does.

import { defineConfig, devices } from '@playwright/test';

const PORT = 4173;

export default defineConfig({
  testDir: 'e2e',
  outputDir: 'e2e/results',
  fullyParallel: false,
  workers: 1,
  forbidOnly: process.env['CI'] !== undefined,
  retries: 0,
  timeout: 60_000,
  reporter: [['list']],
  use: {
    ...devices['Desktop Chrome'],
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'off',
  },
  webServer: {
    command: `node_modules/.bin/vite preview --host 127.0.0.1 --port ${PORT} --strictPort`,
    url: `http://127.0.0.1:${PORT}/app/`,
    reuseExistingServer: process.env['CI'] === undefined,
    timeout: 60_000,
  },
});
