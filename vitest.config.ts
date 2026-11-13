// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // main.ts only wires the real network and stdio together; the server it
      // starts is covered through an in-memory transport.
      exclude: ['src/**/*.test.ts', 'src/mcp/main.ts'],
      reporter: [['text', { skipFull: false }]],
    },
  },
});
