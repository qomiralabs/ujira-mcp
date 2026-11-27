// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

import { describe, expect, it } from 'vitest';

import { receipt } from '../test/v1Recorded';
import {
  DEFAULT_RECEIPT_VIEW,
  isReceiptFiltered,
  parseReceiptView,
  receiptCount,
  receiptServerQuery,
  receiptViewSearch,
  receiptsCsvName,
  sortReceipts,
  verifyWords,
} from './receiptsV1';
import { receiptSchema, type V1Receipt } from './v1Schemas';

const MANDATE = '0b8f6a4c-58c3-4a3b-9f0e-6c1d2e3f4a5b';
const RECEIPT = '3c2b1a0f-9e8d-4c7b-8a6f-5e4d3c2b1a0f';

function row(id: string, issuedAt: string): V1Receipt {
  return receiptSchema.parse({ ...receipt, id, issuedAt });
}

describe('the receipts view in the URL', () => {
  it('reads every filter and the open receipt', () => {
    expect(
      parseReceiptView(
        `?outcome=blocked&mandate=${MANDATE}&from=2026-11-01&to=2026-11-30&receipt=${RECEIPT}`,
      ),
    ).toEqual({
      outcome: 'blocked',
      mandateId: MANDATE,
      recipientId: null,
      from: '2026-11-01',
      to: '2026-11-30',
      open: RECEIPT,
    });
  });

  it('drops values nobody could have chosen', () => {
    expect(
      parseReceiptView('?outcome=queued&mandate=nope&from=2026-02-30&receipt=../x&to=tomorrow'),
    ).toEqual(DEFAULT_RECEIPT_VIEW);
  });

  it('writes back only what is set, and keeps the params of others', () => {
    const search = receiptViewSearch(
      { ...DEFAULT_RECEIPT_VIEW, outcome: 'paid', open: RECEIPT },
      '?mock=1&v1=receipts&outcome=blocked',
    );
    const p = new URLSearchParams(search);
    expect(p.get('mock')).toBe('1');
    expect(p.get('v1')).toBe('receipts');
    expect(p.get('outcome')).toBe('paid');
    expect(p.get('receipt')).toBe(RECEIPT);
    expect(p.has('mandate')).toBe(false);
    expect(receiptViewSearch(DEFAULT_RECEIPT_VIEW, '?outcome=paid')).toBe('');
  });

  it('knows when the list is narrowed; an open receipt is not a filter', () => {
    expect(isReceiptFiltered(DEFAULT_RECEIPT_VIEW)).toBe(false);
    expect(isReceiptFiltered({ ...DEFAULT_RECEIPT_VIEW, open: RECEIPT })).toBe(false);
    expect(isReceiptFiltered({ ...DEFAULT_RECEIPT_VIEW, to: '2026-11-30' })).toBe(true);
  });
});

describe('the server query', () => {
  it('sends the outcome as status and whole local days, the end exclusive', () => {
    const q = receiptServerQuery({
      ...DEFAULT_RECEIPT_VIEW,
      outcome: 'paid',
      recipientId: MANDATE,
      from: '2026-11-01',
      to: '2026-11-30',
    });
    expect(q.status).toBe('paid');
    expect(q.recipientId).toBe(MANDATE);
    expect(q.mandateId).toBeUndefined();
    expect(q.createdFrom).toBe(new Date(2026, 10, 1).toISOString());
    expect(q.createdTo).toBe(new Date(2026, 11, 1).toISOString());
  });

  it('sends nothing for an open view', () => {
    expect(
      Object.values(receiptServerQuery(DEFAULT_RECEIPT_VIEW)).every((v) => v === undefined),
    ).toBe(true);
  });
});

describe('rows and names', () => {
  it('puts the newest issued first, with a stable tie', () => {
    const a = row('00000000-0000-4000-8000-00000000000a', '2026-11-25T12:00:00.000Z');
    const b = row('00000000-0000-4000-8000-00000000000b', '2026-11-26T12:00:00.000Z');
    const c = row('00000000-0000-4000-8000-00000000000c', '2026-11-25T12:00:00.000Z');
    expect(sortReceipts([c, a, b]).map((r) => r.id.slice(-1))).toEqual(['b', 'a', 'c']);
  });

  it('names the file by the local day and counts in words', () => {
    expect(receiptsCsvName(new Date(2026, 0, 5))).toBe('ujira-receipts-2026-01-05.csv');
    expect(receiptCount(1)).toBe('1 receipt');
    expect(receiptCount(12_500)).toBe('12,500 receipts');
  });
});

describe('what verify found', () => {
  it('says it matched', () => {
    expect(verifyWords({ matched: true, field: null, txHash: 'ab' })).toEqual({
      matched: true,
      title: 'Matches Stellar',
      text: '',
    });
  });

  it('names the field that differs', () => {
    expect(verifyWords({ matched: false, field: 'amount', txHash: 'ab' }).text).toBe(
      'Stellar shows a different amount.',
    );
    expect(verifyWords({ matched: false, field: 'destination', txHash: 'ab' }).text).toBe(
      'Stellar shows a different destination.',
    );
    expect(verifyWords({ matched: false, field: 'mandate', txHash: 'ab' })).toEqual({
      matched: false,
      title: 'Does not match Stellar',
      text: 'Stellar shows a different mandate.',
    });
    expect(verifyWords({ matched: false, field: 'recipientRef', txHash: 'ab' }).text).toBe(
      'Stellar shows a different recipient ref.',
    );
  });

  it('says when Stellar has no such transaction', () => {
    expect(verifyWords({ matched: false, field: 'txHash', txHash: null }).text).toBe(
      'Stellar has no matching transaction.',
    );
  });

  it('never echoes a field name that is not a name', () => {
    expect(verifyWords({ matched: false, field: '<img src=x>', txHash: null }).text).toBe(
      'Stellar shows something else.',
    );
    expect(verifyWords({ matched: false, field: null, txHash: null }).text).toBe(
      'Stellar shows something else.',
    );
  });
});
