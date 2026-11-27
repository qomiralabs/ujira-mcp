// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// Callers outside src/db cannot import the driver, so they cannot tell a
// lost connection from a constraint violation by reading pg's error. This
// file draws that line once: an outage becomes DatabaseUnavailableError,
// which the API answers with 503 and Retry-After, and everything else passes
// through untouched so a bug is never dressed up as an outage.

import pg from 'pg';

// SQLSTATE values that mean "try again shortly", not "your query is wrong".
// Class 08 is connection exceptions; the rest are shutdown, capacity and the
// two timeouts this module sets on every transaction.
const UNAVAILABLE_STATES: ReadonlySet<string> = new Set([
  '57P01', // admin_shutdown
  '57P02', // crash_shutdown
  '57P03', // cannot_connect_now
  '53300', // too_many_connections
  '53400', // configuration_limit_exceeded
  '57014', // query_canceled, which is how statement_timeout ends a query
  '55P03', // lock_not_available, raised by lock_timeout
]);

// Socket failures. Only trusted on an error that names a syscall, which is
// how Node marks a system error, so a code copied onto some other error
// cannot pass for one.
const NETWORK_CODES: ReadonlySet<string> = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
]);

// The driver raises these as plain errors, with no code, when a pooled
// connection cannot be had or drops mid query.
const CONNECTION_MESSAGES: ReadonlySet<string> = new Set([
  'timeout exceeded when trying to connect',
  'Connection terminated unexpectedly',
  'Connection terminated due to connection timeout',
]);

/**
 * The database could not serve the request. `reason` is a SQLSTATE, a
 * socket error code or `connection`; the original error is not kept, since
 * driver messages can carry host names and user names.
 */
export class DatabaseUnavailableError extends Error {
  override readonly name = 'DatabaseUnavailableError';
  readonly reason: string;

  constructor(reason: string) {
    super('The database is unavailable');
    this.reason = reason;
  }
}

function ownString(value: object, key: string): string | undefined {
  const read: unknown = Object.getOwnPropertyDescriptor(value, key)?.value;
  return typeof read === 'string' ? read : undefined;
}

/** The unavailable form of an error, or undefined when it is not about availability. */
export function toUnavailable(error: unknown): DatabaseUnavailableError | undefined {
  if (!(error instanceof Error)) return undefined;
  if (error instanceof pg.DatabaseError) {
    const state = error.code ?? '';
    return state.startsWith('08') || UNAVAILABLE_STATES.has(state)
      ? new DatabaseUnavailableError(state)
      : undefined;
  }
  const code = ownString(error, 'code');
  if (code !== undefined && NETWORK_CODES.has(code) && ownString(error, 'syscall') !== undefined) {
    return new DatabaseUnavailableError(code);
  }
  if (CONNECTION_MESSAGES.has(error.message)) return new DatabaseUnavailableError('connection');
  return undefined;
}
