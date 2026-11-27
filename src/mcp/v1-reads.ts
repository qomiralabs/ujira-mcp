// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// What the /v1 MCP tools read back: one task's payout with its receipt, and
// the project's receipts. Each call is one tenant transaction under the API
// key's project, so a mandate, payout or receipt of another project reads as
// nothing, the same answer as one that does not exist.
//
// A port, so the tools can run against rows held in memory. The payout list
// and receipt services in progress elsewhere will replace this database side
// once they land; the tools only see the port.

import {
  mandates,
  payoutLegs,
  payouts,
  receipts,
  recipients,
  type Database,
  type Page,
  type PageRequest,
  type Payout,
  type ProjectContext,
  type Receipt,
} from '../db/index.js';
import type { PayoutRecord } from '../payouts/payout-service.js';

export interface TaskPayout {
  readonly record: PayoutRecord;
  readonly receipt: Receipt | null;
}

export interface ReceiptWithPayout {
  readonly receipt: Receipt;
  readonly payout: Payout;
}

export interface McpReads {
  // Undefined when the mandate is not this project's or holds no such task.
  payoutByTask(
    context: ProjectContext,
    mandateId: string,
    taskId: string,
  ): Promise<TaskPayout | undefined>;
  // Newest first.
  receipts(context: ProjectContext, page: PageRequest): Promise<Page<ReceiptWithPayout>>;
}

export function databaseMcpReads(db: Database): McpReads {
  return {
    payoutByTask: (context, mandateId, taskId) =>
      db.tenant(context).transaction(async (tx) => {
        const mandate = await mandates.get(tx, mandateId);
        if (mandate === undefined) return undefined;
        const payout = await payouts.findByTask(tx, mandate.id, taskId);
        if (payout === undefined) return undefined;
        const recipient = await recipients.get(tx, payout.recipientId);
        // The payout's foreign key names this recipient under the same tenant.
        if (recipient === undefined)
          throw new Error('a payout names a recipient that cannot be read');
        const legs = await payoutLegs.list(tx, payout.id);
        const receipt = await receipts.forPayout(tx, payout.id);
        return {
          record: {
            created: false,
            principalId: context.principalId,
            payout,
            legs,
            mandate,
            recipient,
          },
          receipt: receipt ?? null,
        };
      }),

    receipts: (context, page) =>
      db.tenant(context).transaction(async (tx) => {
        const found = await receipts.list(tx, page);
        const items: ReceiptWithPayout[] = [];
        // At most one page, read in the same snapshot as the receipts.
        for (const receipt of found.items) {
          const payout = await payouts.get(tx, receipt.payoutId);
          if (payout === undefined) throw new Error('a receipt names a payout that cannot be read');
          items.push({ receipt, payout });
        }
        return { items, next: found.next };
      }),
  };
}
