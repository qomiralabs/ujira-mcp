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
      exclude: ['src/**/*.test.ts', 'src/mcp/main.ts', 'src/mcp/http-main.ts'],
      reporter: [['text', { skipFull: false }]],
    },
  },
});
