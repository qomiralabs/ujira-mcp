// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

import { z } from 'zod';

import { InvalidTransitionError } from './errors.js';

/**
 * Every payout status on the wire. The names match the earlier backend's, so
 * statuses it had and we do not yet use can arrive later without renaming any.
 */
export const PAYOUT_STATUSES = Object.freeze([
  'queued',
  'submitting',
  'pending_approval',
  'approved',
  'settling',
  'paid',
  'partly_paid',
  'needs_attention',
  'blocked',
  'rejected',
  'cancelled',
  'failed',
] as const);

export type PayoutStatus = (typeof PAYOUT_STATUSES)[number];

/** Validates a status read from the database, a job payload or a request. */
export const payoutStatus = z.enum(PAYOUT_STATUSES);

/** No exits: a payout here is finished and its receipt can be written. */
export const TERMINAL_STATUSES: readonly PayoutStatus[] = Object.freeze([
  'paid',
  'blocked',
  'rejected',
  'cancelled',
  'failed',
]);

/**
 * Named so the wire format is stable, but nothing moves into or out of them
 * yet. partly_paid belongs to split payouts, which come later.
 */
export const RESERVED_STATUSES: readonly PayoutStatus[] = Object.freeze(['partly_paid']);

const none: readonly PayoutStatus[] = Object.freeze([]);
const exits = (...statuses: PayoutStatus[]): readonly PayoutStatus[] => Object.freeze(statuses);

/**
 * The allowed moves. The database keeps the same table and a trigger refuses
 * any other update, so a bug in one layer is still caught by the other; keep
 * the two in step.
 */
export const PAYOUT_TRANSITIONS: Readonly<Record<PayoutStatus, readonly PayoutStatus[]>> =
  Object.freeze({
    queued: exits('submitting', 'blocked', 'failed'),
    submitting: exits('pending_approval', 'approved', 'blocked', 'needs_attention'),
    pending_approval: exits('approved', 'rejected', 'cancelled'),
    approved: exits('settling'),
    settling: exits('paid', 'needs_attention'),
    needs_attention: exits('submitting', 'settling', 'paid', 'failed'),
    paid: none,
    partly_paid: none,
    blocked: none,
    rejected: none,
    cancelled: none,
    failed: none,
  });

// Sets and a Map rather than lookups on the records above, so a value such as
// "__proto__" or "constructor" can never resolve through a prototype.
const STATUSES: ReadonlySet<unknown> = new Set<unknown>(PAYOUT_STATUSES);
const TERMINAL: ReadonlySet<unknown> = new Set<unknown>(TERMINAL_STATUSES);
const EXITS: ReadonlyMap<unknown, ReadonlySet<unknown>> = new Map(
  PAYOUT_STATUSES.map((status) => [status, new Set<unknown>(PAYOUT_TRANSITIONS[status])]),
);

export function isPayoutStatus(value: unknown): value is PayoutStatus {
  return STATUSES.has(value);
}

export function isTerminal(status: PayoutStatus): boolean {
  return TERMINAL.has(status);
}

/** The statuses `from` may move to; empty for terminal, reserved or unknown values. */
export function nextStatuses(from: PayoutStatus): readonly PayoutStatus[] {
  return isPayoutStatus(from) ? PAYOUT_TRANSITIONS[from] : none;
}

export function canTransition(from: PayoutStatus, to: PayoutStatus): boolean {
  return EXITS.get(from)?.has(to) ?? false;
}

/** Throws InvalidTransitionError unless `from` may move to `to`. */
export function assertTransition(from: PayoutStatus, to: PayoutStatus): void {
  if (canTransition(from, to)) return;
  // Only validated names go into the message; anything else may be caller text.
  if (isPayoutStatus(from) && isPayoutStatus(to)) {
    throw new InvalidTransitionError(`payout cannot move from ${from} to ${to}`);
  }
  throw new InvalidTransitionError('unknown payout status');
}
