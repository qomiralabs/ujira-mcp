// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// What the payouts screen works out from /v1 payouts: the view a person has
// chosen (filters, sort and the open payout), read from and written to the
// URL so a reload or a shared link shows the same thing; the query the server
// filters on; the sort, which compares amounts as bigint; the timeline of a
// payout; and the CSV of the filtered set.

import { formatAmount } from './money';
import type { PayoutQuery } from './v1';
import type { PayoutDetail } from './v1Schemas';
import { statusWord } from './words';

export const STATUS_FILTERS = [
  { value: '', label: 'Any status', codes: [] },
  { value: 'paid', label: 'Paid', codes: ['paid'] },
  { value: 'moving', label: 'On the way', codes: ['queued', 'submitting', 'approved', 'settling'] },
  { value: 'waiting', label: 'Waiting for approval', codes: ['pending_approval'] },
  { value: 'blocked', label: 'Blocked', codes: ['blocked'] },
  { value: 'rejected', label: 'Rejected', codes: ['rejected'] },
  { value: 'attention', label: 'Needs a look', codes: ['needs_attention'] },
  { value: 'failed', label: 'Failed', codes: ['failed'] },
  { value: 'cancelled', label: 'Cancelled', codes: ['cancelled'] },
] as const;

export type StatusFilter = (typeof STATUS_FILTERS)[number]['value'];

export const SORT_KEYS = ['created', 'settled', 'amount', 'recipient', 'status'] as const;
export type SortKey = (typeof SORT_KEYS)[number];
export type SortDir = 'asc' | 'desc';

export interface PayoutView {
  readonly status: StatusFilter;
  readonly mandateId: string | null;
  readonly recipientId: string | null;
  /** The first day shown, YYYY-MM-DD in the person's own time zone. */
  readonly from: string | null;
  /** The last day shown, included. */
  readonly to: string | null;
  readonly sort: SortKey;
  readonly dir: SortDir;
  /** The payout open in the side sheet. */
  readonly open: string | null;
}

export const DEFAULT_VIEW: PayoutView = {
  status: '',
  mandateId: null,
  recipientId: null,
  from: null,
  to: null,
  sort: 'created',
  dir: 'desc',
  open: null,
};

// The URL is input anyone can type or send, so each value is checked and
// anything unknown is dropped rather than passed to the server.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

const PARAMS = ['status', 'mandate', 'recipient', 'from', 'to', 'sort', 'dir', 'payout'] as const;

function uuidOrNull(raw: string | null): string | null {
  return raw !== null && UUID.test(raw) ? raw : null;
}

function localDay(day: string): Date | null {
  const m = DAY.exec(day);
  if (m === null) return null;
  const [y, mo, d] = [m[1], m[2], m[3]].map((x) => Number.parseInt(x ?? '', 10));
  if (y === undefined || mo === undefined || d === undefined) return null;
  const date = new Date(y, mo - 1, d);
  // Refuses days that do not exist, such as 2026-02-30.
  if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d) return null;
  return date;
}

function dayOrNull(raw: string | null): string | null {
  return raw !== null && localDay(raw) !== null ? raw : null;
}

function isStatusFilter(raw: string): raw is StatusFilter {
  return STATUS_FILTERS.some((f) => f.value === raw);
}

function isSortKey(raw: string): raw is SortKey {
  return (SORT_KEYS as readonly string[]).includes(raw);
}

/** The view a query string asks for. */
export function parseView(search: string): PayoutView {
  const p = new URLSearchParams(search);
  const status = p.get('status') ?? '';
  const sort = p.get('sort') ?? '';
  const dir = p.get('dir');
  return {
    status: isStatusFilter(status) ? status : '',
    mandateId: uuidOrNull(p.get('mandate')),
    recipientId: uuidOrNull(p.get('recipient')),
    from: dayOrNull(p.get('from')),
    to: dayOrNull(p.get('to')),
    sort: isSortKey(sort) ? sort : DEFAULT_VIEW.sort,
    dir: dir === 'asc' || dir === 'desc' ? dir : DEFAULT_VIEW.dir,
    open: uuidOrNull(p.get('payout')),
  };
}

/** The query string for a view, keeping the params that belong to others (mock mode). */
export function viewSearch(view: PayoutView, current: string): string {
  const p = new URLSearchParams(current);
  for (const name of PARAMS) p.delete(name);
  const set = (name: string, value: string | null, skip: string | null = null) => {
    if (value !== null && value !== '' && value !== skip) p.set(name, value);
  };
  set('status', view.status);
  set('mandate', view.mandateId);
  set('recipient', view.recipientId);
  set('from', view.from);
  set('to', view.to);
  set('sort', view.sort, DEFAULT_VIEW.sort);
  set('dir', view.dir, DEFAULT_VIEW.dir);
  set('payout', view.open);
  const qs = p.toString();
  return qs === '' ? '' : `?${qs}`;
}

/** True when the view narrows the list at all. */
export function isFiltered(view: PayoutView): boolean {
  return (
    view.status !== '' ||
    view.mandateId !== null ||
    view.recipientId !== null ||
    view.from !== null ||
    view.to !== null
  );
}

/** What the server filters on. Days are whole local days; the end is exclusive. */
export function serverQuery(view: PayoutView): PayoutQuery {
  const codes = STATUS_FILTERS.find((f) => f.value === view.status)?.codes ?? [];
  const from = view.from === null ? null : localDay(view.from);
  const to = view.to === null ? null : localDay(view.to);
  const dayAfter = to === null ? null : new Date(to.getFullYear(), to.getMonth(), to.getDate() + 1);
  return {
    status: codes.length === 0 ? undefined : codes.join(','),
    mandateId: view.mandateId ?? undefined,
    recipientId: view.recipientId ?? undefined,
    createdFrom: from === null ? undefined : from.toISOString(),
    createdTo: dayAfter === null ? undefined : dayAfter.toISOString(),
  };
}

function cmpText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function cmpAmount(a: PayoutDetail, b: PayoutDetail): number {
  if (a.amount.asset !== b.amount.asset) return cmpText(a.amount.asset, b.amount.asset);
  if (a.amount.scale !== b.amount.scale) {
    // Brings both to the larger scale before comparing, so 1.0 and 1.00 tie.
    const scale = Math.max(a.amount.scale, b.amount.scale);
    const x = a.amount.amount * 10n ** BigInt(scale - a.amount.scale);
    const y = b.amount.amount * 10n ** BigInt(scale - b.amount.scale);
    return x < y ? -1 : x > y ? 1 : 0;
  }
  return a.amount.amount < b.amount.amount ? -1 : a.amount.amount > b.amount.amount ? 1 : 0;
}

/** A sorted copy. Ties fall back to newest first, then the id, so the order is stable. */
export function sortPayouts(
  items: readonly PayoutDetail[],
  key: SortKey,
  dir: SortDir,
): PayoutDetail[] {
  const sign = dir === 'asc' ? 1 : -1;
  const tie = (a: PayoutDetail, b: PayoutDetail) =>
    cmpText(b.createdAt, a.createdAt) || cmpText(a.id, b.id);
  const by = (a: PayoutDetail, b: PayoutDetail): number => {
    switch (key) {
      case 'created':
        return sign * cmpText(a.createdAt, b.createdAt);
      case 'settled':
        // Not settled yet goes last in both directions.
        if (a.settledAt === null || b.settledAt === null) {
          return (a.settledAt === null ? 1 : 0) - (b.settledAt === null ? 1 : 0);
        }
        return sign * cmpText(a.settledAt, b.settledAt);
      case 'amount':
        return sign * cmpAmount(a, b);
      case 'recipient':
        return (
          sign *
          a.recipient.label.localeCompare(b.recipient.label, undefined, {
            sensitivity: 'base',
          })
        );
      case 'status':
        return sign * statusWord(a.status).label.localeCompare(statusWord(b.status).label);
    }
  };
  return [...items].sort((a, b) => by(a, b) || tie(a, b));
}

const METHODS: Record<string, string> = {
  'stellar.wallet': 'Stellar wallet',
  'demo.sdp': 'SDP demo',
};

export function methodLabel(method: string): string {
  const known = METHODS[method];
  if (known !== undefined) return known;
  const words = method.replace(/[._-]+/g, ' ').trim();
  return words === '' ? 'Unknown' : `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
}

/** How a payout reaches the person: one rail, or a split across legs. */
export function methodOf(p: PayoutDetail): string {
  if (p.legs.length > 1) return `Split, ${String(p.legs.length)} legs`;
  return methodLabel(p.legs[0]?.method ?? '');
}

export type StepState = 'done' | 'now' | 'stopped' | 'later';

export interface Step {
  readonly key: string;
  readonly label: string;
  readonly state: StepState;
  readonly at: string | null;
}

/**
 * The path a payout has taken, left to right. Only what the status proves is
 * marked done; a payout that ends early stops at the step that ended it.
 */
export function timelineOf(p: PayoutDetail): Step[] {
  const ended = p.settledAt ?? p.updatedAt;
  const requested: Step = { key: 'requested', label: 'Requested', state: 'done', at: p.createdAt };
  const check = (state: StepState): Step => ({
    key: 'check',
    label: 'Mandate check',
    state,
    at: null,
  });
  const approval = (state: StepState): Step => ({
    key: 'approval',
    label: 'Approval',
    state,
    at: null,
  });
  const end = (label: string, state: StepState, at: string | null = null): Step => ({
    key: 'end',
    label,
    state,
    at,
  });
  switch (p.status) {
    case 'queued':
      return [{ ...requested, state: 'now' }, check('later'), end('Paid', 'later')];
    case 'submitting':
      return [requested, check('now'), end('Paid', 'later')];
    case 'pending_approval':
      return [requested, check('done'), approval('now'), end('Paid', 'later')];
    case 'approved':
    case 'settling':
      return [requested, check('done'), approval('done'), end('Paying', 'now')].filter(
        (s) => p.status === 'approved' || s.key !== 'approval',
      );
    case 'paid':
      return [requested, check('done'), end('Paid', 'done', ended)];
    case 'blocked':
      return [requested, end('Blocked', 'stopped', ended)];
    case 'rejected':
      return [requested, check('done'), end('Rejected', 'stopped', ended)];
    case 'cancelled':
      return [requested, check('done'), end('Cancelled', 'stopped', ended)];
    case 'failed':
      return [requested, end('Failed', 'stopped', ended)];
    case 'needs_attention':
      return p.requestTxHash === null
        ? [requested, end('Needs a look', 'stopped')]
        : [requested, check('done'), end('Needs a look', 'stopped')];
    default:
      return [requested, end(statusWord(p.status).label, 'now')];
  }
}

// A cell that starts like a formula is quoted, so a spreadsheet shows it as text.
function csvCell(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

const CSV_HEADER = [
  'payout_id',
  'created_at',
  'settled_at',
  'recipient',
  'recipient_id',
  'amount',
  'asset',
  'status',
  'blocked_by',
  'method',
  'mandate',
  'mandate_id',
  'task_id',
  'request_tx_hash',
  'tx_hash',
  'receipt_id',
].join(',');

/** The payouts as CSV, in the order given. Amounts are exact decimals in their own asset. */
export function payoutsCsv(
  items: readonly PayoutDetail[],
  mandateLabel: (p: PayoutDetail) => string,
): string {
  const rows = items.map((p) =>
    [
      p.id,
      p.createdAt,
      p.settledAt ?? '',
      p.recipient.label,
      p.recipient.id,
      formatAmount(p.amount.amount, { decimals: p.amount.scale, grouping: false }),
      p.amount.asset,
      p.status,
      p.blockedBy ?? '',
      methodOf(p),
      mandateLabel(p),
      p.mandate.id,
      p.taskId,
      p.requestTxHash ?? '',
      p.legs
        .map((l) => l.txHash)
        .filter((h) => h !== null)
        .join(' '),
      p.receiptId ?? '',
    ]
      .map(csvCell)
      .join(','),
  );
  return `${[CSV_HEADER, ...rows].join('\n')}\n`;
}

export function csvFileName(at: Date = new Date()): string {
  const two = (n: number) => String(n).padStart(2, '0');
  return `ujira-payouts-${String(at.getFullYear())}-${two(at.getMonth() + 1)}-${two(at.getDate())}.csv`;
}
