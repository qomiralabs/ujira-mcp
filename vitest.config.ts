// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

import { readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';

import { defineConfig } from 'vitest/config';

// The runner's own error serialiser, which it does not export. The database
// tests pin what a failing test prints against it, so it is found by name in
// the installed runner. If an upgrade moves it, the alias names a file that
// does not exist and only those tests fail, asking to be read again.
function runnerSerialiserChunk(): string {
  const chunks = join(
    realpathSync(join(import.meta.dirname, 'node_modules', 'vitest')),
    'dist',
    'chunks',
  );
  const holders = readdirSync(chunks).filter(
    (file) =>
      file.endsWith('.js') &&
      readFileSync(join(chunks, file), 'utf8').includes('function serializeValue('),
  );
  const [only] = holders;
  return holders.length === 1 && only !== undefined
    ? join(chunks, only)
    : join(chunks, 'serializeValue-not-found.js');
}

export default defineConfig({
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
          exclude: ['src/db/**'],
        },
      },
      {
        // The database tests start one Postgres container for the whole run
        // through the global setup, which needs a docker daemon: they fail
        // without one rather than skipping, so an empty run cannot look like
        // a passing one. The template database is migrated once, and each
        // test file gets a fresh clone of it.
        extends: true,
        test: {
          name: 'db',
          include: ['src/db/**/*.test.ts'],
          globalSetup: ['src/db/testing/global-setup.ts'],
          hookTimeout: 180_000,
          testTimeout: 120_000,
          alias: { 'vitest-runner-serialiser': runnerSerialiserChunk() },
        },
      },
    ],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.test.ts',
        'src/**/*.test-d.ts',
        '**/*.d.ts',
        // Broken on purpose for the lint tests, and never run.
        'src/**/*.fixture.ts',
        // main.ts and http-main.ts only wire the real network to stdio or a
        // port; the servers they start are covered in memory and over HTTP.
        'src/mcp/main.ts',
        'src/mcp/http-main.ts',
        // The only code that runs in the vitest global setup, in the main
        // process, where the workers' coverage cannot see it. Its behaviour is
        // covered by testing/harness.test.ts against the real container.
        // Named one by one, so a new file in the folder is still measured.
        'src/db/testing/container.ts',
        'src/db/testing/global-setup.ts',
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
