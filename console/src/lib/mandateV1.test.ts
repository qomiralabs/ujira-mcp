// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

import { describe, expect, it } from 'vitest';

import { mandate as recorded } from '../test/v1Recorded';
import {
  checkNewRecipients,
  mandateName,
  meterOf,
  nameMatches,
  nameProblem,
  prepareInput,
  showsAction,
  v1Network,
} from './mandateV1';
import { formatToken } from './money';
import { mandateSchema, type V1Mandate } from './v1Schemas';

const base: V1Mandate = mandateSchema.parse(recorded);

function withState(patch: Partial<V1Mandate['state']>): V1Mandate {
  return { ...base, state: { ...base.state, ...patch } };
}

const usdc = (amount: bigint) => ({ ...base.state.spent, amount });

describe('the mandate meter', () => {
  it('splits the budget into used, committed and remaining, in minor units', () => {
    const m = withState({ spent: usdc(12_000_000_000n), committed: usdc(3_000_000_000n) });
    const meter = meterOf(m);
    expect(meter.budget.amount).toBe(50_000_000_000n);
    expect(meter.used.amount).toBe(12_000_000_000n);
    expect(meter.committed.amount).toBe(3_000_000_000n);
    expect(meter.remaining.amount).toBe(35_000_000_000n);
    expect(formatToken(meter.remaining)).toBe('3,500.00 USDC');
    expect(meter.usedPercent).toBe(24);
    expect(meter.committedPercent).toBe(6);
  });

  it('keeps a stroop that no float could hold', () => {
    const m = withState({ spent: usdc(1n), committed: usdc(0n) });
    expect(meterOf(m).remaining.amount).toBe(49_999_999_999n);
    expect(formatToken(meterOf(m).remaining)).toBe('4,999.9999999 USDC');
  });

  it('never shows less than nothing left or a bar past full', () => {
    const m = withState({ spent: usdc(40_000_000_000n), committed: usdc(30_000_000_000n) });
    const meter = meterOf(m);
    expect(meter.remaining.amount).toBe(0n);
    expect(meter.usedPercent + meter.committedPercent).toBe(100);
  });

  it('shows an empty bar for a budget of zero', () => {
    const zero = {
      ...base,
      config: {
        ...base.config,
        limits: { ...base.config.limits, totalBudget: usdc(0n) },
      },
    };
    expect(meterOf(zero).usedPercent).toBe(0);
    expect(meterOf(zero).committedPercent).toBe(0);
  });
});

describe('the mandate name', () => {
  it('uses the name the principal gave it', () => {
    expect(mandateName({ name: '  Weekly payouts ', contractId: base.contractId })).toBe(
      'Weekly payouts',
    );
  });

  it('gives an older mandate without a name a short handle to type', () => {
    expect(mandateName({ contractId: base.contractId })).toBe('Mandate D4V7');
    expect(mandateName({ name: null, contractId: base.contractId })).toBe('Mandate D4V7');
  });

  it('matches only the exact name typed back', () => {
    expect(nameMatches('Weekly payouts', 'Weekly payouts')).toBe(true);
    expect(nameMatches(' Weekly payouts ', 'Weekly payouts')).toBe(true);
    expect(nameMatches('weekly payouts', 'Weekly payouts')).toBe(false);
    expect(nameMatches('Weekly', 'Weekly payouts')).toBe(false);
    expect(nameMatches('', '')).toBe(false);
  });

  it('asks for a name of a sensible length', () => {
    expect(nameProblem('  ')).toBe('Give the mandate a name.');
    expect(nameProblem('x'.repeat(61))).toMatch(/60 characters/);
    expect(nameProblem('Grants')).toBeNull();
  });
});

describe('reading an action back', () => {
  it('waits for the flags the contract reports', () => {
    expect(showsAction('pause', withState({ paused: false }))).toBe(false);
    expect(showsAction('pause', withState({ paused: true }))).toBe(true);
    expect(showsAction('resume', withState({ paused: true }))).toBe(false);
    expect(showsAction('resume', withState({ paused: false }))).toBe(true);
    expect(showsAction('revoke', withState({ revoked: false }))).toBe(false);
    expect(showsAction('revoke', withState({ revoked: true }))).toBe(true);
    expect(showsAction('fund', base)).toBe(true);
  });
});

describe('a new mandate request', () => {
  it('sends token amounts in minor units and an ISO end, and no recipients', () => {
    const unit = { asset: 'USDC', network: v1Network('testnet'), scale: 7 };
    const input = prepareInput(
      ' Grants ',
      {
        budget: '400000000',
        perPaymentCap: '150000000',
        dailyCap: '300000000',
        approvalThreshold: '0',
        expiresAt: 1_800_000_000,
        fund: '400000000',
      },
      unit,
    );
    expect(input).toEqual({
      name: 'Grants',
      approvers: [],
      approvalsRequired: 1,
      limits: {
        totalBudget: { amount: 400_000_000n, asset: 'USDC', network: 'stellar:testnet', scale: 7 },
        perPaymentCap: {
          amount: 150_000_000n,
          asset: 'USDC',
          network: 'stellar:testnet',
          scale: 7,
        },
        perRecipientDailyCap: {
          amount: 300_000_000n,
          asset: 'USDC',
          network: 'stellar:testnet',
          scale: 7,
        },
        approvalThreshold: { amount: 0n, asset: 'USDC', network: 'stellar:testnet', scale: 7 },
        payoutTtlSeconds: 86_400,
        expiresAt: '2027-01-15T08:00:00.000Z',
      },
    });
    // The server refuses recipients at prepare; they are added once the mandate exists.
    expect('recipients' in input).toBe(false);
  });

  it('names the network the way /v1 does', () => {
    expect(v1Network('testnet')).toBe('stellar:testnet');
    expect(v1Network('stellar:pubnet')).toBe('stellar:pubnet');
  });
});

describe('the people a new mandate may pay', () => {
  const ADA = 'GBT7ITQKEX3Z2YWIYLPRQ5W3JLA2TJ3JTABB765ZYNG7VLX5YYUPI3DT';
  const KOFI = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';

  it('takes name and wallet pairs, trimmed', () => {
    const checked = checkNewRecipients([
      { label: ' Ada ', address: ` ${ADA} ` },
      { label: 'Kofi', address: KOFI },
    ]);
    expect(checked.rows).toEqual({});
    expect(checked.list).toEqual([
      { label: 'Ada', address: ADA },
      { label: 'Kofi', address: KOFI },
    ]);
    expect(checkNewRecipients([]).list).toEqual([]);
  });

  it('marks each row that needs fixing, and names in any case only once', () => {
    const checked = checkNewRecipients([
      { label: 'Ada', address: ADA },
      { label: 'ada', address: KOFI },
      { label: '', address: ADA },
      { label: 'Musa', address: 'SB' + 'A'.repeat(54) },
    ]);
    expect(checked.list).toBeNull();
    expect(Object.keys(checked.rows)).toEqual(['1', '2', '3']);
    expect(checked.rows[1]).toEqual({ label: 'Two people have this name.' });
    expect(checked.rows[2]).toEqual({
      label: 'Enter a name.',
      address: 'This wallet is already on the list.',
    });
    expect(checked.rows[3]?.label).toBeUndefined();
    expect(checked.rows[3]?.address).toContain('secret key');
  });
});
