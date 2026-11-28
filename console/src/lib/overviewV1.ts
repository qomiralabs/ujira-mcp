// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// What the overview works out from /v1 answers: what the project's mandates
// hold, its payouts by status and by the rule that blocked them, the period
// in words, and the first steps of a new project. Amounts stay bigint; counts
// are the server's own integers, only ever added up.

import type { ApiKey, Overview, OverviewMandate, TokenAmount } from './v1Schemas';

export interface Holding {
  /** Everything the mandates hold in this token. */
  readonly balance: TokenAmount;
  /** What they can still pay out. */
  readonly free: TokenAmount;
  /** Set aside for payouts that wait for approval. */
  readonly committed: TokenAmount;
}

function sameToken(a: TokenAmount, b: TokenAmount): boolean {
  return a.asset === b.asset && a.network === b.network && a.scale === b.scale;
}

function plus(a: TokenAmount, b: TokenAmount): TokenAmount {
  return { ...a, amount: a.amount + b.amount };
}

/**
 * What every mandate the chain answered for holds, added up per token, in the
 * order the tokens first appear. A mandate without a state adds nothing.
 */
export function holdings(mandates: readonly Pick<OverviewMandate, 'state'>[]): Holding[] {
  const out: Holding[] = [];
  for (const m of mandates) {
    const s = m.state;
    if (s === null) continue;
    const i = out.findIndex((h) => sameToken(h.balance, s.balance));
    const found = out[i];
    if (found === undefined) {
      out.push({ balance: s.balance, free: s.free, committed: s.committed });
    } else {
      out[i] = {
        balance: plus(found.balance, s.balance),
        free: plus(found.free, s.free),
        committed: plus(found.committed, s.committed),
      };
    }
  }
  return out;
}

/** How many mandates the chain did not answer for, so their money is not in the totals. */
export function unreadCount(mandates: readonly Pick<OverviewMandate, 'state'>[]): number {
  return mandates.filter((m) => m.state === null).length;
}

/** A holding of nothing, for a project that has no mandate yet. */
export function emptyHolding(unit: Omit<TokenAmount, 'amount'>): Holding {
  const zero: TokenAmount = { ...unit, amount: 0n };
  return { balance: zero, free: zero, committed: zero };
}

// The order a person reads a payout's life in: done, moving, stopped.
const STATUS_ORDER = [
  'paid',
  'settling',
  'approved',
  'pending_approval',
  'submitting',
  'queued',
  'needs_attention',
  'blocked',
  'rejected',
  'cancelled',
  'failed',
];

export interface CountRow {
  readonly code: string;
  readonly count: number;
}

/** The statuses that have payouts, in reading order; codes the console does not know go last. */
export function statusRows(byStatus: Readonly<Record<string, number>>): CountRow[] {
  const rank = (code: string) => {
    const i = STATUS_ORDER.indexOf(code);
    return i === -1 ? STATUS_ORDER.length : i;
  };
  return Object.entries(byStatus)
    .filter(([, count]) => count > 0)
    .map(([code, count]) => ({ code, count }))
    .sort((a, b) => rank(a.code) - rank(b.code) || a.code.localeCompare(b.code));
}

/** The rules that blocked payouts, the one that blocked most first. */
export function ruleRows(blockedByRule: Readonly<Record<string, number>>): CountRow[] {
  return Object.entries(blockedByRule)
    .filter(([, count]) => count > 0)
    .map(([code, count]) => ({ code, count }))
    .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code));
}

/** How many payouts the period counted, every status together. */
export function payoutCount(byStatus: Readonly<Record<string, number>>): number {
  return Object.values(byStatus).reduce((sum, n) => sum + n, 0);
}

function format(
  locale: string | undefined,
  timeZone: string | undefined,
  options: Intl.DateTimeFormatOptions,
): Intl.DateTimeFormat {
  try {
    return new Intl.DateTimeFormat(locale, { ...options, timeZone });
  } catch {
    // A zone this browser does not know: its own zone is the nearest honest answer.
    return new Intl.DateTimeFormat(locale, options);
  }
}

/**
 * The period as days, "1 Nov to 28 Nov", in the zone the server counted in.
 * The end the server sends is exclusive, so the last day shown is the day
 * before it. The year shows only when the period crosses one.
 */
export function periodText(period: Overview['period'], locale?: string): string {
  const from = Date.parse(period.from);
  const to = Date.parse(period.to);
  if (Number.isNaN(from) || Number.isNaN(to) || to <= from) return '';
  const last = to - 1;
  const years = format('en', period.timeZone, { year: 'numeric' });
  const withYear = years.format(from) !== years.format(last);
  const days = format(locale, period.timeZone, {
    day: 'numeric',
    month: 'short',
    ...(withYear ? { year: 'numeric' } : {}),
  });
  const start = days.format(from);
  const end = days.format(last);
  return start === end ? start : `${start} to ${end}`;
}

/** True for a key that still opens the API. */
export function isActiveKey(k: Pick<ApiKey, 'revokedAt' | 'expiresAt'>, now: number): boolean {
  return k.revokedAt === null && Date.parse(k.expiresAt) > now;
}

export type StepState = 'done' | 'next' | 'todo';

export interface FirstSteps {
  readonly mandate: StepState;
  readonly fund: StepState;
  /** Null when the member's role cannot see keys, so the step is not theirs to take. */
  readonly key: StepState | null;
  /** The mandate the fund step opens: the newest one that holds nothing. */
  readonly fundTarget: string | null;
  readonly allDone: boolean;
}

function holds(m: OverviewMandate): boolean {
  return m.state !== null && (m.state.balance.amount > 0n || m.state.committed.amount > 0n);
}

/**
 * Where a project stands on its first three steps: a mandate, money in it,
 * and an API key for the agent. Each is done only once the server shows it:
 * money is in once a mandate holds some or a payout has been made.
 */
export function firstSteps(o: Overview, hasKey: boolean | null): FirstSteps {
  const mandates = o.mandates;
  const made = mandates.length > 0 || o.moreMandates;
  const funded = mandates.some(holds) || payoutCount(o.byStatus) > 0 || o.approvalsWaiting > 0;
  // Only a mandate the chain answered for is known to hold nothing.
  const target = mandates.find((m) => m.state !== null && !holds(m)) ?? mandates[0];
  const done = [made, funded, hasKey ?? true];
  const next = done.indexOf(false);
  const state = (i: number): StepState =>
    done[i] === true ? 'done' : i === next ? 'next' : 'todo';
  return {
    mandate: state(0),
    fund: state(1),
    key: hasKey === null ? null : state(2),
    fundTarget: target?.id ?? null,
    allDone: next === -1,
  };
}
