// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // The entry points only wire the real network to stdio, a port or a
      // signal; what they start is covered in memory and over HTTP, and
      // test/server-process.test.ts runs src/server/main.ts as a child.
      exclude: [
        'src/**/*.test.ts',
        'src/mcp/main.ts',
        'src/mcp/http-main.ts',
        'src/server/main.ts',
      ],
      reporter: [['text', { skipFull: false }]],
    },
  },
});
