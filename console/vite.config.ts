// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

import react from '@vitejs/plugin-react';
import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';

import tokens from './src/brand/tokens.json' with { type: 'json' };
import { tokensToCss } from './src/brand/tokens.ts';

// During development the API runs on the server (ujira-mcp-http, port 8080 by
// default); the dev server forwards /api to it so the browser sees one origin.
const apiTarget = process.env['UJIRA_API_URL'] ?? 'http://127.0.0.1:8080';

const TOKENS_ID = 'virtual:ujira-tokens.css';
// A path like id ending in .css, so the CSS pipeline picks the module up.
const RESOLVED_TOKENS_ID = '/__ujira-tokens.css';

/** Serves the brand colour tokens as CSS custom properties. */
function brandTokens(): Plugin {
  return {
    name: 'ujira-brand-tokens',
    resolveId: (id) => (id === TOKENS_ID ? RESOLVED_TOKENS_ID : undefined),
    load: (id) => (id === RESOLVED_TOKENS_ID ? tokensToCss(tokens) : undefined),
  };
}

export default defineConfig({
  plugins: [brandTokens(), react()],
  base: '/',
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
  },
});
