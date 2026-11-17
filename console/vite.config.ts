// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// During development the API runs on the server (ujira-mcp-http, port 8080 by
// default); the dev server forwards /api to it so the browser sees one origin.
const apiTarget = process.env['UJIRA_API_URL'] ?? 'http://127.0.0.1:8080';

// Served by the UJIRA server at /app; the marketing site owns the root.
const BASE = '/app/';

export default defineConfig({
  plugins: [react()],
  base: BASE,
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    target: 'es2022',
    chunkSizeWarningLimit: 250,
    rolldownOptions: {
      output: {
        // React changes far less often than the console, so it gets its own
        // long lived chunk.
        codeSplitting: {
          groups: [{ name: 'react', test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/ }],
        },
      },
    },
  },
  server: {
    proxy: { '/api': apiTarget, '/m/': apiTarget },
  },
  test: {
    environment: 'happy-dom',
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['src/test/setup.ts'],
    restoreMocks: true,
    // Tests see the same base as the build, so links are checked as shipped.
    env: { BASE_URL: BASE },
  },
});
