// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// What the /v1 MCP tools read back: one task's payout with its receipt, and
// the project's receipts. Every read runs in a tenant transaction under the
// API key's project, so a mandate, payout or receipt of another project reads
// as nothing, the same answer as one that does not exist.
//
// A port, so the tools can run against rows held in memory. A task's payout
// comes from the payout read service, the one GET /v1/payouts answers from, so
// a tool and the API cannot read a payout two ways. Receipts are still read
// here until they have a service of their own; the tools only see the port.

import type { PayoutWireSource } from '../api/routes/payouts.js';
import {
  payouts,
  receipts,
  type Database,
  type Page,
  type PageRequest,
  type Payout,
  type ProjectContext,
  type Receipt,
} from '../db/index.js';
import type { PayoutReadService } from '../payouts/payout-reads.js';

export interface TaskPayout {
  readonly record: PayoutWireSource;
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

export function databaseMcpReads(db: Database, reads: PayoutReadService): McpReads {
  return {
    payoutByTask: async (context, mandateId, taskId) => {
      const view = await reads.byTask(context, mandateId, taskId);
      if (view === undefined) return undefined;
      const { receiptId } = view;
      // A receipt is written once and never changed, so reading it after the
      // payout cannot pair the payout with a receipt that disagrees.
      const receipt =
        receiptId === null
          ? undefined
          : await db.tenant(context).transaction((tx) => receipts.get(tx, receiptId));
      return { record: view, receipt: receipt ?? null };
    },

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
