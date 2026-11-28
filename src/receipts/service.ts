// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// Reading, exporting and verifying receipts for one tenant. Every database
// read is one transaction under the caller's project, so another project's
// receipt reads as not found. The export streams a page at a time, each its
// own short transaction, so a large export holds neither a connection nor
// the whole file in memory.

import { callOptions, DEFAULT_CALL_TIMEOUT_MS, type ChainAdapter } from '../chain/adapter.js';
import {
  receipts,
  type Database,
  type Page,
  type ProjectContext,
  type ReceiptDetail,
  type ReceiptFilter,
} from '../db/index.js';
import { ReceiptNotFoundError } from './errors.js';
import { csvHeader, csvRow } from './export.js';
import { receiptFromDetail, type ReceiptView } from './model.js';
import { verifyReceipt, type Verification } from './verify.js';

/** The largest page the repository reads at once. */
export const RECEIPT_PAGE_MAX = 100;

export interface ReceiptQuery extends ReceiptFilter {
  readonly limit: number;
  // The key of the last receipt of the previous page.
  readonly after?: string;
}

export interface ReceiptService {
  /** Newest first, as the repository's rows with their payouts beside them. */
  details(context: ProjectContext, query: ReceiptQuery): Promise<Page<ReceiptDetail>>;
  list(context: ProjectContext, query: ReceiptQuery): Promise<Page<ReceiptView>>;
  /** Throws ReceiptNotFoundError for a receipt this project does not have. */
  get(context: ProjectContext, id: string): Promise<ReceiptView>;
  /** The CSV file in chunks: the header, then one chunk per page of rows. */
  exportCsv(context: ProjectContext, filter: ReceiptFilter): AsyncIterable<string>;
  verify(context: ProjectContext, id: string, requestId: string): Promise<Verification>;
}

export interface ReceiptServiceOptions {
  readonly db: Database;
  readonly chain: Pick<ChainAdapter, 'network' | 'transfers'>;
  readonly chainTimeoutMs?: number;
}

export function createReceiptService(o: ReceiptServiceOptions): ReceiptService {
  const details = (context: ProjectContext, query: ReceiptQuery): Promise<Page<ReceiptDetail>> =>
    o.db.tenant(context).transaction(async (tx) => {
      const { limit, after, ...filter } = query;
      const page = await receipts.list(
        tx,
        { limit, ...(after === undefined ? {} : { after }) },
        filter,
      );
      return { items: await receipts.details(tx, page.items), next: page.next };
    });

  const get = (context: ProjectContext, id: string): Promise<ReceiptView> =>
    o.db.tenant(context).transaction(async (tx) => {
      const receipt = await receipts.get(tx, id);
      if (receipt === undefined) throw new ReceiptNotFoundError();
      const [detail] = await receipts.details(tx, [receipt]);
      if (detail === undefined) throw new ReceiptNotFoundError();
      return receiptFromDetail(detail);
    });

  return {
    details,

    list: async (context, query) => {
      const page = await details(context, query);
      return { items: page.items.map(receiptFromDetail), next: page.next };
    },

    get,

    exportCsv: (context, filter) => ({
      async *[Symbol.asyncIterator]() {
        yield csvHeader();
        let after: string | undefined;
        for (;;) {
          const page = await details(context, {
            ...filter,
            limit: RECEIPT_PAGE_MAX,
            ...(after === undefined ? {} : { after }),
          });
          if (page.items.length > 0) {
            yield page.items.map((detail) => csvRow(receiptFromDetail(detail))).join('');
          }
          if (page.next === null) return;
          after = page.next;
        }
      },
    }),

    verify: async (context, id, requestId) => {
      const receipt = await get(context, id);
      return verifyReceipt(
        receipt,
        o.chain,
        callOptions(requestId, o.chainTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS),
      );
    },
  };
}
