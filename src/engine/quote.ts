// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// Predicts what the mandate will do with a request, from its config and
// state, without spending anything. The checks run in the contract's own
// order, so the first one that fails is the reason the contract would give.
// It is a prediction: the contract stays the authority, and the engine still
// asks it before anything moves.

import type { MandateConfigView, MandateStateView } from '../mandate/types.js';
import { RECIPIENT_MODE } from '../mandate/types.js';

export type Decision = 'allowed' | 'approval_required' | 'blocked';

export interface QuoteFacts {
  readonly config: MandateConfigView;
  readonly state: MandateStateView;
  /** The agent that would sign the request. */
  readonly agent: string;
  readonly destination: string;
  readonly amount: bigint;
  readonly fee: bigint;
  /** Executed for this recipient today. */
  readonly dailyUsed: bigint;
  readonly allowed: boolean;
  /** Unix seconds. */
  readonly now: bigint;
}

export interface Headroom {
  readonly perPaymentCap: bigint;
  readonly approvalThreshold: bigint;
  readonly budgetLeft: bigint;
  readonly dailyLeft: bigint;
  readonly free: bigint;
}

export interface Quote {
  readonly decision: Decision;
  /** Set when blocked: the contract's error name for the first failing check. */
  readonly reason?: string;
  readonly amount: bigint;
  readonly headroom: Headroom;
}

const max0 = (v: bigint) => (v < 0n ? 0n : v);

export function headroomOf(facts: QuoteFacts): Headroom {
  const { limits } = facts.config;
  const { state } = facts;
  return {
    perPaymentCap: limits.perPaymentCap,
    approvalThreshold: limits.approvalThreshold,
    budgetLeft: max0(limits.totalBudget - (state.spent + state.pending + state.committed)),
    dailyLeft: max0(limits.perRecipientDailyCap - facts.dailyUsed),
    free: state.free,
  };
}

/** The fee cap, as the contract rounds it: floor(total * bps / 10000). */
export function feeCap(total: bigint, bps: number): bigint {
  return (total * BigInt(bps)) / 10_000n;
}

export function quote(facts: QuoteFacts): Quote {
  const headroom = headroomOf(facts);
  const blocked = (reason: string): Quote => ({
    decision: 'blocked',
    reason,
    amount: facts.amount,
    headroom,
  });
  const { config, state, amount, fee } = facts;
  const charge = amount + fee;

  if (!config.agents.includes(facts.agent)) return blocked('unauthorized');
  if (state.revoked) return blocked('mandate_revoked');
  if (state.expired || facts.now >= config.limits.expiresAt) return blocked('mandate_expired');
  if (state.paused) return blocked('mandate_paused');
  if (amount < 1n || fee < 0n) return blocked('amount_invalid');
  // The contract refuses legs that pay the fee address or the asset contract.
  if (facts.destination === config.feeAddress || facts.destination === config.asset) {
    return blocked('legs_invalid');
  }
  const needsAllowlist =
    config.recipientMode === RECIPIENT_MODE.allowlist ||
    config.recipientMode === RECIPIENT_MODE.both;
  if (needsAllowlist && !facts.allowed) return blocked('recipient_not_allowed');
  if (
    config.recipientMode === RECIPIENT_MODE.attested ||
    config.recipientMode === RECIPIENT_MODE.both
  ) {
    // Attestations come from an attester service this package does not run.
    return blocked('attestation_invalid');
  }
  if (fee > feeCap(amount, config.maxFeeBps)) return blocked('fee_exceeds_cap');
  if (charge > config.limits.perPaymentCap) return blocked('payment_cap_exceeded');
  if (charge > headroom.budgetLeft) return blocked('budget_exceeded');
  if (amount > headroom.dailyLeft) return blocked('daily_cap_exceeded');
  if (charge > state.free) return blocked('insufficient_funds');

  return {
    decision: charge >= config.limits.approvalThreshold ? 'approval_required' : 'allowed',
    amount,
    headroom,
  };
}
