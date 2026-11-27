// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The overview's reads on Postgres. db.tenant opens the transaction at project
// scope, so the policies hand it this project's rows and no other: a second
// project of the same principal stays out of every figure.

import { mandates, payoutStats, principals, type Database } from '../db/index.js';
import type { OverviewStore } from './overview.js';

export function databaseOverviewStore(db: Database): OverviewStore {
  return {
    read: (context, periodFor, mandateLimit) =>
      db.tenant(context).transaction(async (tx) => {
        const principal = await principals.current(tx);
        // The transaction's own principal row is always readable to it; no
        // row means the tenant context is not what the caller was given.
        if (principal === undefined) throw new Error('the tenant has no principal row');
        const period = periodFor(principal.reportingTimeZone);
        const stats = await payoutStats.period(tx, period);
        const page = await mandates.list(tx, { limit: mandateLimit });
        return { period, stats, mandates: page.items, moreMandates: page.next !== null };
      }),
  };
}
