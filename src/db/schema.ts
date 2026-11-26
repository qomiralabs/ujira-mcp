// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The tables the migrations create, as kysely reads them. Written by hand
// and kept beside the migrations: a migration that adds or changes a table
// changes its entry here in the same pull request, and the schema test
// compares the two so they cannot drift.
//
// pg returns smallint and integer as numbers and numeric and bigint as
// strings, and its type parsers are never changed, so an amount column is a
// string here and becomes a bigint only through the money mapper.

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

export interface Schema {
  'ujira.chains': ChainsTable;
  'ujira.currencies': CurrenciesTable;
  'ujira.currency_scales': CurrencyScalesTable;
  'ujira.settlement_tokens': SettlementTokensTable;
  'ujira.status_transitions': StatusTransitionsTable;
}

// Every column above, by table, for the schema test. Checked against the
// interfaces in both directions, as the environment keys are in config.ts.
export const SCHEMA_COLUMNS = {
  'ujira.chains': { code: true },
  'ujira.currencies': { code: true, minor_units: true },
  'ujira.currency_scales': { currency: true, scale: true },
  'ujira.settlement_tokens': { asset: true, chain: true, token_scale: true, display_scale: true },
  'ujira.status_transitions': { machine: true, from_status: true, to_status: true },
} as const satisfies { readonly [T in keyof Schema]: Record<keyof Schema[T], true> };
