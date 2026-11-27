// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_VIEW,
  csvFileName,
  methodOf,
  parseView,
  payoutsCsv,
  serverQuery,
  sortPayouts,
  timelineOf,
  viewSearch,
} from './payoutsV1';
import type { PayoutDetail, TokenAmount } from './v1Schemas';

const MANDATE = '0b8f6a4c-58c3-4a3b-9f0e-6c1d2e3f4a5b';
const RECIPIENT = '5a1e0c2d-1111-4a3b-9f0e-6c1d2e3f4a5b';

function usdc(amount: bigint): TokenAmount {
  return { amount, asset: 'USDC', network: 'stellar:testnet', scale: 7 };
}

function payout(over: Partial<PayoutDetail> & { id: string }): PayoutDetail {
  const amount = over.amount ?? usdc(10_000_000n);
  return {
    principalId: 'p1',
    projectId: 'j1',
    mandate: { id: MANDATE, contractId: `C${'A'.repeat(51)}WXYZ` },
    recipient: { id: RECIPIENT, label: 'Ada' },
    taskId: `task-${over.id}`,
    fee: usdc(0n),
    status: 'paid',
    blockedBy: null,
    legs: [
      {
        index: 0,
        method: 'stellar.wallet',
        destination: 'GABC...WXYZ',
        amount,
        status: 'paid',
        txHash: 'f'.repeat(64),
      },
    ],
    onChainPayoutId: 'a'.repeat(64),
    requestTxHash: 'b'.repeat(64),
    receiptId: null,
    createdAt: '2026-11-20T10:00:00.000Z',
    updatedAt: '2026-11-20T10:00:05.000Z',
    settledAt: '2026-11-20T10:00:05.000Z',
    ...over,
    amount,
  };
}

describe('the payouts view in the URL', () => {
  it('reads every filter, the sort and the open payout', () => {
    const view = parseView(
      `?mock=1&status=waiting&mandate=${MANDATE}&recipient=${RECIPIENT}&from=2026-11-01&to=2026-11-30&sort=amount&dir=asc&payout=${MANDATE}`,
    );
    expect(view).toEqual({
      status: 'waiting',
      mandateId: MANDATE,
      recipientId: RECIPIENT,
      from: '2026-11-01',
      to: '2026-11-30',
      sort: 'amount',
      dir: 'asc',
      open: MANDATE,
    });
  });

  it('drops anything it does not recognise instead of sending it on', () => {
    const view = parseView(
      '?status=everything&mandate=not-an-id&recipient=%3Cscript%3E&from=2026-02-30&to=tomorrow&sort=secret&dir=up&payout=1',
    );
    expect(view).toEqual(DEFAULT_VIEW);
  });

  it('writes only what differs from the default and keeps other params', () => {
    const search = viewSearch(
      { ...DEFAULT_VIEW, status: 'paid', from: '2026-11-01', open: MANDATE },
      '?mock=1&v1=payouts&status=blocked',
    );
    const params = new URLSearchParams(search);
    expect(params.get('mock')).toBe('1');
    expect(params.get('v1')).toBe('payouts');
    expect(params.get('status')).toBe('paid');
    expect(params.get('from')).toBe('2026-11-01');
    expect(params.get('payout')).toBe(MANDATE);
    expect(params.has('sort')).toBe(false);
    expect(params.has('dir')).toBe(false);
    expect(viewSearch(DEFAULT_VIEW, '?status=paid')).toBe('');
  });

  it('round trips through the URL', () => {
    const view = {
      ...DEFAULT_VIEW,
      status: 'blocked',
      recipientId: RECIPIENT,
      sort: 'settled',
      dir: 'asc',
    } as const;
    expect(parseView(viewSearch(view, ''))).toEqual(view);
  });
});

describe('the query sent to /v1/payouts', () => {
  it('turns a status group into the codes and dates into an end exclusive range', () => {
    const q = serverQuery({
      ...DEFAULT_VIEW,
      status: 'moving',
      mandateId: MANDATE,
      from: '2026-11-01',
      to: '2026-11-30',
    });
    expect(q.status).toBe('queued,submitting,approved,settling');
    expect(q.mandateId).toBe(MANDATE);
    expect(q.recipientId).toBeUndefined();
    expect(q.createdFrom).toBe(new Date(2026, 10, 1).toISOString());
    expect(q.createdTo).toBe(new Date(2026, 11, 1).toISOString());
  });

  it('sends no filters for the default view', () => {
    expect(serverQuery(DEFAULT_VIEW)).toEqual({
      status: undefined,
      mandateId: undefined,
      recipientId: undefined,
      createdFrom: undefined,
      createdTo: undefined,
    });
  });
});

describe('sorting payouts', () => {
  const rows = [
    payout({ id: 'a', amount: usdc(9_007_199_254_740_993n), createdAt: '2026-11-02T00:00:00Z' }),
    payout({ id: 'b', amount: usdc(9_007_199_254_740_992n), createdAt: '2026-11-03T00:00:00Z' }),
    payout({
      id: 'c',
      amount: usdc(5n),
      createdAt: '2026-11-01T00:00:00Z',
      settledAt: null,
      status: 'pending_approval',
      recipient: { id: 'r2', label: 'bea' },
    }),
  ];

  it('sorts by created, newest first, by default', () => {
    expect(sortPayouts(rows, 'created', 'desc').map((p) => p.id)).toEqual(['b', 'a', 'c']);
  });

  it('compares amounts as exact integers, beyond what a number can hold', () => {
    expect(sortPayouts(rows, 'amount', 'asc').map((p) => p.id)).toEqual(['c', 'b', 'a']);
    expect(sortPayouts(rows, 'amount', 'desc').map((p) => p.id)).toEqual(['a', 'b', 'c']);
  });

  it('keeps payouts that have not settled at the end either way', () => {
    expect(sortPayouts(rows, 'settled', 'asc').at(-1)?.id).toBe('c');
    expect(sortPayouts(rows, 'settled', 'desc').at(-1)?.id).toBe('c');
  });

  it('sorts recipients by name, ignoring case', () => {
    expect(sortPayouts(rows, 'recipient', 'asc').map((p) => p.recipient.label)).toEqual([
      'Ada',
      'Ada',
      'bea',
    ]);
  });

  it('never changes the list it was given', () => {
    const before = rows.map((p) => p.id);
    sortPayouts(rows, 'amount', 'asc');
    expect(rows.map((p) => p.id)).toEqual(before);
  });
});

describe('the method column', () => {
  it('names the wallet rail and counts split legs', () => {
    const one = payout({ id: 'a' });
    expect(methodOf(one)).toBe('Stellar wallet');
    const leg = one.legs[0];
    if (leg === undefined) throw new Error('no leg');
    expect(methodOf({ ...one, legs: [leg, { ...leg, index: 1 }] })).toBe('Split, 2 legs');
    expect(methodOf({ ...one, legs: [{ ...leg, method: 'partner.bank_transfer' }] })).toBe(
      'Partner bank transfer',
    );
  });
});

describe('the timeline', () => {
  it('runs requested, mandate check, paid for a paid payout', () => {
    const steps = timelineOf(payout({ id: 'a' }));
    expect(steps.map((s) => [s.label, s.state])).toEqual([
      ['Requested', 'done'],
      ['Mandate check', 'done'],
      ['Paid', 'done'],
    ]);
    expect(steps[0]?.at).toBe('2026-11-20T10:00:00.000Z');
    expect(steps[2]?.at).toBe('2026-11-20T10:00:05.000Z');
  });

  it('stops at the check for a blocked payout', () => {
    const steps = timelineOf(payout({ id: 'a', status: 'blocked', blockedBy: 'BUDGET_EXCEEDED' }));
    expect(steps.map((s) => [s.label, s.state])).toEqual([
      ['Requested', 'done'],
      ['Blocked', 'stopped'],
    ]);
  });

  it('shows the approval step while one is awaited, then after it', () => {
    const waiting = timelineOf(payout({ id: 'a', status: 'pending_approval', settledAt: null }));
    expect(waiting.map((s) => [s.label, s.state])).toEqual([
      ['Requested', 'done'],
      ['Mandate check', 'done'],
      ['Approval', 'now'],
      ['Paid', 'later'],
    ]);
    const rejected = timelineOf(payout({ id: 'a', status: 'rejected' }));
    expect(rejected.map((s) => [s.label, s.state])).toEqual([
      ['Requested', 'done'],
      ['Mandate check', 'done'],
      ['Rejected', 'stopped'],
    ]);
    const paying = timelineOf(payout({ id: 'a', status: 'approved', settledAt: null }));
    expect(paying.map((s) => [s.label, s.state])).toEqual([
      ['Requested', 'done'],
      ['Mandate check', 'done'],
      ['Approval', 'done'],
      ['Paying', 'now'],
    ]);
  });

  it('marks where a payout that needs a look got stuck', () => {
    const early = timelineOf(
      payout({ id: 'a', status: 'needs_attention', requestTxHash: null, settledAt: null }),
    );
    expect(early.map((s) => [s.label, s.state])).toEqual([
      ['Requested', 'done'],
      ['Needs a look', 'stopped'],
    ]);
    const late = timelineOf(payout({ id: 'a', status: 'needs_attention', settledAt: null }));
    expect(late.map((s) => [s.label, s.state])).toEqual([
      ['Requested', 'done'],
      ['Mandate check', 'done'],
      ['Needs a look', 'stopped'],
    ]);
  });

  it('still draws a status it has no words for', () => {
    const steps = timelineOf(payout({ id: 'a', status: 'held_for_review', settledAt: null }));
    expect(steps.map((s) => [s.label, s.state])).toEqual([
      ['Requested', 'done'],
      ['Held for review', 'now'],
    ]);
  });
});

describe('the CSV export', () => {
  it('writes one row per payout with exact amounts and safe cells', () => {
    const csv = payoutsCsv(
      [
        payout({
          id: 'a',
          amount: usdc(12_345_678_901n),
          recipient: { id: RECIPIENT, label: '=HYPERLINK("x")' },
        }),
        payout({
          id: 'b',
          status: 'blocked',
          blockedBy: 'PAYMENT_CAP_EXCEEDED',
          settledAt: null,
          requestTxHash: null,
          legs: [
            {
              index: 0,
              method: 'stellar.wallet',
              destination: 'GABC...WXYZ',
              amount: usdc(10_000_000n),
              status: 'blocked',
              txHash: null,
            },
          ],
        }),
      ],
      () => 'Weekly payouts, main',
    );
    const lines = csv.trimEnd().split('\n');
    expect(lines[0]).toBe(
      'payout_id,created_at,settled_at,recipient,recipient_id,amount,asset,status,blocked_by,method,mandate,mandate_id,task_id,request_tx_hash,tx_hash,receipt_id',
    );
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain(`,"'=HYPERLINK(""x"")",${RECIPIENT},1234.5678901,USDC,paid,,`);
    expect(lines[1]).toContain(',"Weekly payouts, main",');
    expect(lines[2]).toContain(',1.00,USDC,blocked,PAYMENT_CAP_EXCEEDED,Stellar wallet,');
  });

  it('names the file after the day it was made', () => {
    expect(csvFileName(new Date(2026, 10, 27, 15, 4))).toBe('ujira-payouts-2026-11-27.csv');
  });
});
