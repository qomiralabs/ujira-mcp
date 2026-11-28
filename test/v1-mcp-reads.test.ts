// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The MCP read port takes a task's payout from the payout read service, so
// payout_status and GET /v1/payouts read a payout the same way. These cases
// never reach the database: a task with no payout, or a payout with no
// receipt yet, needs nothing more than the service. Receipts are listed by
// the receipts service, the one GET /v1/receipts reads. The receipt read is
// covered with the real database in v1-mcp.db.test.ts.

import { describe, expect, it } from 'vitest';

import type { Database, PageRequest, ProjectContext, ReceiptDetail } from '../src/db/index.js';
import { databaseMcpReads } from '../src/mcp/v1-reads.js';
import type { PayoutReadService } from '../src/payouts/payout-reads.js';
import type { ReceiptQuery, ReceiptService } from '../src/receipts/service.js';
import { usdc } from './receipt-fixtures.js';
import { TENANT, viewOf } from './payout-view-helpers.js';

// Any use of the database fails the test, since none is expected.
const noDatabase = new Proxy(
  {},
  {
    get: () => {
      throw new Error('the database was used');
    },
  },
) as unknown as Database;

const DETAIL: ReceiptDetail = {
  receipt: {
    id: '3c2b1a0f-9e8d-4c7b-8a6f-5e4d3c2b1a0f',
    projectId: TENANT.projectId,
    payoutId: '9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c6b',
    status: 'blocked',
    blockedBy: 'PER_PAYMENT_CAP_EXCEEDED',
    network: 'stellar:testnet',
    amount: usdc(25_000_000n),
    fee: usdc(0n),
    chainReceiptRef: null,
    requestTxHash: null,
    settledAt: null,
    createdAt: new Date('2026-11-25T12:00:10.000Z'),
  },
  principalId: TENANT.principalId,
  taskId: 'task-42',
  mandate: { id: '0b8f6a4c-58c3-4a3b-9f0e-6c1d2e3f4a5b', contractAddress: 'C'.repeat(56) },
  recipient: {
    id: '5a1e9c2d-7b3f-4e8a-a1c2-3d4e5f6a7b8c',
    label: 'Ada',
    recipientRef: 'c'.repeat(64),
  },
  legs: [],
};

function readsOf(byTask: PayoutReadService['byTask']) {
  const asked: { context: ProjectContext; mandateId: string; taskId: string }[] = [];
  const pages: ReceiptQuery[] = [];
  const service: PayoutReadService = {
    list: () => Promise.reject(new Error('not used')),
    get: () => Promise.reject(new Error('not used')),
    approvals: () => Promise.reject(new Error('not used')),
    byTask: (context, mandateId, taskId) => {
      asked.push({ context, mandateId, taskId });
      return byTask(context, mandateId, taskId);
    },
  };
  const refuse = () => Promise.reject(new Error('not used'));
  const receiptService: ReceiptService = {
    details: (_context, query) => {
      pages.push(query);
      return Promise.resolve({ items: [DETAIL], next: 'next-key' });
    },
    list: refuse,
    get: refuse,
    verify: refuse,
    exportCsv: () => ({ [Symbol.asyncIterator]: () => ({ next: refuse }) }),
  };
  return { reads: databaseMcpReads(noDatabase, service, receiptService), asked, pages };
}

describe('the MCP read port', () => {
  it('answers undefined for a task the service has no payout for', async () => {
    const { reads, asked } = readsOf(() => Promise.resolve(undefined));
    expect(await reads.payoutByTask(TENANT, 'm-1', 'task-1')).toBeUndefined();
    expect(asked).toEqual([{ context: TENANT, mandateId: 'm-1', taskId: 'task-1' }]);
  });

  it('answers the payout as the service reads it, with no receipt before one is written', async () => {
    const view = viewOf();
    const { reads } = readsOf(() => Promise.resolve(view));
    expect(await reads.payoutByTask(TENANT, view.mandate.id, view.payout.taskId)).toEqual({
      record: view,
      receipt: null,
    });
  });

  it('lists receipts through the receipts service, with the task and mandate beside each', async () => {
    const { reads, pages } = readsOf(() => Promise.resolve(undefined));
    const page: PageRequest = { limit: 20, after: 'key' };
    expect(await reads.receipts(TENANT, page)).toEqual({
      items: [
        {
          receipt: DETAIL.receipt,
          payout: { mandateId: DETAIL.mandate.id, taskId: 'task-42' },
        },
      ],
      next: 'next-key',
    });
    expect(pages).toEqual([{ limit: 20, after: 'key' }]);
  });
});
