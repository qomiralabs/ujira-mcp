// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// Starts one Postgres for the whole run, migrates a template database once,
// and hands the admin URL to the test workers. Vitest runs this before any
// test file and tears it down after the last one.
//
// The URL travels through `provide`, not through process.env: each test file
// runs in its own worker process, which does not see a change made to the
// environment here.

import { runMigrations } from '../migrate.js';
import { startHarness } from './container.js';
import { ADMIN_URL_KEY, ROLE_URLS_KEY } from './harness.js';

// vitest 5 does not export the global setup context type, so the one method
// used here is declared rather than imported.
interface SetupContext {
  readonly provide: <K extends 'dbAdminUrl' | 'dbRoleUrls'>(
    key: K,
    value: K extends 'dbAdminUrl' ? string : Record<string, string>,
  ) => void;
}

export default async function setup({ provide }: SetupContext): Promise<() => Promise<void>> {
  const harness = await startHarness(async (url) => {
    await runMigrations({ databaseUrl: url, direction: 'up' });
  });
  provide(ADMIN_URL_KEY, harness.adminUrl);
  provide(ROLE_URLS_KEY, { ...harness.roleUrls });
  return async () => {
    await harness.stop();
  };
}

declare module 'vitest' {
  interface ProvidedContext {
    dbAdminUrl: string;
    dbRoleUrls: Record<string, string>;
  }
}
