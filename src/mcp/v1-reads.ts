// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// What the /v1 MCP tools read back: one task's payout with its receipt, and
// the project's receipts. Every read runs in a tenant transaction under the
// API key's project, so a mandate, payout or receipt of another project reads
// as nothing, the same answer as one that does not exist.
//
// A port, so the tools can run against rows held in memory. A task's payout
// comes from the payout read service, the one GET /v1/payouts answers from,
// and receipts from the receipts service, the one GET /v1/receipts reads, so
// a tool and the API cannot read a payout or a receipt two ways.

import type { PayoutWireSource } from '../api/routes/payouts.js';
import {
  receipts,
  type Database,
  type Page,
  type PageRequest,
  type ProjectContext,
  type Receipt,
} from '../db/index.js';
import type { PayoutReadService } from '../payouts/payout-reads.js';
import type { ReceiptService } from '../receipts/service.js';

export interface TaskPayout {
  readonly record: PayoutWireSource;
  readonly receipt: Receipt | null;
}

export interface ReceiptWithPayout {
  readonly receipt: Receipt;
  // What the tool shows of the receipt's payout.
  readonly payout: { readonly mandateId: string; readonly taskId: string };
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

export function databaseMcpReads(
  db: Database,
  reads: PayoutReadService,
  receiptService: ReceiptService,
): McpReads {
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

    receipts: async (context, page) => {
      const found = await receiptService.details(context, {
        limit: page.limit,
        ...(page.after === undefined ? {} : { after: page.after }),
      });
      return {
        items: found.items.map((detail) => ({
          receipt: detail.receipt,
          payout: { mandateId: detail.mandate.id, taskId: detail.taskId },
        })),
        next: found.next,
      };
    },
  };
}
