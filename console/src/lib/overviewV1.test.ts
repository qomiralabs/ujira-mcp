// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

import { describe, expect, it } from 'vitest';

import { RECORDED } from '../test/v1Recorded';
import {
  emptyHolding,
  firstSteps,
  holdings,
  isActiveKey,
  payoutCount,
  periodText,
  ruleRows,
  statusRows,
  unreadCount,
} from './overviewV1';
import { overviewSchema, type Overview, type OverviewMandate, type TokenAmount } from './v1Schemas';

const usdc = (amount: bigint): TokenAmount => ({
  amount,
  asset: 'USDC',
  network: 'stellar:testnet',
  scale: 7,
});

const RECORDED_OVERVIEW = overviewSchema.parse(RECORDED['GET /v1/stats/overview']);

function held(
  id: string,
  money: { balance: bigint; free?: bigint; committed?: bigint } | null,
): OverviewMandate {
  return {
    id,
    contractId: `C${id}`,
    name: id,
    state:
      money === null
        ? null
        : {
            balance: usdc(money.balance),
            free: usdc(money.free ?? money.balance),
            committed: usdc(money.committed ?? 0n),
          },
  };
}

function overview(mandates: OverviewMandate[], more: Partial<Overview> = {}): Overview {
  return {
    ...RECORDED_OVERVIEW,
    byStatus: {},
    approvalsWaiting: 0,
    mandates,
    moreMandates: false,
    ...more,
  };
}

describe('holdings', () => {
  it('adds up every mandate per token, past what a number holds', () => {
    const huge = 10n ** 30n + 1n;
    const eurc: OverviewMandate = {
      ...held('c', null),
      state: { balance: { ...usdc(5n), asset: 'EURC' }, free: usdc(5n), committed: usdc(0n) },
    };
    const h = holdings([
      held('a', { balance: huge, free: huge - 3n, committed: 3n }),
      eurc,
      held('b', { balance: 2n }),
    ]);
    expect(h).toHaveLength(2);
    expect(h[0]?.balance.amount).toBe(huge + 2n);
    expect(h[0]?.free.amount).toBe(huge - 1n);
    expect(h[0]?.committed.amount).toBe(3n);
    expect(h[1]?.balance.asset).toBe('EURC');
  });

  it('leaves out a mandate the chain did not answer for, and counts it', () => {
    const list = [held('a', { balance: 7n }), held('b', null)];
    expect(holdings(list)[0]?.balance.amount).toBe(7n);
    expect(unreadCount(list)).toBe(1);
    expect(holdings([held('b', null)])).toEqual([]);
  });

  it('reads the recorded answer', () => {
    expect(holdings(RECORDED_OVERVIEW.mandates)[0]?.balance.amount).toBe(20_000_000_000n);
  });

  it('is empty with no mandates, and a zero holding stands in', () => {
    expect(holdings([])).toEqual([]);
    const zero = emptyHolding({ asset: 'USDC', network: 'stellar:testnet', scale: 7 });
    expect(zero.balance).toEqual(usdc(0n));
  });
});

describe('status and rule rows', () => {
  it('reads statuses in the order of a payout, unknown codes last, zeros left out', () => {
    expect(
      statusRows({ blocked: 2, later_status: 1, paid: 12, queued: 0, pending_approval: 1 }),
    ).toEqual([
      { code: 'paid', count: 12 },
      { code: 'pending_approval', count: 1 },
      { code: 'blocked', count: 2 },
      { code: 'later_status', count: 1 },
    ]);
  });

  it('puts the rule that blocked most first', () => {
    expect(ruleRows({ BUDGET_EXCEEDED: 1, PAYMENT_CAP_EXCEEDED: 3, MANDATE_PAUSED: 1 })).toEqual([
      { code: 'PAYMENT_CAP_EXCEEDED', count: 3 },
      { code: 'BUDGET_EXCEEDED', count: 1 },
      { code: 'MANDATE_PAUSED', count: 1 },
    ]);
  });

  it('counts every payout of the period', () => {
    expect(payoutCount({ paid: 12, pending_approval: 1, blocked: 2 })).toBe(15);
    expect(payoutCount({})).toBe(0);
  });
});

describe('periodText', () => {
  it('counts days in the zone the server names and shows the day before the exclusive end', () => {
    // Midnight in Lagos is 23:00 the day before in UTC.
    expect(periodText(RECORDED_OVERVIEW.period, 'en-GB')).toBe('20 Nov to 26 Nov');
  });

  it('names the years when the period crosses one, and one day once', () => {
    expect(
      periodText(
        { from: '2026-12-29T00:00:00.000Z', to: '2027-01-02T00:00:00.000Z', timeZone: 'UTC' },
        'en-GB',
      ),
    ).toBe('29 Dec 2026 to 1 Jan 2027');
    expect(
      periodText(
        { from: '2026-11-27T00:00:00.000Z', to: '2026-11-28T00:00:00.000Z', timeZone: 'UTC' },
        'en-GB',
      ),
    ).toBe('27 Nov');
  });

  it('says nothing for a period it cannot read, and survives an unknown zone', () => {
    expect(periodText({ from: 'soon', to: '2026-11-28T00:00:00.000Z', timeZone: 'UTC' })).toBe('');
    expect(
      periodText(
        { from: '2026-11-27T00:00:00.000Z', to: '2026-11-28T00:00:00.000Z', timeZone: 'Mars/Base' },
        'en-GB',
      ),
    ).not.toBe('');
  });
});

describe('firstSteps', () => {
  const NOW = Date.parse('2026-11-28T00:00:00.000Z');

  it('starts with a mandate to create', () => {
    expect(firstSteps(overview([]), false)).toEqual({
      mandate: 'next',
      fund: 'todo',
      key: 'todo',
      fundTarget: null,
      allDone: false,
    });
  });

  it('opens the newest mandate known to hold nothing for the fund step', () => {
    const s = firstSteps(
      overview([held('unread', null), held('new', { balance: 0n }), held('old', { balance: 0n })]),
      false,
    );
    expect(s).toMatchObject({ mandate: 'done', fund: 'next', key: 'todo', fundTarget: 'new' });
  });

  it('counts money in once a mandate holds some or a payout was made', () => {
    expect(firstSteps(overview([held('a', { balance: 5n })]), false)).toMatchObject({
      fund: 'done',
      key: 'next',
    });
    expect(
      firstSteps(overview([held('a', { balance: 0n })], { byStatus: { paid: 1 } }), false).fund,
    ).toBe('done');
    // A chain that did not answer proves nothing either way.
    expect(firstSteps(overview([held('a', null)]), false).fund).toBe('next');
  });

  it('is done once a key exists, and leaves the key out for a role that cannot see keys', () => {
    const funded = overview([held('a', { balance: 5n })]);
    expect(firstSteps(funded, true).allDone).toBe(true);
    expect(firstSteps(funded, null)).toMatchObject({ key: null, allDone: true });
    expect(firstSteps(overview([]), null)).toMatchObject({
      mandate: 'next',
      key: null,
      allDone: false,
    });
  });

  it('only counts a key that is neither revoked nor expired', () => {
    expect(isActiveKey({ revokedAt: null, expiresAt: '2027-01-01T00:00:00.000Z' }, NOW)).toBe(true);
    expect(
      isActiveKey(
        { revokedAt: '2026-11-01T00:00:00.000Z', expiresAt: '2027-01-01T00:00:00.000Z' },
        NOW,
      ),
    ).toBe(false);
    expect(isActiveKey({ revokedAt: null, expiresAt: '2026-11-27T00:00:00.000Z' }, NOW)).toBe(
      false,
    );
  });
});
