// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// What the approvals screen works out from /v1: the queue in the order it
// arrived, whether the person signed in may sign for a mandate and why not,
// the rule that held the payout, the keyboard moves, and the open payout in
// the URL. Amounts stay bigint minor units throughout.

import { mandateName, meterOf, statusOf } from './mandateV1';
import { formatToken } from './money';
import { shortAddress } from './strkey';
import type { PayoutDetail, TokenAmount, V1Mandate } from './v1Schemas';

export type Decision = 'approve' | 'reject';

/** The queue, oldest first, so the payout that has waited longest is on top. */
export function oldestFirst(items: readonly PayoutDetail[]): PayoutDetail[] {
  return [...items].sort((a, b) =>
    a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1,
  );
}

export type SignRight =
  | { readonly ok: true }
  | {
      readonly ok: false;
      /** A few words for the row. */
      readonly short: string;
      /** The whole reason, for the tip and the screen reader. */
      readonly reason: string;
    };

/**
 * Whether the signed in wallet can approve or reject on this mandate. The
 * approvers are the ones the chain names; the server builds the request for
 * the signed in wallet and the contract refuses anyone else.
 */
export function signRight(m: V1Mandate | undefined, member: string | null): SignRight {
  if (m === undefined) {
    return {
      ok: false,
      short: 'Mandate not read',
      reason: 'This mandate could not be read yet, so there is nothing to sign against.',
    };
  }
  const status = statusOf(m);
  if (status === 'revoked' || status === 'expired') {
    return {
      ok: false,
      short: status === 'revoked' ? 'Mandate revoked' : 'Mandate ended',
      reason: `${mandateName(m)} can no longer pay, so this payout cannot be approved.`,
    };
  }
  if (member === null || !m.config.approvers.includes(member)) {
    const who = member === null ? '' : ` You are signed in as ${shortAddress(member)}.`;
    return {
      ok: false,
      short: 'Not an approver',
      reason: `Only an approver on ${mandateName(m)} can sign this.${who}`,
    };
  }
  return { ok: true };
}

/** The rule that sent the payout here, in a few words. */
export function ruleText(m: V1Mandate): string {
  return `Approval from ${formatToken(m.config.limits.approvalThreshold)}`;
}

/** What the mandate's budget still allows, with this payout already set aside. */
export function budgetLeft(m: V1Mandate): TokenAmount {
  return meterOf(m).remaining;
}

/** The id next to `current` in the queue; the first or last when nothing is chosen yet. */
export function stepId(
  ids: readonly string[],
  current: string | null,
  delta: 1 | -1,
): string | null {
  if (ids.length === 0) return null;
  const at = current === null ? -1 : ids.indexOf(current);
  if (at === -1) return delta === 1 ? (ids[0] ?? null) : (ids[ids.length - 1] ?? null);
  const next = Math.min(Math.max(at + delta, 0), ids.length - 1);
  return ids[next] ?? null;
}

export type Shortcut = 'next' | 'previous' | 'approve' | 'reject';

const KEYS: Readonly<Record<string, Shortcut>> = {
  j: 'next',
  k: 'previous',
  a: 'approve',
  r: 'reject',
};

interface KeyLike {
  readonly key: string;
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly defaultPrevented: boolean;
  readonly target: EventTarget | null;
}

function typing(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target.closest('input, textarea, select, [contenteditable="true"]') !== null) return true;
  return target instanceof HTMLElement && target.isContentEditable;
}

/** The queue move a key press asks for, or null when it is not one or the person is typing. */
export function shortcutOf(e: KeyLike): Shortcut | null {
  if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return null;
  if (typing(e.target)) return null;
  return KEYS[e.key.toLowerCase()] ?? null;
}

// The URL is input anyone can type or send, so only a UUID is kept.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The payout open in the sheet, from the query string. */
export function openOf(search: string): string | null {
  const id = new URLSearchParams(search).get('payout');
  return id !== null && UUID.test(id) ? id : null;
}

/** The query string with `id` open in the sheet, keeping the params of others (mock mode). */
export function withOpen(search: string, id: string | null): string {
  const p = new URLSearchParams(search);
  p.delete('payout');
  if (id !== null && UUID.test(id)) p.set('payout', id);
  const qs = p.toString();
  return qs === '' ? '' : `?${qs}`;
}
