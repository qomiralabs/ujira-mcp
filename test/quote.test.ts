// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

import { describe, expect, it } from 'vitest';

import { feeCap, quote, type QuoteFacts } from '../src/engine/quote.js';
import { UNIT, agent, feeAddress, principal, stranger } from './fake-rpc.js';
import { alice } from './helpers.js';

function facts(
  over: Partial<QuoteFacts> = {},
  state: Partial<QuoteFacts['state']> = {},
): QuoteFacts {
  return {
    config: {
      principal: principal.publicKey,
      asset: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
      recipientMode: 1,
      agents: [agent.publicKey],
      approvers: [],
      approvalsRequired: 1,
      executors: [],
      maxFeeBps: 100,
      feeAddress,
      limits: {
        totalBudget: 500n * UNIT,
        perPaymentCap: 50n * UNIT,
        perRecipientDailyCap: 100n * UNIT,
        approvalThreshold: 20n * UNIT,
        payoutTtlSeconds: 86_400n,
        expiresAt: 2_000n,
      },
    },
    state: {
      spent: 0n,
      pending: 0n,
      committed: 0n,
      balance: 500n * UNIT,
      free: 500n * UNIT,
      paused: false,
      revoked: false,
      expired: false,
      ...state,
    },
    agent: agent.publicKey,
    destination: alice,
    amount: 5n * UNIT,
    fee: 0n,
    dailyUsed: 0n,
    allowed: true,
    now: 1_000n,
    ...over,
  };
}

describe('quote', () => {
  it('allows a payment under the threshold', () => {
    expect(quote(facts()).decision).toBe('allowed');
  });

  it('needs approval at the threshold and above', () => {
    expect(quote(facts({ amount: 20n * UNIT })).decision).toBe('approval_required');
    expect(quote(facts({ amount: 20n * UNIT - 1n })).decision).toBe('allowed');
  });

  it.each([
    ['unauthorized', facts({ agent: stranger.publicKey })],
    ['mandate_revoked', facts({}, { revoked: true })],
    ['mandate_expired', facts({ now: 2_000n })],
    ['mandate_expired', facts({}, { expired: true })],
    ['mandate_paused', facts({}, { paused: true })],
    ['amount_invalid', facts({ amount: 0n })],
    ['legs_invalid', facts({ destination: feeAddress })],
    ['recipient_not_allowed', facts({ allowed: false })],
    ['fee_exceeds_cap', facts({ fee: 1n * UNIT })],
    ['payment_cap_exceeded', facts({ amount: 50n * UNIT + 1n })],
    ['budget_exceeded', facts({}, { spent: 496n * UNIT })],
    ['daily_cap_exceeded', facts({ dailyUsed: 96n * UNIT })],
    ['insufficient_funds', facts({}, { free: 4n * UNIT })],
  ])('blocks with %s', (reason, f) => {
    expect(quote(f)).toMatchObject({ decision: 'blocked', reason });
  });

  it('reports the first failing check in the contract order', () => {
    // Over the cap and not allowed: the allowlist comes first.
    expect(quote(facts({ allowed: false, amount: 60n * UNIT })).reason).toBe(
      'recipient_not_allowed',
    );
    // Over the cap and over the daily limit: the cap comes first.
    expect(quote(facts({ amount: 60n * UNIT, dailyUsed: 99n * UNIT })).reason).toBe(
      'payment_cap_exceeded',
    );
  });

  it('blocks every attested mode, since this package has no attester', () => {
    const f = facts();
    expect(quote({ ...f, config: { ...f.config, recipientMode: 2 } }).reason).toBe(
      'attestation_invalid',
    );
  });

  it('reports headroom, never below zero', () => {
    const q = quote(facts({ dailyUsed: 150n * UNIT }, { spent: 600n * UNIT }));
    expect(q.headroom.dailyLeft).toBe(0n);
    expect(q.headroom.budgetLeft).toBe(0n);
  });

  it('rounds the fee cap down like the contract', () => {
    expect(feeCap(199n, 100)).toBe(1n);
    expect(feeCap(99n, 100)).toBe(0n);
  });
});
