// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// Idempotency keys in Postgres. Each call is its own short tenant transaction:
// the reservation has to be visible to every other instance before the handler
// starts, so it cannot wait for the handler's work to commit.

import { DatabaseUnavailableError, idempotencyKeys, type Database } from '../db/index.js';
import { ApiError } from './errors.js';
import type { IdempotencyStore } from './idempotency.js';

/** A database outage is a 503 the client may retry, not an internal error. */
async function available<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof DatabaseUnavailableError) {
      throw new ApiError('DB_UNAVAILABLE', 'The database is unavailable; try again shortly', {
        cause: error,
      });
    }
    throw error;
  }
}

export function databaseIdempotencyStore(db: Database): IdempotencyStore {
  return {
    reserve: (tenant, request) =>
      available(() => db.tenant(tenant).transaction((tx) => idempotencyKeys.reserve(tx, request))),
    complete: (tenant, request) =>
      available(() => db.tenant(tenant).transaction((tx) => idempotencyKeys.complete(tx, request))),
    release: (tenant, request) =>
      available(() => db.tenant(tenant).transaction((tx) => idempotencyKeys.release(tx, request))),
  };
}
