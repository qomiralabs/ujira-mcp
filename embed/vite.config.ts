// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

import { defineConfig } from 'vitest/config';

// One file, ujira-embed.js, that a script tag loads on any page. The server
// serves it under /embed/v1/.
export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    target: 'es2022',
    minify: true,
    lib: {
      entry: 'src/index.ts',
      formats: ['es'],
      fileName: () => 'ujira-embed.js',
    },
    rolldownOptions: {
      // Keeps the dependencies' own licence notices in the file, which is
      // what their licences ask of a copy we hand to other people's pages.
      output: { comments: { legal: true } },
    },
  },
  test: {
    // Node by default; the files that render the element ask for happy-dom themselves.
    environment: 'node',
    include: ['src/**/*.test.ts', 'scripts/**/*.test.ts'],
    restoreMocks: true,
  },
});
