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
  already_paused: 'The mandate is already paused.',
  not_paused: 'The mandate is not paused, so there is nothing to resume.',
  already_revoked: 'The mandate is already revoked.',
};

// Sentences for the console API's error codes. Where the server's own
// message says more (it names the field or the amount), that one is kept.
const API_ERRORS: Record<string, string> = {
  invalid_request: 'The request was not valid. Check the values and try again.',
  invalid_json: 'The request could not be read. Reload the page and try again.',
  body_too_large: 'That request is too large to send.',
  rate_limited: 'Too many tries in a short time. Wait a minute and try again.',
  account_not_found: 'This wallet does not exist on testnet yet. Get test XLM first.',
  trustline_missing: 'This wallet cannot hold USDC yet. Add the USDC trustline first.',
  faucet_used: 'This wallet already received its test USDC. Each wallet gets it once.',
  faucet_busy: 'Test USDC for this wallet is already on its way. Wait a few seconds.',
  faucet_empty:
    'The test USDC faucet is empty right now. Try https://faucet.circle.com (Stellar testnet).',
  faucet_disabled:
    'The test USDC faucet is offline on this server. Get test USDC at https://faucet.circle.com (Stellar testnet).',
  tx_not_allowed: 'The server only sends UJIRA and USDC transactions, and this was neither.',
  invalid_xdr: 'The wallet returned a transaction we could not read. Try signing again.',
  unsigned: 'The transaction came back without a signature. Sign it in your wallet.',
  tx_rejected: 'Stellar refused the transaction. Nothing moved. Try again in a moment.',
  submission_unknown:
    'Stellar has not confirmed the transaction yet. Wait a minute and refresh before trying again.',
  simulation_failed: 'The transaction would fail on chain, so it was not sent. Nothing moved.',
  not_owner: 'Only the wallet that owns this mandate can do that.',
  already_allowed: 'Every one of these recipients is already allowed. Nothing to sign.',
  too_many_recipients: 'Too many recipients for one transaction. Add fewer at a time.',
  duplicate_recipient: 'Each recipient and each name may appear only once.',
  mandate_not_found: 'This server does not know that mandate. Check the link or create a new one.',
  timeout:
    'This took longer than the page can wait. The payout carries on: press Pay now again and it resumes without paying twice.',
  rpc_timeout: 'The Stellar network took too long to answer. Try again in a moment.',
  rpc_unavailable: 'The Stellar network is not answering right now. Try again in a moment.',
  task_conflict: 'This task ID was already used for a different payout. Use a new task ID.',
  internal_error: 'Something went wrong on the server. Try again in a moment.',
};

/** A sentence for an API error code, falling back to the server's message. */
export function apiErrorText(code: string, serverMessage: string): string {
  const own = API_ERRORS[code] ?? REASONS[code];
  if (own !== undefined) return own;
  const m = serverMessage.trim();
  if (m === '') return 'Something went wrong. Try again.';
  return /[.!?]$/.test(m) ? m : `${m}.`;
}

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
