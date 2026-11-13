// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The create mandate form: its defaults, its checks, and the parameters it
// becomes. Each check returns a sentence that says what to change.

import { compareMinor, parseAmount } from './money';
import { accountAddressProblem } from './strkey';

export interface RecipientDraft {
  readonly label: string;
  readonly address: string;
  /** Made by "Add a test recipient", so it already holds a USDC trustline. */
  readonly test?: boolean;
}

export interface MandateDraft {
  readonly budget: string;
  readonly perPaymentCap: string;
  readonly dailyCap: string;
  readonly approvalThreshold: string;
  readonly expiryDays: string;
  readonly fund: string;
  readonly recipients: readonly RecipientDraft[];
}

export const DEFAULT_DRAFT: MandateDraft = {
  budget: '40',
  perPaymentCap: '15',
  dailyCap: '30',
  approvalThreshold: '10',
  expiryDays: '30',
  fund: '40',
  recipients: [],
};

export type DraftField = Exclude<keyof MandateDraft, 'recipients'> | 'recipients';
export type DraftErrors = Partial<Record<DraftField, string>> & {
  readonly recipientRows?: Readonly<Record<number, string>>;
};

export interface MandatePlan {
  readonly budget: string;
  readonly perPaymentCap: string;
  readonly dailyCap: string;
  readonly approvalThreshold: string;
  readonly expiresAt: number;
  readonly fund: string;
  readonly recipients: readonly { label: string; address: string }[];
}

export const MAX_EXPIRY_DAYS = 365;
export const MAX_LABEL = 40;

function positive(input: string, name: string): { minor?: string; error?: string } {
  const parsed = parseAmount(input);
  if (!parsed.ok) return { error: parsed.error };
  if (parsed.minor === '0') return { error: `${name} must be more than zero.` };
  return { minor: parsed.minor };
}

export function validateDraft(
  draft: MandateDraft,
  options: { walletUsdc?: string | null; nowSeconds: number },
): { ok: true; plan: MandatePlan } | { ok: false; errors: DraftErrors } {
  const errors: Partial<Record<DraftField, string>> = {};
  const recipientRows: Record<number, string> = {};

  const budget = positive(draft.budget, 'The budget');
  if (budget.error !== undefined) errors.budget = budget.error;
  const cap = positive(draft.perPaymentCap, 'The max per payment');
  if (cap.error !== undefined) errors.perPaymentCap = cap.error;
  const daily = positive(draft.dailyCap, 'The daily limit');
  if (daily.error !== undefined) errors.dailyCap = daily.error;
  const threshold = positive(draft.approvalThreshold, 'The approval amount');
  if (threshold.error !== undefined) errors.approvalThreshold = threshold.error;
  const fund = positive(draft.fund, 'The amount to fund');
  if (fund.error !== undefined) errors.fund = fund.error;

  if (budget.minor !== undefined && cap.minor !== undefined) {
    if (compareMinor(cap.minor, budget.minor) > 0) {
      errors.perPaymentCap = 'The max per payment cannot be more than the total budget.';
    }
  }
  if (budget.minor !== undefined && daily.minor !== undefined) {
    if (compareMinor(daily.minor, budget.minor) > 0) {
      errors.dailyCap = 'The daily limit cannot be more than the total budget.';
    }
  }
  if (cap.minor !== undefined && threshold.minor !== undefined) {
    if (compareMinor(threshold.minor, cap.minor) > 0) {
      errors.approvalThreshold =
        'Set this at or below the max per payment, otherwise no payment would ever need your approval.';
    }
  }
  if (budget.minor !== undefined && fund.minor !== undefined) {
    if (compareMinor(fund.minor, budget.minor) > 0) {
      errors.fund = 'Fund at most the total budget; the mandate can never spend more than that.';
    }
  }
  const walletUsdc = options.walletUsdc;
  if (fund.minor !== undefined && errors.fund === undefined && walletUsdc !== undefined) {
    if (walletUsdc === null) {
      errors.fund = 'Your wallet cannot hold USDC yet. Finish the setup steps first.';
    } else if (compareMinor(fund.minor, walletUsdc) > 0) {
      errors.fund = 'Your wallet does not hold that much test USDC.';
    }
  }

  const days = draft.expiryDays.trim();
  if (!/^\d+$/.test(days) || Number(days) < 1 || Number(days) > MAX_EXPIRY_DAYS) {
    errors.expiryDays = `Choose a whole number of days from 1 to ${MAX_EXPIRY_DAYS}.`;
  }

  if (draft.recipients.length === 0) {
    errors.recipients = 'Add at least one recipient, or press "Add a test recipient".';
  }
  const seen = new Set<string>();
  const labels = new Set<string>();
  draft.recipients.forEach((r, i) => {
    const address = r.address.trim();
    const label = r.label.trim();
    const problem = accountAddressProblem(address);
    if (problem !== null) recipientRows[i] = problem;
    else if (seen.has(address)) recipientRows[i] = 'This address is already on the list.';
    else if (label === '') recipientRows[i] = 'Give this recipient a short name.';
    else if (label.length > MAX_LABEL)
      recipientRows[i] = `Keep the name under ${MAX_LABEL} characters.`;
    else if (labels.has(label.toLowerCase())) recipientRows[i] = 'Two recipients have this name.';
    seen.add(address);
    labels.add(label.toLowerCase());
  });

  if (Object.keys(errors).length > 0 || Object.keys(recipientRows).length > 0) {
    return {
      ok: false,
      errors: Object.keys(recipientRows).length > 0 ? { ...errors, recipientRows } : errors,
    };
  }
  return {
    ok: true,
    plan: {
      budget: budget.minor ?? '0',
      perPaymentCap: cap.minor ?? '0',
      dailyCap: daily.minor ?? '0',
      approvalThreshold: threshold.minor ?? '0',
      expiresAt: options.nowSeconds + Number(days) * 86_400,
      fund: fund.minor ?? '0',
      recipients: draft.recipients.map((r) => ({
        label: r.label.trim(),
        address: r.address.trim(),
      })),
    },
  };
}

/** A fresh task ID such as "task-20261113-k3f9q2". */
export function newTaskId(now: Date = new Date(), random: () => number = Math.random): string {
  const y = String(now.getUTCFullYear());
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d = String(now.getUTCDate()).padStart(2, '0');
  const alphabet = 'abcdefghijkmnpqrstuvwxyz23456789';
  let tail = '';
  for (let i = 0; i < 6; i++) tail += alphabet[Math.floor(random() * alphabet.length)] ?? 'x';
  return `task-${y}${m}${d}-${tail}`;
}

export const TASK_ID = /^[A-Za-z0-9._:/@#-]{1,128}$/;
