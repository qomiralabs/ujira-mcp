// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// Plain words for the codes the contract and the engine use.

const REASONS: Record<string, string> = {
  payment_cap_exceeded: 'Over the max per payment.',
  over_per_payment_cap: 'Over the max per payment.',
  budget_exceeded: 'Over what is left of the total budget.',
  over_budget: 'Over what is left of the total budget.',
  daily_cap_exceeded: "Over today's limit for this recipient.",
  over_daily_cap: "Over today's limit for this recipient.",
  recipient_not_allowed: "This recipient is not on the mandate's list.",
  mandate_paused: 'The mandate is paused. Resume it to pay again.',
  mandate_revoked: 'The mandate was revoked. It can never pay again.',
  mandate_expired: 'The mandate has passed its end date.',
  insufficient_funds: 'The mandate does not hold enough USDC. Fund it first.',
  unauthorized: 'This agent key is not allowed to ask this mandate for payouts.',
  amount_invalid: 'The amount must be more than zero.',
  fee_exceeds_cap: 'The fee is above the cap the mandate allows.',
  legs_invalid: 'That destination cannot be paid by this mandate.',
  attestation_invalid: 'This mandate needs a recipient check this server cannot do.',
  rail_unavailable: 'That payout method is not available on this server.',
  rejected: 'The approver rejected this payout.',
  payout_rejected: 'The approver rejected this payout.',
  payout_expired: 'The request ran out of time before it was approved.',
  input_invalid: 'Something in the request was not valid.',
};

function sentence(code: string): string {
  const words = code.replace(/[_-]+/g, ' ').trim();
  if (words === '') return 'Blocked by the mandate.';
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}.`;
}

export function reasonText(code: string | null | undefined): string {
  if (code === null || code === undefined || code === '') return 'Blocked by the mandate.';
  return REASONS[code] ?? sentence(code);
}

export type Tone = 'paid' | 'waiting' | 'blocked' | 'neutral';

export interface StatusWord {
  readonly label: string;
  readonly tone: Tone;
}

const STATUSES: Record<string, StatusWord> = {
  paid: { label: 'Paid', tone: 'paid' },
  approved_then_paid: { label: 'Approved, paid', tone: 'paid' },
  executed: { label: 'Paid', tone: 'paid' },
  allowed: { label: 'Allowed', tone: 'paid' },
  settling: { label: 'Paying', tone: 'waiting' },
  pending_approval: { label: 'Waiting for approval', tone: 'waiting' },
  approval_required: { label: 'Waiting for approval', tone: 'waiting' },
  pending: { label: 'Waiting for approval', tone: 'waiting' },
  approved: { label: 'Approved, ready to pay', tone: 'waiting' },
  blocked: { label: 'Blocked', tone: 'blocked' },
  rejected: { label: 'Rejected', tone: 'blocked' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
  expired: { label: 'Expired', tone: 'neutral' },
};

export function statusWord(code: string): StatusWord {
  return STATUSES[code] ?? { label: sentence(code).slice(0, -1), tone: 'neutral' };
}

export type MandateStatus = 'active' | 'paused' | 'revoked' | 'expired';

export function mandateStatus(state: {
  paused: boolean;
  revoked: boolean;
  expired: boolean;
}): MandateStatus {
  if (state.revoked) return 'revoked';
  if (state.expired) return 'expired';
  if (state.paused) return 'paused';
  return 'active';
}

export const MANDATE_STATUS: Record<MandateStatus, StatusWord & { help: string }> = {
  active: {
    label: 'Active',
    tone: 'paid',
    help: 'The agent can ask for payouts inside your rules.',
  },
  paused: { label: 'Paused', tone: 'waiting', help: 'Every payout is blocked until you resume.' },
  revoked: {
    label: 'Revoked',
    tone: 'blocked',
    help: 'Closed for good. What was left went back to your wallet.',
  },
  expired: { label: 'Expired', tone: 'neutral', help: 'Past its end date. It can no longer pay.' },
};
