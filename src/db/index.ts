// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The public entry of the database module. Everything that reaches a
// database goes through here: the driver and the query builder are imports
// of src/db alone, enforced by a lint fence, so no caller can open a
// connection without a tenant context.
//
// What is deliberately not exported: the pg pool, the kysely instance and
// the schema types. A caller that needs a query needs a repository method,
// which arrives with the tables.

export {
  createDatabase,
  type Database,
  type DatabaseHooks,
  type DatabaseRole,
  type ProjectContext,
  type TenantSession,
} from './database.js';
export {
  CONNECTION_BUDGET,
  loadDatabaseConfig,
  POOL_DEFAULTS,
  type DatabaseConfig,
  type DatabaseEnvironment,
  type RoleConnection,
  type TlsMode,
} from './config.js';
export { ConnectionUrl } from './connection-url.js';
// Exported so a deployment can check which certificate it is pinning
// without importing the driver.
export { PINNED_TLS, SUPABASE_ROOT_2021_CA_FINGERPRINT } from './tls.js';
export {
  MIGRATIONS_TABLE,
  runMigrations,
  runMigrationsByFile,
  type LockMode,
  type MigrationDirection,
  type MigrationRun,
} from './migrate.js';
export { TENANT_SETTINGS, type TenantContext, type TenantScope } from './tenant.js';
export { DatabaseConfigError, SessionStateError, TenantContextError } from './errors.js';
export { DatabaseUnavailableError } from './unavailable.js';
