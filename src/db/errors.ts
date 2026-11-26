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
