// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// What an API key may do. The list is closed and the database holds the same
// one in a check constraint, so a key can never carry a scope this code would
// not know how to judge. Changing it takes a migration and a line here.

export const API_SCOPES = Object.freeze([
  'payouts:read',
  'payouts:write',
  'approvals:write',
  'recipients:read',
  'recipients:write',
  'mandates:read',
  'mandates:write',
  'receipts:read',
  'webhooks:manage',
  'corridors:read',
] as const);
export type ApiScope = (typeof API_SCOPES)[number];

/** The tenant a request runs as. Every credential resolves to exactly one. */
export interface Tenant {
  readonly principalId: string;
  readonly projectId: string;
}

/** A tenant found from an API key. */
export interface KeyTenant extends Tenant {
  /** Which key this is, for its own audit and rate limit. Never sent to a client. */
  readonly tokenId: string;
  readonly prefix: string;
  readonly scopes: readonly ApiScope[];
}
