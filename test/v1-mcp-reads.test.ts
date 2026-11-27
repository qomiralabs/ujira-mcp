// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The MCP read port takes a task's payout from the payout read service, so
// payout_status and GET /v1/payouts read a payout the same way. These cases
// never reach the database: a task with no payout, or a payout with no
// receipt yet, needs nothing more than the service. The receipt read is
// covered with the real database in v1-mcp.db.test.ts.

import { describe, expect, it } from 'vitest';

import type { Database, ProjectContext } from '../src/db/index.js';
import { databaseMcpReads } from '../src/mcp/v1-reads.js';
import type { PayoutReadService } from '../src/payouts/payout-reads.js';
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

function readsOf(byTask: PayoutReadService['byTask']) {
  const asked: { context: ProjectContext; mandateId: string; taskId: string }[] = [];
  const service: PayoutReadService = {
    list: () => Promise.reject(new Error('not used')),
    get: () => Promise.reject(new Error('not used')),
    approvals: () => Promise.reject(new Error('not used')),
    byTask: (context, mandateId, taskId) => {
      asked.push({ context, mandateId, taskId });
      return byTask(context, mandateId, taskId);
    },
  };
  return { reads: databaseMcpReads(noDatabase, service), asked };
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
});
