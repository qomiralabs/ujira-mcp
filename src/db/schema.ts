// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The tables the migrations create, as kysely reads them. Written by hand
// and kept beside the migrations: a migration that adds or changes a table
// changes its entry here in the same pull request, and the schema test
// compares the two so they cannot drift.
//
// pg returns smallint and integer as numbers and numeric and bigint as
// strings, and its type parsers are never changed, so an amount column is a
// string here and becomes a bigint only through the money mapper. bytea
// comes back as a Buffer and timestamptz as a Date.
//
// Generated marks a column the database fills when an insert leaves it out.

import type { ColumnType, Generated } from 'kysely';

// bigint reads back as text and may be written from any integer form.
type Int8 = ColumnType<string, bigint | number | string, bigint | number | string>;
type NullableInt8 = ColumnType<
  string | null,
  bigint | number | string | null,
  bigint | number | string | null
>;
// pg parses jsonb on the way out. On the way in it is sent as JSON text, so a
// value is always serialised once, by the caller, and never guessed at.
type Jsonb = ColumnType<unknown, string, string>;
type Timestamp = ColumnType<Date, Date | string, Date | string>;
type DefaultTimestamp = ColumnType<Date, Date | string | undefined, Date | string>;
type NullableTimestamp = ColumnType<Date | null, Date | string | null, Date | string | null>;
// Filled by the database only: an identity, or the writing transaction's id.
type DatabaseOnly<T> = ColumnType<T, never, never>;

export interface ChainsTable {
  readonly code: string;
}

export interface CurrenciesTable {
  readonly code: string;
  readonly minor_units: number;
}

export interface CurrencyScalesTable {
  readonly currency: string;
  readonly scale: number;
}

export interface SettlementTokensTable {
  readonly asset: string;
  readonly chain: string;
  readonly token_scale: number;
  readonly display_scale: number;
}

export interface StatusTransitionsTable {
  readonly machine: string;
  readonly from_status: string;
  readonly to_status: string;
}

export interface PrincipalsTable {
  readonly id: Generated<string>;
  readonly name: string;
  readonly reporting_time_zone: Generated<string>;
  readonly created_at: Generated<Date>;
  readonly updated_at: Generated<Date>;
}

export interface ProjectsTable {
  readonly principal_id: string;
  readonly id: Generated<string>;
  readonly name: string;
  readonly created_at: Generated<Date>;
  readonly updated_at: Generated<Date>;
}

// The person behind a wallet. No service role reads it; it is here so the
// schema test sees every table.
export interface MembersTable {
  readonly id: Generated<string>;
  readonly wallet_address: string;
  readonly created_at: Generated<Date>;
}

export interface PrincipalMembersTable {
  readonly principal_id: string;
  readonly member_id: string;
  readonly wallet_address: string;
  readonly role: string;
  readonly status: Generated<string>;
  readonly created_at: Generated<Date>;
  readonly updated_at: Generated<Date>;
}

export interface ApiTokensTable {
  readonly principal_id: string;
  readonly project_id: string;
  readonly id: Generated<string>;
  readonly name: string | null;
  readonly prefix: string;
  readonly secret_sha256: Buffer;
  readonly scopes: string[];
  readonly expires_at: Date;
  readonly revoked_at: Date | null;
  readonly rotated_from_id: string | null;
  readonly last_used_at: Date | null;
  readonly created_at: Generated<Date>;
}

// Reached only through functions, as are the two tables after it.
export interface RateLimitBucketsTable {
  readonly bucket_key: string;
  readonly tokens: string;
  readonly refilled_at: Date;
}

export interface AuthChallengesTable {
  readonly id: Generated<string>;
  readonly wallet_address: string;
  readonly message: string;
  readonly expires_at: Date;
  readonly consumed_at: Date | null;
  readonly created_at: Generated<Date>;
}

export interface SessionsTable {
  readonly id: Generated<string>;
  readonly token_sha256: Buffer;
  readonly member_id: string;
  readonly idle_expires_at: Date;
  readonly absolute_expires_at: Date;
  readonly revoked_at: Date | null;
  readonly revoked_reason: string | null;
  readonly created_at: Generated<Date>;
}

export interface AuditMetadataKeysTable {
  readonly key: string;
}

export interface AuditHeadsTable {
  readonly principal_id: string;
  readonly last_seq: Int8;
  readonly last_hash: Buffer;
}

export interface AuditLogTable {
  readonly principal_id: string;
  readonly project_id: string;
  readonly id: Generated<string>;
  // The chain trigger overwrites seq, prev_hash, row_hash and occurred_at.
  readonly seq: Int8;
  readonly action: string;
  readonly actor_kind: string;
  readonly actor_id: string | null;
  readonly metadata: ColumnType<unknown, string | undefined, string>;
  readonly occurred_at: DefaultTimestamp;
  readonly prev_hash: Buffer;
  readonly row_hash: Buffer;
}

export interface IdempotencyKeysTable {
  readonly principal_id: string;
  readonly project_id: string;
  readonly id: Generated<string>;
  readonly idempotency_key: string;
  readonly request_sha256: Buffer;
  readonly lease_id: string | null;
  readonly lease_expires_at: NullableTimestamp;
  readonly request_id: string | null;
  readonly response_status: NullableInt8;
  readonly response_body: string | null;
  readonly created_at: DefaultTimestamp;
  readonly expires_at: Timestamp;
}

export interface OutboxEventsTable {
  readonly principal_id: string;
  readonly project_id: string;
  readonly id: Generated<string>;
  readonly seq: DatabaseOnly<string>;
  readonly tx_id: DatabaseOnly<string>;
  readonly event_type: string;
  readonly payload: Jsonb;
  readonly created_at: DefaultTimestamp;
}

export interface WebhookEndpointsTable {
  readonly principal_id: string;
  readonly project_id: string;
  readonly id: Generated<string>;
  readonly url: string;
  readonly secret_ref: string;
  readonly event_types: string[];
  readonly status: Generated<string>;
  readonly created_at: DefaultTimestamp;
  readonly updated_at: DefaultTimestamp;
}

export interface WebhookDeliveriesTable {
  readonly principal_id: string;
  readonly project_id: string;
  readonly id: Generated<string>;
  readonly endpoint_id: string;
  readonly event_id: string;
  readonly event_created_at: Timestamp;
  readonly attempt: Int8;
  readonly status: string;
  readonly response_status: NullableInt8;
  readonly error_code: string | null;
  readonly created_at: DefaultTimestamp;
}

export interface AgentKeysTable {
  readonly principal_id: string;
  readonly project_id: string;
  readonly id: Generated<string>;
  readonly network: string;
  readonly public_key: string;
  readonly secret_ciphertext: Buffer;
  readonly secret_nonce: Buffer;
  readonly status: Generated<string>;
  readonly created_at: Generated<Date>;
  readonly updated_at: Generated<Date>;
}

export interface MandatesTable {
  readonly principal_id: string;
  readonly project_id: string;
  readonly id: Generated<string>;
  readonly name: string;
  readonly chain: string;
  readonly network: string;
  readonly contract_address: string;
  readonly asset: string;
  readonly scale: number;
  readonly agent_key_id: string | null;
  readonly agent_address: string;
  readonly principal_wallet: string;
  readonly created_tx_hash: Buffer | null;
  readonly created_at: Generated<Date>;
  readonly updated_at: Generated<Date>;
}

export interface RecipientsTable {
  readonly principal_id: string;
  readonly project_id: string;
  readonly id: Generated<string>;
  readonly mandate_id: string;
  readonly label: string;
  readonly recipient_ref: Buffer;
  readonly status: Generated<string>;
  readonly created_at: Generated<Date>;
  readonly updated_at: Generated<Date>;
}

export interface RecipientPiiTable {
  readonly principal_id: string;
  readonly project_id: string;
  readonly recipient_id: string;
  readonly email_ciphertext: Buffer;
  readonly email_nonce: Buffer;
  readonly created_at: Generated<Date>;
  readonly updated_at: Generated<Date>;
}

export interface PayoutMethodsTable {
  readonly principal_id: string;
  readonly project_id: string;
  readonly id: Generated<string>;
  readonly recipient_id: string;
  readonly method: string;
  readonly destination_address: string;
  readonly verified_at: NullableTimestamp;
  readonly created_at: Generated<Date>;
  readonly destination_status: Generated<string>;
  readonly destination_checked_at: NullableTimestamp;
}

export interface SigningRequestsTable {
  readonly principal_id: string;
  readonly project_id: string;
  readonly id: Generated<string>;
  readonly mandate_id: string | null;
  readonly action: string;
  readonly network: string;
  readonly signer: string;
  readonly envelope: string;
  readonly summary: string;
  readonly expires_at: Timestamp;
  readonly submitted_tx_hash: Buffer | null;
  readonly submitted_at: NullableTimestamp;
  readonly created_at: Generated<Date>;
  readonly updated_at: Generated<Date>;
}

// A date reads back as a Date at local midnight, so the repository casts the
// day to text in its queries and never reads this column raw.
type Day = ColumnType<Date, string, string>;

export interface FeeSponsorDaysTable {
  readonly principal_id: string;
  readonly day: Day;
  readonly used_stroops: Generated<string>;
}

export interface FeeSponsorshipsTable {
  readonly principal_id: string;
  readonly project_id: string;
  readonly id: Generated<string>;
  readonly inner_tx_hash: Buffer;
  readonly day: Day;
  readonly max_fee_stroops: Int8;
  readonly charged_stroops: NullableInt8;
  readonly status: Generated<string>;
  readonly created_at: Generated<Date>;
  readonly updated_at: Generated<Date>;
}

export interface Schema {
  'ujira.chains': ChainsTable;
  'ujira.currencies': CurrenciesTable;
  'ujira.currency_scales': CurrencyScalesTable;
  'ujira.settlement_tokens': SettlementTokensTable;
  'ujira.status_transitions': StatusTransitionsTable;
  'ujira.principals': PrincipalsTable;
  'ujira.projects': ProjectsTable;
  'ujira.members': MembersTable;
  'ujira.principal_members': PrincipalMembersTable;
  'ujira.api_tokens': ApiTokensTable;
  'ujira.rate_limit_buckets': RateLimitBucketsTable;
  'ujira.auth_challenges': AuthChallengesTable;
  'ujira.sessions': SessionsTable;
  'ujira.audit_metadata_keys': AuditMetadataKeysTable;
  'ujira.audit_heads': AuditHeadsTable;
  'ujira.audit_log': AuditLogTable;
  'ujira.idempotency_keys': IdempotencyKeysTable;
  'ujira.outbox_events': OutboxEventsTable;
  'ujira.webhook_endpoints': WebhookEndpointsTable;
  'ujira.webhook_deliveries': WebhookDeliveriesTable;
  'ujira.agent_keys': AgentKeysTable;
  'ujira.mandates': MandatesTable;
  'ujira.recipients': RecipientsTable;
  'ujira.recipient_pii': RecipientPiiTable;
  'ujira.payout_methods': PayoutMethodsTable;
  'ujira.fee_sponsor_days': FeeSponsorDaysTable;
  'ujira.fee_sponsorships': FeeSponsorshipsTable;
  'ujira.signing_requests': SigningRequestsTable;
}

// Every column above, by table, for the schema test. Checked against the
// interfaces in both directions, as the environment keys are in config.ts.
export const SCHEMA_COLUMNS = {
  'ujira.chains': { code: true },
  'ujira.currencies': { code: true, minor_units: true },
  'ujira.currency_scales': { currency: true, scale: true },
  'ujira.settlement_tokens': { asset: true, chain: true, token_scale: true, display_scale: true },
  'ujira.status_transitions': { machine: true, from_status: true, to_status: true },
  'ujira.principals': {
    id: true,
    name: true,
    reporting_time_zone: true,
    created_at: true,
    updated_at: true,
  },
  'ujira.projects': {
    principal_id: true,
    id: true,
    name: true,
    created_at: true,
    updated_at: true,
  },
  'ujira.members': { id: true, wallet_address: true, created_at: true },
  'ujira.principal_members': {
    principal_id: true,
    member_id: true,
    wallet_address: true,
    role: true,
    status: true,
    created_at: true,
    updated_at: true,
  },
  'ujira.api_tokens': {
    principal_id: true,
    project_id: true,
    id: true,
    name: true,
    prefix: true,
    secret_sha256: true,
    scopes: true,
    expires_at: true,
    revoked_at: true,
    rotated_from_id: true,
    last_used_at: true,
    created_at: true,
  },
  'ujira.rate_limit_buckets': { bucket_key: true, tokens: true, refilled_at: true },
  'ujira.auth_challenges': {
    id: true,
    wallet_address: true,
    message: true,
    expires_at: true,
    consumed_at: true,
    created_at: true,
  },
  'ujira.sessions': {
    id: true,
    token_sha256: true,
    member_id: true,
    idle_expires_at: true,
    absolute_expires_at: true,
    revoked_at: true,
    revoked_reason: true,
    created_at: true,
  },
  'ujira.audit_metadata_keys': { key: true },
  'ujira.audit_heads': { principal_id: true, last_seq: true, last_hash: true },
  'ujira.audit_log': {
    principal_id: true,
    project_id: true,
    id: true,
    seq: true,
    action: true,
    actor_kind: true,
    actor_id: true,
    metadata: true,
    occurred_at: true,
    prev_hash: true,
    row_hash: true,
  },
  'ujira.idempotency_keys': {
    principal_id: true,
    project_id: true,
    id: true,
    idempotency_key: true,
    request_sha256: true,
    lease_id: true,
    lease_expires_at: true,
    request_id: true,
    response_status: true,
    response_body: true,
    created_at: true,
    expires_at: true,
  },
  'ujira.outbox_events': {
    principal_id: true,
    project_id: true,
    id: true,
    seq: true,
    tx_id: true,
    event_type: true,
    payload: true,
    created_at: true,
  },
  'ujira.webhook_endpoints': {
    principal_id: true,
    project_id: true,
    id: true,
    url: true,
    secret_ref: true,
    event_types: true,
    status: true,
    created_at: true,
    updated_at: true,
  },
  'ujira.webhook_deliveries': {
    principal_id: true,
    project_id: true,
    id: true,
    endpoint_id: true,
    event_id: true,
    event_created_at: true,
    attempt: true,
    status: true,
    response_status: true,
    error_code: true,
    created_at: true,
  },
  'ujira.agent_keys': {
    principal_id: true,
    project_id: true,
    id: true,
    network: true,
    public_key: true,
    secret_ciphertext: true,
    secret_nonce: true,
    status: true,
    created_at: true,
    updated_at: true,
  },
  'ujira.mandates': {
    principal_id: true,
    project_id: true,
    id: true,
    name: true,
    chain: true,
    network: true,
    contract_address: true,
    asset: true,
    scale: true,
    agent_key_id: true,
    agent_address: true,
    principal_wallet: true,
    created_tx_hash: true,
    created_at: true,
    updated_at: true,
  },
  'ujira.recipients': {
    principal_id: true,
    project_id: true,
    id: true,
    mandate_id: true,
    label: true,
    recipient_ref: true,
    status: true,
    created_at: true,
    updated_at: true,
  },
  'ujira.recipient_pii': {
    principal_id: true,
    project_id: true,
    recipient_id: true,
    email_ciphertext: true,
    email_nonce: true,
    created_at: true,
    updated_at: true,
  },
  'ujira.payout_methods': {
    principal_id: true,
    project_id: true,
    id: true,
    recipient_id: true,
    method: true,
    destination_address: true,
    verified_at: true,
    created_at: true,
    destination_status: true,
    destination_checked_at: true,
  },
  'ujira.signing_requests': {
    principal_id: true,
    project_id: true,
    id: true,
    mandate_id: true,
    action: true,
    network: true,
    signer: true,
    envelope: true,
    summary: true,
    expires_at: true,
    submitted_tx_hash: true,
    submitted_at: true,
    created_at: true,
    updated_at: true,
  },
  'ujira.fee_sponsor_days': { principal_id: true, day: true, used_stroops: true },
  'ujira.fee_sponsorships': {
    principal_id: true,
    project_id: true,
    id: true,
    inner_tx_hash: true,
    day: true,
    max_fee_stroops: true,
    charged_stroops: true,
    status: true,
    created_at: true,
    updated_at: true,
  },
} as const satisfies { readonly [T in keyof Schema]: Record<keyof Schema[T], true> };
