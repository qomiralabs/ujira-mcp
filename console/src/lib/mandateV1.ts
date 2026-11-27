// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// What the mandate screens work out from a /v1 mandate: its name, where its
// budget has gone, and whether a signed action shows on chain yet. All of it
// is bigint minor units; percentages are only ever bar widths.

import type { RulesPlan } from './mandateForm';
import { percentOf } from './money';
import type { MandateActionInput, PrepareMandateInput } from './v1';
import type { TokenAmount, V1Mandate } from './v1Schemas';
import { mandateStatus, type MandateStatus } from './words';

export const NAME_MAX = 60;

/** What is wrong with a mandate name, or null. */
export function nameProblem(raw: string): string | null {
  const name = raw.trim();
  if (name === '') return 'Give the mandate a name.';
  if (name.length > NAME_MAX) return `Keep the name to ${NAME_MAX} characters or fewer.`;
  return null;
}

/** The name a person sees and types back; older mandates without one get a short handle. */
export function mandateName(m: Pick<V1Mandate, 'name' | 'contractId'>): string {
  const own = m.name?.trim() ?? '';
  return own === '' ? `Mandate ${m.contractId.slice(-4)}` : own;
}

/** True when what was typed is the mandate's name, ignoring outer spaces. */
export function nameMatches(typed: string, name: string): boolean {
  return typed.trim() !== '' && typed.trim() === name.trim();
}

export function statusOf(m: V1Mandate): MandateStatus {
  return mandateStatus(m.state);
}

export interface Meter {
  readonly budget: TokenAmount;
  /** Paid out for good. */
  readonly used: TokenAmount;
  /** Set aside for payouts that wait for approval. */
  readonly committed: TokenAmount;
  /** What the budget still allows. */
  readonly remaining: TokenAmount;
  readonly usedPercent: number;
  readonly committedPercent: number;
}

function like(base: TokenAmount, amount: bigint): TokenAmount {
  return { ...base, amount };
}

/** Where the total budget has gone. The two bar widths never add up past 100. */
export function meterOf(m: V1Mandate): Meter {
  const budget = m.config.limits.totalBudget;
  const used = m.state.spent;
  const committed = m.state.committed;
  const left = budget.amount - used.amount - committed.amount;
  const usedPercent = percentOf(used.amount.toString(), budget.amount.toString());
  const committedPercent = Math.min(
    100 - usedPercent,
    percentOf(committed.amount.toString(), budget.amount.toString()),
  );
  return {
    budget,
    used,
    committed,
    remaining: like(budget, left > 0n ? left : 0n),
    usedPercent,
    committedPercent,
  };
}

/**
 * Whether a mandate read back from the server shows the action. The server
 * answers a submit once Stellar has the transaction; the flags it reads from
 * the contract can trail by a ledger, so the screen waits for them.
 */
export function showsAction(kind: MandateActionInput['kind'], m: V1Mandate): boolean {
  switch (kind) {
    case 'pause':
      return m.state.paused;
    case 'resume':
      return !m.state.paused;
    case 'revoke':
      return m.state.revoked;
    default:
      return true;
  }
}

/** The /v1 network name for the console's network: "testnet" is "stellar:testnet". */
export function v1Network(network: string): string {
  return network.includes(':') ? network : `stellar:${network}`;
}

export interface AssetUnit {
  readonly asset: string;
  readonly network: string;
  readonly scale: number;
}

export function tokenOf(minor: string | bigint, unit: AssetUnit): TokenAmount {
  return { amount: BigInt(minor), asset: unit.asset, network: unit.network, scale: unit.scale };
}

/** The request body for a new mandate. The server adds the agent key and the executor. */
export function prepareInput(
  name: string,
  rules: RulesPlan,
  recipientIds: readonly string[],
  unit: AssetUnit,
  payoutTtlSeconds = 86_400,
): PrepareMandateInput {
  return {
    name: name.trim(),
    // The owner's own wallet approves; approving as a team comes later.
    approvers: [],
    approvalsRequired: 1,
    limits: {
      totalBudget: tokenOf(rules.budget, unit),
      perPaymentCap: tokenOf(rules.perPaymentCap, unit),
      perRecipientDailyCap: tokenOf(rules.dailyCap, unit),
      approvalThreshold: tokenOf(rules.approvalThreshold, unit),
      payoutTtlSeconds,
      expiresAt: new Date(rules.expiresAt * 1000).toISOString(),
    },
    recipients: [...new Set(recipientIds)],
  };
}
