// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// Receipts as a CSV file a principal keeps. The first ten columns are the
// ones the console has always shown, with the amount formatted; the rest
// carry the exact minor units, the scale and the references, so a row can be
// reconciled and checked against its document hash without the API.

import { documentSha256 } from './document.js';
import type { ReceiptView } from './model.js';
import { formatAmount } from './views.js';

export const CSV_COLUMNS = [
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
  'amount_minor',
  'fee_minor',
  'scale',
  'network',
  'mandate_id',
  'contract_id',
  'recipient_id',
  'ref',
  'document_sha256',
] as const;

export type CsvColumn = (typeof CSV_COLUMNS)[number];

// RFC 4180 line ends.
const EOL = '\r\n';

// A spreadsheet runs a cell that starts with one of these as a formula, and a
// task id or a label is text someone else chose.
const FORMULA_START = /^[=+\-@\t\r]/;

export function csvCell(value: string): string {
  const safe = FORMULA_START.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

export function csvHeader(): string {
  return `${CSV_COLUMNS.join(',')}${EOL}`;
}

export function csvRow(r: ReceiptView): string {
  const cells: Readonly<Record<CsvColumn, string>> = {
    receipt_id: r.id,
    payout_id: r.payoutId,
    task_id: r.taskId,
    recipient: r.recipient.label,
    amount: formatAmount(r.amount),
    asset: r.amount.asset,
    outcome: r.outcome,
    blocked_by: r.blockedBy ?? '',
    tx_hash: r.txHash ?? '',
    issued_at: r.issuedAt.toISOString(),
    amount_minor: r.amount.amount.toString(),
    fee_minor: r.fee.amount.toString(),
    scale: String(r.amount.scale),
    network: r.network,
    mandate_id: r.mandate.id,
    contract_id: r.mandate.contractId,
    recipient_id: r.recipient.id,
    ref: r.ref ?? '',
    document_sha256: documentSha256(r),
  };
  return `${CSV_COLUMNS.map((column) => csvCell(cells[column])).join(',')}${EOL}`;
}

/** The whole file for a list held in memory; the route streams page by page instead. */
export function receiptsCsv(list: readonly ReceiptView[]): string {
  return csvHeader() + list.map(csvRow).join('');
}
