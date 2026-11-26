// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The tenant context every query runs under, sent as transaction local
// settings. Two measurements from the Supabase spike shape this file:
//
// - the context statement on its own cost a full network round trip (178 ms
//   p50 from outside the region), so it travels with BEGIN in one statement,
//   which is one round trip;
// - a session level setting was read by another client on the same pooled
//   backend, so every setting here is transaction local and the guard in
//   session-state.ts refuses anything else.
//
// A parameter cannot ride along with BEGIN in a simple query, so the values
// are inlined. They are inlined only after passing a strict check: a value
// that is not exactly a lower case UUID, or one of the two known scopes, is
// refused rather than escaped. Escaping would make a malformed value
// someone else's problem later; refusing it ends there.
//
// The checks take unknown and return the string they read, and the statement
// is built from that return value. A value is therefore read once: an object
// whose string conversion differs between the check and the statement cannot
// pass one and reach the other, which is a hole a type signature alone would
// leave open for an untyped caller.

import { TenantContextError } from './errors.js';

export type TenantScope = 'project' | 'all';

export interface TenantContext {
  readonly principalId: string;
  readonly projectId: string;
  // `project` sees one project. `all` reads every project of the principal
  // and writes nothing; the spike measured the policies refusing its writes.
  readonly scope: TenantScope;
}

// The settings a transaction carries. `txid` is the spike's recommendation:
// the tenancy migration's `current_principal_id()` refuses when it does not
// match `txid_current()`, so a setting that somehow outlived its transaction
// is refused instead of used.
export const TENANT_SETTINGS = [
  'ujira.principal_id',
  'ujira.project_id',
  'ujira.scope',
  'ujira.txid',
] as const;

const SCOPES: ReadonlySet<string> = new Set<TenantScope>(['project', 'all']);

// Lower case canonical UUID only. Postgres accepts braces, upper case and
// other spellings, so two rows could carry the same identifier written two
// ways; one spelling keeps a tenant comparison exact.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Returns the checked value rather than only checking it, so the caller
// interpolates the string this function read. Reading the property twice
// would let an object whose string conversion changes between the two reads
// pass the check and then inject something else, and a type check alone
// would still leave two reads.
function checkedUuid(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new TenantContextError(
      `refused: ${field} must be a string, not ${value === null ? 'null' : typeof value}`,
    );
  }
  if (!UUID.test(value)) {
    throw new TenantContextError(
      `refused: ${field} must be a lower case canonical UUID, 36 characters with four hyphens`,
    );
  }
  return value;
}

function checkedScope(value: unknown): string {
  if (typeof value !== 'string') {
    throw new TenantContextError(
      `refused: scope must be a string, not ${value === null ? 'null' : typeof value}`,
    );
  }
  if (!SCOPES.has(value)) {
    throw new TenantContextError(`refused: scope must be one of ${[...SCOPES].sort().join(', ')}`);
  }
  return value;
}

// `begin` and the context in one statement. Every value in it has passed the
// checks above, so nothing here is escaped: there is nothing left to escape.
export function beginWithTenant(context: TenantContext): string {
  const principalId = checkedUuid(context.principalId, 'principalId');
  const projectId = checkedUuid(context.projectId, 'projectId');
  const scope = checkedScope(context.scope);
  // Scope all reads across the principal's projects and writes nothing. The
  // policies already refuse its writes; a read only transaction refuses them
  // before a policy is even consulted, and says why.
  const begin = scope === 'all' ? 'begin read only;' : 'begin;';
  // Only the values the checks returned reach the statement.
  return [
    begin,
    'select',
    `set_config('ujira.principal_id', '${principalId}', true),`,
    `set_config('ujira.project_id', '${projectId}', true),`,
    `set_config('ujira.scope', '${scope}', true),`,
    `set_config('ujira.txid', txid_current()::text, true)`,
  ].join(' ');
}
