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

import type { Generated } from 'kysely';

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
} as const satisfies { readonly [T in keyof Schema]: Record<keyof Schema[T], true> };
