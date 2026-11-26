// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The public entry of the database module. Everything that reaches a
// database goes through here: the driver and the query builder are imports
// of src/db alone, enforced by a lint fence, so no caller can open a
// connection without a tenant context.
//
// What is deliberately not exported: the pg pool, the kysely instance and
// the schema types. A caller that needs a query needs a repository method:
// it opens a transaction with db.tenant(), db.principal() or db.unscoped()
// and hands the transaction to the method.

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
export {
  MAX_PAGE_SIZE,
  PageRequestError,
  type Page,
  type PageRequest,
} from './repositories/page.js';
export {
  apiTokens,
  members,
  principals,
  projects,
  type ApiToken,
  type Member,
  type MemberRole,
  type MemberStatus,
  type NewApiToken,
  type Principal,
  type Project,
} from './repositories/tenancy.js';
export {
  entryPoints,
  type CreatedPrincipal,
  type NewPrincipal,
  type TokenRecord,
} from './repositories/entry-points.js';
export {
  authChallenges,
  authRetention,
  sessions,
  type CreatedChallenge,
  type CreatedSession,
  type NewChallenge,
  type NewSession,
  type ProjectAccess,
  type ResolvedSession,
  type SessionPrincipal,
  type SessionProject,
} from './repositories/sessions.js';
export {
  rateLimits,
  type RateLimitBucket,
  type RateLimitTaken,
} from './repositories/rate-limits.js';
