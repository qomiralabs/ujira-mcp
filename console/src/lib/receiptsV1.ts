// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// What the receipts screen works out from /v1 receipts: the view a person has
// chosen (filters and the open receipt), read from and written to the URL so
// a reload or a shared link shows the same thing; the query the server
// filters on, which the CSV export takes too; the order of the rows; and the
// words for what the verify route found on Stellar.

import { localDay } from './payoutsV1';
import type { PayoutQuery } from './v1';
import type { ReceiptVerification, V1Receipt } from './v1Schemas';

// A receipt is written once a payout ends, so only the end states are offered.
export const OUTCOME_FILTERS = [
  { value: '', label: 'Any outcome' },
  { value: 'paid', label: 'Paid' },
  { value: 'blocked', label: 'Blocked' },
  { value: 'rejected', label: 'Rejected' },
  { value: 'cancelled', label: 'Cancelled' },
  { value: 'failed', label: 'Failed' },
] as const;

export type OutcomeFilter = (typeof OUTCOME_FILTERS)[number]['value'];

export interface ReceiptView {
  readonly outcome: OutcomeFilter;
  readonly mandateId: string | null;
  readonly recipientId: string | null;
  /** The first day shown, YYYY-MM-DD in the person's own time zone. */
  readonly from: string | null;
  /** The last day shown, included. */
  readonly to: string | null;
  /** The receipt open in the side sheet. */
  readonly open: string | null;
}

export const DEFAULT_RECEIPT_VIEW: ReceiptView = {
  outcome: '',
  mandateId: null,
  recipientId: null,
  from: null,
  to: null,
  open: null,
};

// The URL is input anyone can type or send, so each value is checked and
// anything unknown is dropped rather than passed to the server.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const PARAMS = ['outcome', 'mandate', 'recipient', 'from', 'to', 'receipt'] as const;

function uuidOrNull(raw: string | null): string | null {
  return raw !== null && UUID.test(raw) ? raw : null;
}

function dayOrNull(raw: string | null): string | null {
  return raw !== null && localDay(raw) !== null ? raw : null;
}

function isOutcome(raw: string): raw is OutcomeFilter {
  return OUTCOME_FILTERS.some((f) => f.value === raw);
}

/** The view a query string asks for. */
export function parseReceiptView(search: string): ReceiptView {
  const p = new URLSearchParams(search);
  const outcome = p.get('outcome') ?? '';
  return {
    outcome: isOutcome(outcome) ? outcome : '',
    mandateId: uuidOrNull(p.get('mandate')),
    recipientId: uuidOrNull(p.get('recipient')),
    from: dayOrNull(p.get('from')),
    to: dayOrNull(p.get('to')),
    open: uuidOrNull(p.get('receipt')),
  };
}

/** The query string for a view, keeping the params that belong to others (mock mode). */
export function receiptViewSearch(view: ReceiptView, current: string): string {
  const p = new URLSearchParams(current);
  for (const name of PARAMS) p.delete(name);
  const set = (name: string, value: string | null) => {
    if (value !== null && value !== '') p.set(name, value);
  };
  set('outcome', view.outcome);
  set('mandate', view.mandateId);
  set('recipient', view.recipientId);
  set('from', view.from);
  set('to', view.to);
  set('receipt', view.open);
  const qs = p.toString();
  return qs === '' ? '' : `?${qs}`;
}

/** True when the view narrows the list at all. */
export function isReceiptFiltered(view: ReceiptView): boolean {
  return (
    view.outcome !== '' ||
    view.mandateId !== null ||
    view.recipientId !== null ||
    view.from !== null ||
    view.to !== null
  );
}

/**
 * What the server filters on, for the list and the CSV alike. The outcome
 * goes in `status`, the name the payout list uses. Days are whole local days
 * on the issue date; the end is exclusive.
 */
export function receiptServerQuery(view: ReceiptView): PayoutQuery {
  const from = view.from === null ? null : localDay(view.from);
  const to = view.to === null ? null : localDay(view.to);
  const dayAfter = to === null ? null : new Date(to.getFullYear(), to.getMonth(), to.getDate() + 1);
  return {
    status: view.outcome === '' ? undefined : view.outcome,
    mandateId: view.mandateId ?? undefined,
    recipientId: view.recipientId ?? undefined,
    createdFrom: from === null ? undefined : from.toISOString(),
    createdTo: dayAfter === null ? undefined : dayAfter.toISOString(),
  };
}

/** Newest issued first; the id breaks a tie so the order is stable. */
export function sortReceipts(items: readonly V1Receipt[]): V1Receipt[] {
  const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  return [...items].sort((a, b) => cmp(b.issuedAt, a.issuedAt) || cmp(a.id, b.id));
}

export function receiptsCsvName(at: Date = new Date()): string {
  const two = (n: number) => String(n).padStart(2, '0');
  return `ujira-receipts-${String(at.getFullYear())}-${two(at.getMonth() + 1)}-${two(at.getDate())}.csv`;
}

export function receiptCount(n: number): string {
  return n === 1 ? '1 receipt' : `${n.toLocaleString('en-US')} receipts`;
}

const FIELD_WORDS: Record<string, string> = {
  amount: 'amount',
  asset: 'asset',
  destination: 'destination',
  recipient: 'recipient',
  mandate: 'mandate',
  network: 'network',
  fee: 'fee',
};

// Field names the server uses for the transaction itself.
const TX_FIELDS = new Set(['txhash', 'transaction', 'tx']);

/** A field name in plain words: "recipientRef" reads "recipient ref". */
function fieldWords(field: string): string | null {
  const known = FIELD_WORDS[field] ?? FIELD_WORDS[field.toLowerCase()];
  if (known !== undefined) return known;
  if (!/^[A-Za-z][A-Za-z0-9_.]{0,47}$/.test(field)) return null;
  return field
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_.]+/g, ' ')
    .toLowerCase();
}

export interface VerifyWords {
  readonly matched: boolean;
  readonly title: string;
  /** One line under the title; empty when the title says it all. */
  readonly text: string;
}

/** What a verify answer means, in a title and at most one line. */
export function verifyWords(v: ReceiptVerification): VerifyWords {
  if (v.matched) return { matched: true, title: 'Matches Stellar', text: '' };
  const title = 'Does not match Stellar';
  if (v.field === null) return { matched: false, title, text: 'Stellar shows something else.' };
  if (TX_FIELDS.has(v.field.toLowerCase())) {
    return { matched: false, title, text: 'Stellar has no matching transaction.' };
  }
  const words = fieldWords(v.field);
  return {
    matched: false,
    title,
    text: words === null ? 'Stellar shows something else.' : `Stellar shows a different ${words}.`,
  };
}
