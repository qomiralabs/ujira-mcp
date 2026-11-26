// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // main.ts and http-main.ts only wire the real network to stdio or a
      // port; the servers they start are covered in memory and over HTTP.
      exclude: [
        'src/**/*.test.ts',
        'src/**/*.test-d.ts',
        'src/mcp/main.ts',
        'src/mcp/http-main.ts',
      ],
      reporter: [['text', { skipFull: false }]],
      // Code that moves or splits money holds a higher bar than the rest.
      thresholds: {
        'src/money/**/*.ts': { lines: 95, functions: 95, branches: 95, statements: 95 },
        'src/payouts/**/*.ts': { lines: 95, functions: 95, branches: 95, statements: 95 },
      },
    },
  },
});
