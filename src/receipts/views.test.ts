// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// How a receipt reads on the wire and in the CSV file, for a receipt the
// worker issued and for one imported from the old receipt log. The wire
// fields are the ones the console's recorded answers expect.

import { fileURLToPath } from 'node:url';

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { IDS, ISSUED, blockedReceipt, paidReceipt, usdc } from '../../test/receipt-fixtures.js';
import { receiptRef } from '../chain/stellar/wallet-proof.js';
import type { ReceiptDetail } from '../db/index.js';
import { documentSha256, receiptDocument } from './document.js';
import { ReceiptLegacyInvalidError } from './errors.js';
import { CSV_COLUMNS, csvCell, csvRow, receiptsCsv } from './export.js';
import { ReceiptLog, type Receipt as LogReceipt } from './log.js';
import { receiptFromDetail, receiptFromLegacy, type LegacyReceiptIds } from './model.js';
import { formatAmount, maskDestination, receiptWire } from './views.js';

// RFC 4180, the other way round, so the writer is tested by what a reader gets.
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text.charAt(i);
    if (quoted) {
      if (char === '"' && text.charAt(i + 1) === '"') {
        cell += '"';
        i += 1;
      } else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') {
      row.push(cell);
      cell = '';
    } else if (char === '\r' && text.charAt(i + 1) === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      i += 1;
    } else cell += char;
  }
  return rows;
}

function rowsOf(text: string): Record<string, string>[] {
  const [header = [], ...rows] = parseCsv(text);
  return rows.map((row) => Object.fromEntries(header.map((name, i) => [name, row[i] ?? ''])));
}

describe('receiptWire', () => {
  it('answers the fields the console reads, with money in minor units', () => {
    const wire = receiptWire(paidReceipt());
    expect(wire).toMatchObject({
      id: IDS.receipt,
      payoutId: IDS.payout,
      mandate: { id: IDS.mandate, contractId: paidReceipt().mandate.contractId },
      recipient: { id: IDS.recipient, label: 'Ada' },
      taskId: 'demo-20261113T1101-01',
      amount: { amount: '50000000', asset: 'USDC', network: 'stellar:testnet', scale: 7 },
      fee: { amount: '0', asset: 'USDC', network: 'stellar:testnet', scale: 7 },
      outcome: 'paid',
      blockedBy: null,
      txHash: paidReceipt().txHash,
      ref: paidReceipt().ref,
      issuedAt: '2026-11-25T12:00:10.000Z',
    });
    expect(wire.legs[0]?.destination).toBe('GDWQ...FPLX');
    expect(wire.documentSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('names the refusing rule of a blocked payout, with no transaction', () => {
    const wire = receiptWire(blockedReceipt());
    expect(wire).toMatchObject({
      outcome: 'blocked',
      blockedBy: 'PER_PAYMENT_CAP_EXCEEDED',
      txHash: null,
      ref: null,
    });
  });
});

describe('receiptFromDetail', () => {
  const detail = (status: 'paid' | 'cancelled'): ReceiptDetail => ({
    receipt: {
      id: IDS.receipt,
      projectId: IDS.project,
      payoutId: IDS.payout,
      status,
      blockedBy: null,
      network: 'stellar:testnet',
      amount: usdc(25_000_000n),
      fee: usdc(0n),
      chainReceiptRef: status === 'paid' ? receiptRef('stellar:testnet', 'd'.repeat(64), 0) : null,
      requestTxHash: 'e'.repeat(64),
      settledAt: status === 'paid' ? ISSUED : null,
      createdAt: ISSUED,
    },
    principalId: IDS.principal,
    taskId: 'task-42',
    mandate: { id: IDS.mandate, contractAddress: 'C'.repeat(56) },
    recipient: { id: IDS.recipient, label: 'Ada', recipientRef: 'c'.repeat(64) },
    legs: [
      { index: 0, destination: 'G'.repeat(56), amount: usdc(25_000_000n), txHash: 'd'.repeat(64) },
    ],
  });

  it('takes the transaction from the leg that paid', () => {
    expect(receiptFromDetail(detail('paid'))).toMatchObject({
      outcome: 'paid',
      txHash: 'd'.repeat(64),
      ref: `ujira:tx:v1:stellar:testnet:${'d'.repeat(64)}:0`,
      issuedAt: ISSUED,
    });
  });

  it('names no transaction for a payout that did not pay', () => {
    expect(receiptFromDetail(detail('cancelled'))).toMatchObject({ txHash: null, ref: null });
  });
});

describe('the CSV export', () => {
  it('starts with the columns the console shows, formatted, then the minor units', () => {
    expect(CSV_COLUMNS.slice(0, 10)).toEqual([
      'receipt_id',
      'payout_id',
      'task_id',
      'recipient',
      'amount',
      'asset',
      'outcome',
      'blocked_by',
      'tx_hash',
      'issued_at',
    ]);
    const receipt = paidReceipt({
      amount: usdc(25_000_000n),
      legs: [{ index: 0, destination: 'G'.repeat(56), amount: usdc(25_000_000n), txHash: null }],
    });
    const [row] = rowsOf(receiptsCsv([receipt, blockedReceipt()]));
    expect(row).toMatchObject({
      receipt_id: IDS.receipt,
      payout_id: IDS.payout,
      recipient: 'Ada',
      amount: '2.5',
      asset: 'USDC',
      outcome: 'paid',
      blocked_by: '',
      issued_at: '2026-11-25T12:00:10.000Z',
      amount_minor: '25000000',
      fee_minor: '0',
      scale: '7',
      network: 'stellar:testnet',
      document_sha256: documentSha256(receipt),
    });
    const rows = rowsOf(receiptsCsv([receipt, blockedReceipt()]));
    expect(rows[1]).toMatchObject({ blocked_by: 'PER_PAYMENT_CAP_EXCEEDED', tx_hash: '', ref: '' });
  });

  it('keeps text a spreadsheet would run from running, and quotes what needs it', () => {
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell('+1')).toBe("'+1");
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('plain')).toBe('plain');
    const tricky = paidReceipt({
      taskId: 'task, "quoted"',
      recipient: { id: IDS.recipient, label: '@home\nlabel', ref: null },
    });
    const [row] = rowsOf(receiptsCsv([tricky]));
    expect(row).toMatchObject({ task_id: 'task, "quoted"', recipient: "'@home\nlabel" });
    expect(csvRow(tricky).endsWith('\r\n')).toBe(true);
  });
});

describe('formatAmount', () => {
  it('writes the token unit with no trailing zeros', () => {
    expect(formatAmount(usdc(25_000_000n))).toBe('2.5');
    expect(formatAmount(usdc(10_000_000n))).toBe('1');
    expect(formatAmount(usdc(1n))).toBe('0.0000001');
    expect(formatAmount(usdc(0n))).toBe('0');
    expect(formatAmount(usdc(123_456_789_012_345_678_901n))).toBe('12345678901234.5678901');
  });

  it('reads back as the minor units it came from', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 10n ** 30n }), (amount) => {
        const [whole = '', frac = ''] = formatAmount(usdc(amount)).split('.');
        expect(BigInt(whole) * 10_000_000n + BigInt(frac.padEnd(7, '0'))).toBe(amount);
      }),
    );
  });

  it('masks a destination as the rest of /v1 does', () => {
    expect(maskDestination('GDWQCLVZKFKKIQGXOSRZRLOBJ4V5J6UQ2L5D3RC4Y3IGEJXFZ4VJFPLX')).toBe(
      'GDWQ...FPLX',
    );
  });
});

describe('the document hash', () => {
  it('changes when any amount, destination or reference changes', () => {
    const base = documentSha256(paidReceipt());
    expect(documentSha256(paidReceipt())).toBe(base);
    expect(documentSha256(paidReceipt({ amount: usdc(1n) }))).not.toBe(base);
    expect(documentSha256(paidReceipt({ txHash: 'f'.repeat(64) }))).not.toBe(base);
    expect(documentSha256(blockedReceipt())).not.toBe(base);
  });

  it('leaves out the label, which is the principal own name for a person', () => {
    const relabelled = paidReceipt({ recipient: { ...paidReceipt().recipient, label: 'Someone' } });
    expect(documentSha256(relabelled)).toBe(documentSha256(paidReceipt()));
    expect(JSON.stringify(receiptDocument(paidReceipt()))).not.toContain('Ada');
  });
});

describe('receipts from the old receipt log', () => {
  const ids = (n: number): LegacyReceiptIds => ({
    id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    payoutId: `00000000-0000-4000-9000-${String(n).padStart(12, '0')}`,
    principalId: IDS.principal,
    projectId: IDS.project,
    mandateId: IDS.mandate,
    recipientId: IDS.recipient,
    receiptRef: (hash, index) => receiptRef('stellar:testnet', hash, index),
  });

  it('renders every entry of the recorded testnet log through the same views', async () => {
    const path = fileURLToPath(new URL('../../evidence/receipts.json', import.meta.url));
    const log = new ReceiptLog(path);
    const entries = await log.list('CDEEDQ64YS6XHBTWC3QLS5JWOLI3LSO46VDDZE66FW6CZGHZNRDV4GZW');
    expect(entries.length).toBeGreaterThan(0);
    const views = entries.map((entry, n) => receiptFromLegacy(entry, ids(n)));
    for (const [n, view] of views.entries()) {
      const entry = entries[n] as LogReceipt;
      const wire = receiptWire(view);
      expect(wire.taskId).toBe(entry.task_id);
      expect(wire.amount.amount).toBe(entry.amount.toString());
      expect(wire.network).toBe('stellar:testnet');
      if (wire.outcome === 'paid') {
        expect(wire.txHash).toBe(entry.tx_hash);
        expect(wire.ref).toBe(`ujira:tx:v1:stellar:testnet:${entry.tx_hash ?? ''}:0`);
        expect(wire.blockedBy).toBeNull();
      }
      if (wire.outcome === 'blocked') {
        expect(wire.txHash).toBeNull();
        expect(wire.blockedBy).toMatch(/^[A-Z][A-Z0-9_]*$/);
      }
    }
    expect(views.some((view) => view.outcome === 'paid')).toBe(true);
    expect(views.some((view) => view.outcome === 'blocked')).toBe(true);
    const rows = rowsOf(receiptsCsv(views));
    expect(rows).toHaveLength(views.length);
  });

  it('maps every old outcome to a payout status', () => {
    const entry = (over: Partial<LogReceipt>): LogReceipt => ({
      task_id: 't',
      mandate: 'C'.repeat(56),
      principal: 'G'.repeat(56),
      agent: 'G'.repeat(56),
      network: 'testnet',
      recipient: 'G'.repeat(56),
      destination: 'G'.repeat(56),
      amount: 5n,
      asset: 'USDC',
      rail: 'stellar.wallet',
      outcome: 'paid',
      tx_hash: 'a'.repeat(64),
      created_at: '2026-11-13T11:01:23.698Z',
      updated_at: '2026-11-13T11:01:23.698Z',
      ...over,
    });
    expect(receiptFromLegacy(entry({ outcome: 'approved_then_paid' }), ids(1)).outcome).toBe(
      'paid',
    );
    expect(receiptFromLegacy(entry({ outcome: 'approval_required' }), ids(1))).toMatchObject({
      outcome: 'pending_approval',
      txHash: null,
    });
    expect(receiptFromLegacy(entry({ outcome: 'settling' }), ids(1)).outcome).toBe('settling');
    expect(
      receiptFromLegacy(entry({ outcome: 'blocked', reason: 'daily_cap_exceeded' }), ids(1)),
    ).toMatchObject({ blockedBy: 'DAILY_CAP_EXCEEDED', txHash: null, ref: null });
    expect(receiptFromLegacy(entry({}), { ...ids(1), recipientLabel: 'Ada' }).recipient.label).toBe(
      'Ada',
    );
    for (const bad of [
      entry({ network: 'mars' }),
      entry({ asset: 'EURC' }),
      entry({ network: 'celo:mainnet' }),
      entry({ tx_hash: undefined }),
      entry({ updated_at: 'not a date' }),
    ]) {
      expect(() => receiptFromLegacy(bad, ids(1))).toThrow(ReceiptLegacyInvalidError);
    }
  });
});
