// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

import { describe, expect, it } from 'vitest';

import { ApiError, type ConsoleApi } from '../lib/api';
import type { Mandate, Payout, Receipt } from '../lib/schemas';
import {
  allPayouts,
  allReceipts,
  heldTotal,
  loadPortfolio,
  paidTotal,
  usable,
  waitingPayouts,
  type MandateBundle,
} from './portfolio';

function mandate(id: string, state: Partial<Mandate['state']> = {}): Mandate {
  return {
    id,
    principal: 'G',
    rules: {
      budget: '1000000000',
      perPaymentCap: '100000000',
      dailyCap: '200000000',
      approvalThreshold: '50000000',
      expiresAt: 4_000_000_000,
    },
    state: {
      balance: '0',
      spent: '0',
      remaining: '1000000000',
      paused: false,
      revoked: false,
      expired: false,
      ...state,
    },
    recipients: [],
    mcpUrl: `https://ujira.co/m/${id}/mcp`,
  };
}

const payout = (taskId: string, status: string, at: string): Payout => ({
  taskId,
  recipient: 'G',
  amount: '10000000',
  rail: 'usdc',
  status,
  at,
});

const receipt = (task_id: string, updated_at: string): Receipt => ({
  task_id,
  recipient: 'Ada',
  amount: '10000000',
  outcome: 'paid',
  updated_at,
});

function bundle(
  m: Mandate | null,
  payouts: Payout[] = [],
  receipts: Receipt[] = [],
): MandateBundle {
  return {
    summary: { id: m?.id ?? 'CBROKEN' },
    mandate: m,
    payouts,
    receipts,
    error: m === null ? 'gone' : null,
  };
}

describe('the portfolio', () => {
  const a = mandate('CA', { balance: '50000000', spent: '20000000' });
  const b = mandate('CB', { balance: '125000000', spent: '5000000', revoked: true });
  const bundles = [
    bundle(
      a,
      [
        payout('t1', 'paid', '2026-11-16T10:00:00Z'),
        payout('t3', 'approved', '2026-11-16T12:00:00Z'),
      ],
      [receipt('t1', '2026-11-16T10:00:00Z')],
    ),
    bundle(
      b,
      [payout('t2', 'pending_approval', '2026-11-16T11:00:00Z')],
      [receipt('t2', '2026-11-16T11:00:00Z')],
    ),
    bundle(null),
  ];

  it('joins payouts from every mandate, newest first', () => {
    expect(allPayouts(bundles).map((r) => [r.mandate.id, r.payout.taskId])).toEqual([
      ['CA', 't3'],
      ['CB', 't2'],
      ['CA', 't1'],
    ]);
  });

  it('lists what waits for the owner, approved or not yet', () => {
    expect(waitingPayouts(bundles).map((r) => r.payout.taskId)).toEqual(['t3', 't2']);
  });

  it('joins receipts newest first', () => {
    expect(allReceipts(bundles).map((r) => r.receipt.task_id)).toEqual(['t2', 't1']);
  });

  it('adds money up in minor units', () => {
    expect(heldTotal(bundles)).toBe('175000000');
    expect(paidTotal(bundles)).toBe('25000000');
  });

  it('puts only mandates that can still pay in the usable list', () => {
    expect(usable(bundles).map((m) => m.id)).toEqual(['CA']);
  });

  it('keeps going when one mandate cannot be read', async () => {
    const good = mandate('CGOOD');
    const api = {
      mandates: () => Promise.resolve([{ id: 'CGOOD' }, { id: 'CBAD' }]),
      mandate: (id: string) =>
        id === 'CGOOD'
          ? Promise.resolve(good)
          : Promise.reject(new ApiError('mandate_not_found', 'Not known here.', 404)),
      payouts: () => Promise.resolve([]),
      receipts: () => Promise.resolve([]),
    } as unknown as ConsoleApi;
    const out = await loadPortfolio(api, 'G');
    expect(out.map((x) => [x.summary.id, x.mandate?.id ?? null, x.error])).toEqual([
      ['CGOOD', 'CGOOD', null],
      ['CBAD', null, 'Not known here.'],
    ]);
  });
});
