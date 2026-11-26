// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The app's only way to the rate limit buckets: one function that runs as
// ujira_fn_rate_limits, called inside db.unscoped(), since a bucket belongs
// to no tenant. A key is a digest of what is being limited, never a tenant
// id, and the table refuses anything else, so there is nothing here for the
// cross-tenant matrix to check.

import { sql, type Kysely } from 'kysely';

import type { Schema } from '../schema.js';

type Tx = Kysely<Schema>;

export interface RateLimitBucket {
  // `<kind>:<64 hex digits>`, the digest of what is being limited.
  readonly key: string;
  readonly capacity: number;
  readonly refillPerSecond: number;
}

export interface RateLimitTaken {
  readonly key: string;
  // The whole request's answer: every bucket gave a token, or none did.
  readonly allowed: boolean;
  // Whole tokens the bucket holds now. The bucket itself keeps the fraction
  // that refills between requests; a caller only ever needs the count.
  readonly tokens: number;
}

export const rateLimits = {
  // Refills the buckets and takes a token from each, all or none, in one call.
  take: async (db: Tx, buckets: readonly RateLimitBucket[]): Promise<RateLimitTaken[]> => {
    const result = await sql<{ taken_key: string; allowed: boolean; remaining: number }>`
      select taken_key, allowed, floor(remaining)::integer as remaining
        from ujira.take_rate_limit_tokens(
          ${buckets.map((bucket) => bucket.key)}::text[],
          ${buckets.map((bucket) => bucket.capacity)}::integer[],
          ${buckets.map((bucket) => bucket.refillPerSecond)}::integer[]
        )
    `.execute(db);
    return result.rows.map((row) => ({
      key: row.taken_key,
      allowed: row.allowed,
      tokens: row.remaining,
    }));
  },
};
