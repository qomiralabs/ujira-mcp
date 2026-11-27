// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The payout service's database side, on the repositories. Each call is one
// tenant transaction under the caller's project, so a mandate or a recipient
// of another project reads as nothing and cannot be written against.

import {
  mandates,
  payoutMethods,
  payouts,
  recipients,
  type Database,
  type PayoutJobQueue,
} from '../db/index.js';
import type { PayoutStore } from './payout-service.js';

export function databasePayoutStore(db: Database, jobs: PayoutJobQueue): PayoutStore {
  return {
    target: (context, mandateId, recipientId) =>
      db.tenant(context).transaction(async (tx) => {
        const mandate = await mandates.get(tx, mandateId);
        const recipient = await recipients.get(tx, recipientId);
        if (mandate === undefined || recipient?.mandateId !== mandate.id) {
          return { mandate, recipient: undefined, method: null };
        }
        const [method] = await payoutMethods.forRecipients(tx, [recipient.id]);
        return { mandate, recipient, method: method ?? null };
      }),

    hasTask: (context, mandateId, taskId) =>
      db
        .tenant(context)
        .transaction(async (tx) => (await payouts.findByTask(tx, mandateId, taskId)) !== undefined),

    recordCheck: (context, methodId, check) =>
      db.tenant(context).transaction(async (tx) => {
        await payoutMethods.recordCheck(tx, methodId, check);
      }),

    create: (context, input) =>
      db.tenant(context).transaction((tx) => payouts.create(tx, input, jobs)),
  };
}
