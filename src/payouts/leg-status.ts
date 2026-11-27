// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

import { z } from 'zod';

import { InvalidTransitionError } from './errors.js';

/** Every leg status on the wire. */
export const LEG_STATUSES = Object.freeze([
  'planned',
  'submitted',
  'settled',
  'failed',
  'cancelled',
] as const);

export type LegStatus = (typeof LEG_STATUSES)[number];

export const legStatus = z.enum(LEG_STATUSES);

const none: readonly LegStatus[] = Object.freeze([]);
const exits = (...statuses: LegStatus[]): readonly LegStatus[] => Object.freeze(statuses);

/**
 * The allowed moves of one leg. A send the chain refused goes back to planned
 * to be sent again, and reconcile may find a transfer that landed without the
 * send being recorded, so planned may move straight to settled. The database
 * keeps the same table; keep the two in step.
 */
export const LEG_TRANSITIONS: Readonly<Record<LegStatus, readonly LegStatus[]>> = Object.freeze({
  planned: exits('submitted', 'settled', 'failed', 'cancelled'),
  submitted: exits('settled', 'planned', 'failed'),
  settled: none,
  failed: none,
  cancelled: none,
});

// A Set and a Map, as in status.ts, so no prototype key can resolve.
const STATUSES: ReadonlySet<unknown> = new Set<unknown>(LEG_STATUSES);
const EXITS: ReadonlyMap<unknown, ReadonlySet<unknown>> = new Map(
  LEG_STATUSES.map((status) => [status, new Set<unknown>(LEG_TRANSITIONS[status])]),
);

export function isLegStatus(value: unknown): value is LegStatus {
  return STATUSES.has(value);
}

export function canLegTransition(from: LegStatus, to: LegStatus): boolean {
  return EXITS.get(from)?.has(to) ?? false;
}

/** Throws InvalidTransitionError unless a leg in `from` may move to `to`. */
export function assertLegTransition(from: LegStatus, to: LegStatus): void {
  if (canLegTransition(from, to)) return;
  if (isLegStatus(from) && isLegStatus(to)) {
    throw new InvalidTransitionError(`payout leg cannot move from ${from} to ${to}`);
  }
  throw new InvalidTransitionError('unknown payout leg status');
}
