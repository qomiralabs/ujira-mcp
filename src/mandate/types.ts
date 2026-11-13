// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The mandate's values as TypeScript sees them. Amounts are bigint minor
// units; 32 byte values are lowercase hex.

import type { Hex32 } from '../ids.js';

export interface Limits {
  readonly totalBudget: bigint;
  readonly perPaymentCap: bigint;
  readonly perRecipientDailyCap: bigint;
  readonly approvalThreshold: bigint;
  readonly payoutTtlSeconds: bigint;
  readonly expiresAt: bigint;
}

export interface MandateConfigView {
  readonly principal: string;
  readonly asset: string;
  readonly recipientMode: number;
  readonly agents: readonly string[];
  readonly approvers: readonly string[];
  readonly approvalsRequired: number;
  readonly executors: readonly string[];
  readonly limits: Limits;
  readonly maxFeeBps: number;
  readonly feeAddress: string;
}

export interface MandateStateView {
  readonly spent: bigint;
  readonly pending: bigint;
  readonly committed: bigint;
  readonly balance: bigint;
  readonly free: bigint;
  readonly paused: boolean;
  readonly revoked: boolean;
  readonly expired: boolean;
}

/** Recipient modes, as the contract numbers them. */
export const RECIPIENT_MODE = { allowlist: 1, attested: 2, both: 3 } as const;

export const PAYOUT_STATUS = {
  pending: 1,
  approved: 2,
  executed: 3,
  rejected: 4,
  cancelled: 5,
} as const;

export type PayoutStatusName = keyof typeof PAYOUT_STATUS;

export function statusName(status: number): PayoutStatusName | 'unknown' {
  for (const [name, value] of Object.entries(PAYOUT_STATUS)) {
    if (value === status) return name as PayoutStatusName;
  }
  return 'unknown';
}

export interface Leg {
  readonly destination: string;
  readonly amount: bigint;
}

export interface PayoutRequest {
  readonly payoutId: Hex32;
  readonly recipientRef: Hex32;
  readonly total: bigint;
  readonly fee: bigint;
  readonly legs: readonly Leg[];
  /** Unix seconds after which the mandate refuses the request. */
  readonly deadline: bigint;
  readonly taskRef: Hex32;
}

/** The record while a payout is open, its tombstone once it is terminal. */
export type PayoutEntry =
  | {
      readonly kind: 'record';
      readonly payoutId: Hex32;
      readonly agent: string;
      readonly recipientRef: Hex32;
      readonly total: bigint;
      readonly fee: bigint;
      readonly legs: readonly Leg[];
      readonly status: number;
      readonly createdAt: bigint;
      readonly expiresAt: bigint;
      readonly approvals: readonly string[];
    }
  | { readonly kind: 'tombstone'; readonly payoutId: Hex32; readonly status: number };
