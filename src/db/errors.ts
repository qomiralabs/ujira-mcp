// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// Errors the database module raises before any SQL reaches the server. Each one
// names what was wrong without repeating the value, so a connection string
// or a tenant identifier never lands in a log line.

export class DatabaseConfigError extends Error {
  override readonly name = 'DatabaseConfigError';
}

// A tenant context value that failed its check. The value is not included:
// the caller knows what it passed, and a log does not need it.
export class TenantContextError extends Error {
  override readonly name = 'TenantContextError';
}

// SQL that would outlive its transaction, such as a session level SET. The
// spike measured a session level setting reaching another client on the same
// pooled backend, ten times out of ten, so this is refused before it runs.
export class SessionStateError extends Error {
  override readonly name = 'SessionStateError';
}

// Which integrity rule the database refused a write under, read off the
// driver's error so code outside this module never has to know SQLSTATE
// codes. The constraint name is the database's, never a value from the row.
export type ConstraintKind = 'unique' | 'foreign_key' | 'check' | 'not_null';

export interface ConstraintViolation {
  readonly kind: ConstraintKind;
  readonly constraint: string | undefined;
}

const SQLSTATE_KINDS: Readonly<Record<string, ConstraintKind>> = {
  '23505': 'unique',
  '23503': 'foreign_key',
  '23514': 'check',
  '23502': 'not_null',
};

export function constraintViolation(error: unknown): ConstraintViolation | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const { code, constraint } = error as { code?: unknown; constraint?: unknown };
  const kind = typeof code === 'string' ? SQLSTATE_KINDS[code] : undefined;
  if (kind === undefined) return undefined;
  return { kind, constraint: typeof constraint === 'string' ? constraint : undefined };
}
