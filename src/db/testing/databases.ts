// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// A Database for one test database that connects as the real service roles,
// so row level security applies exactly as in production. The migration
// pool logs in as the superuser that owns the test database, because a test
// that needs it is setting up, not exercising the policies.

import { loadDatabaseConfig } from '../config.js';
import { createDatabase, type Database } from '../database.js';
import { roleUrl, type TestDatabase } from './harness.js';

export function databaseAsServiceRoles(
  roleUrls: Readonly<Record<string, string>>,
  database: TestDatabase,
  poolSize = 2,
): Database {
  return createDatabase(
    loadDatabaseConfig({
      UJIRA_DB_APP_URL: roleUrl(roleUrls, 'ujira_app', database.name),
      UJIRA_DB_WORKER_URL: roleUrl(roleUrls, 'ujira_worker', database.name),
      UJIRA_DB_READER_URL: roleUrl(roleUrls, 'ujira_reader', database.name),
      UJIRA_DB_MIGRATOR_URL: database.url,
      UJIRA_DB_TLS: 'off',
      UJIRA_DB_POOL_SIZE: String(poolSize),
    }),
  );
}
