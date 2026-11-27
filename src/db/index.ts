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
  loadQueueInstallConfig,
  POOL_DEFAULTS,
  type DatabaseConfig,
  type DatabaseEnvironment,
  type QueueInstallConfig,
  type RoleConnection,
  type TlsMode,
} from './config.js';
export {
  ABORT_AFTER_MS,
  installJobQueue,
  QUEUE_SCHEMA,
  startJobRunner,
  type JobHandler,
  type JobRunner,
  type JobRunnerOptions,
  type QueuedJob,
} from './queue.js';
export {
  jobs,
  MAX_JOB_ATTEMPTS,
  PAYOUT_JOB_TASKS,
  payoutJobQueue,
  type PayoutJobTask,
} from './repositories/jobs.js';
export { ConnectionUrl } from './connection-url.js';
// Exported so a deployment can check which roots it is pinning
// without importing the driver.
export { PINNED_ROOT_FINGERPRINTS, PINNED_TLS } from './tls.js';
export {
  MIGRATIONS_TABLE,
  runMigrations,
  runMigrationsByFile,
  type LockMode,
  type MigrationDirection,
  type MigrationRun,
} from './migrate.js';
export { TENANT_SETTINGS, type TenantContext, type TenantScope } from './tenant.js';
export {
  constraintViolation,
  DatabaseConfigError,
  SessionStateError,
  TenantContextError,
  type ConstraintKind,
  type ConstraintViolation,
} from './errors.js';
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
export {
  idempotencyKeys,
  type FinishedRequest,
  type NewReservation,
  type Reservation,
} from './repositories/idempotency.js';
export {
  audit,
  AUDIT_ACTIONS,
  AuditScopeError,
  type AuditAction,
  type AuditActor,
  type AuditChainBreak,
  type AuditEntry,
  type AuditMetadata,
  type AuditVerification,
  type NewAuditEntry,
} from './repositories/audit.js';
export {
  outbox,
  webhookDeliveries,
  webhookEndpoints,
  type NewOutboxEvent,
  type NewWebhookDelivery,
  type NewWebhookEndpoint,
  type OutboxEvent,
  type WebhookDelivery,
  type WebhookDeliveryStatus,
  type WebhookEndpoint,
  type WebhookEndpointStatus,
} from './repositories/outbox.js';
export { RepositoryInputError, type AccountParser } from './repositories/values.js';
export {
  agentKeys,
  type AgentKey,
  type AgentKeyFunding,
  type AgentKeyFundingStatus,
  type AgentKeyStatus,
  type FundingAttempt,
  type NewAgentKey,
  type SealedAgentSecret,
} from './repositories/agent-keys.js';
export {
  mandates,
  type Mandate,
  type MandateAgent,
  type NewMandate,
} from './repositories/mandates.js';
export {
  payoutMethods,
  PayoutMethodRefusedError,
  recipientPii,
  recipients,
  type DestinationCheck,
  type DestinationStatus,
  type NewRecipient,
  type NewWalletMethod,
  type PayoutMethod,
  type PayoutMethodKind,
  type PayoutMethodRefusal,
  type Recipient,
  type RecipientStatus,
  type SealedEmail,
  type StorableCheck,
} from './repositories/recipients.js';
export {
  feeSponsorships,
  type NewSponsoredFee,
  type SettledFee,
  type SponsoredFeeReservation,
} from './repositories/fee-sponsorships.js';
export {
  SIGNING_ACTIONS,
  signingRequests,
  type NewSigningRequest,
  type SigningAction,
  type StoredSigningRequest,
} from './repositories/signing-requests.js';
export {
  PayoutConflictError,
  payoutLegs,
  payouts,
  type CreatedPayout,
  type LegTransition,
  type NewPayout,
  type NewPayoutLeg,
  type Payout,
  type PayoutConflict,
  type PayoutFilter,
  type PayoutLeg,
  type PayoutMetadata,
  type PayoutTransition,
} from './repositories/payouts.js';
export {
  payoutJob,
  unwiredJobQueue,
  type PayoutJob,
  type PayoutJobPayload,
  type PayoutJobQueue,
  type PayoutTask,
} from './repositories/payout-jobs.js';
export { receipts, type IssuedReceipt, type Receipt } from './repositories/receipts.js';
export {
  SECURITY_EVENT_KINDS,
  securityEvents,
  type NewSecurityEvent,
  type SecurityEventKind,
} from './repositories/security-events.js';
