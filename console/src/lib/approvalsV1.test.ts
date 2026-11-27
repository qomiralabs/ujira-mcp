// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

import { describe, expect, it } from 'vitest';

import { mandate as recordedMandate, pendingPayout } from '../test/v1Recorded';
import {
  budgetLeft,
  oldestFirst,
  openOf,
  ruleText,
  shortcutOf,
  signRight,
  stepId,
  withOpen,
} from './approvalsV1';
import { formatToken } from './money';
import { mandateSchema, payoutSchema, type PayoutDetail } from './v1Schemas';

const OWNER = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
const STRANGER = 'GBT7ITQKEX3Z2YWIYLPRQ5W3JLA2TJ3JTABB765ZYNG7VLX5YYUPI3DT';
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';

const m = mandateSchema.parse(recordedMandate);

function payout(id: string, createdAt: string): PayoutDetail {
  return payoutSchema.parse({ ...pendingPayout, id, createdAt });
}

function key(k: string, extra: Partial<Parameters<typeof shortcutOf>[0]> = {}) {
  return {
    key: k,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    defaultPrevented: false,
    target: document.body,
    ...extra,
  };
}

describe('the approvals queue helpers', () => {
  it('puts the payout that waited longest first, with the id breaking ties', () => {
    const rows = oldestFirst([
      payout(C, '2026-11-26T10:00:00.000Z'),
      payout(B, '2026-11-25T10:00:00.000Z'),
      payout(A, '2026-11-26T10:00:00.000Z'),
    ]);
    expect(rows.map((p) => p.id)).toEqual([B, A, C]);
  });

  it('lets an approver the chain names sign, and nobody else', () => {
    expect(m.config.approvers).toEqual([OWNER]);
    expect(signRight(m, OWNER)).toEqual({ ok: true });
    const no = signRight(m, STRANGER);
    expect(no).toMatchObject({ ok: false, short: 'Not an approver' });
    expect(no.ok ? '' : no.reason).toBe(
      'Only an approver on Mandate D4V7 can sign this. You are signed in as GBT7...I3DT.',
    );
    expect(signRight(m, null)).toMatchObject({ ok: false, short: 'Not an approver' });
  });

  it('says why a closed or unread mandate cannot be signed', () => {
    expect(signRight(undefined, OWNER)).toMatchObject({ ok: false, short: 'Mandate not read' });
    const revoked = { ...m, state: { ...m.state, revoked: true } };
    expect(signRight(revoked, OWNER)).toMatchObject({ ok: false, short: 'Mandate revoked' });
    const ended = { ...m, state: { ...m.state, expired: true } };
    expect(signRight(ended, OWNER)).toMatchObject({ ok: false, short: 'Mandate ended' });
    // A pause blocks paying, not deciding.
    const paused = { ...m, state: { ...m.state, paused: true } };
    expect(signRight(paused, OWNER)).toEqual({ ok: true });
  });

  it('names the rule and what the budget still allows, from minor units', () => {
    expect(ruleText(m)).toBe('Approval from 250.00 USDC');
    const left = budgetLeft(m);
    const l = m.config.limits.totalBudget.amount;
    expect(left.amount).toBe(l - m.state.spent.amount - m.state.committed.amount);
    expect(typeof left.amount).toBe('bigint');
    expect(formatToken(left)).toMatch(/ USDC$/);
  });

  it('moves through the queue and stops at either end', () => {
    const ids = [A, B, C];
    expect(stepId(ids, null, 1)).toBe(A);
    expect(stepId(ids, null, -1)).toBe(C);
    expect(stepId(ids, A, 1)).toBe(B);
    expect(stepId(ids, C, 1)).toBe(C);
    expect(stepId(ids, A, -1)).toBe(A);
    expect(stepId(ids, 'gone', 1)).toBe(A);
    expect(stepId([], null, 1)).toBeNull();
  });

  it('reads J, K, A and R, and ignores them while typing or with a modifier', () => {
    expect(shortcutOf(key('j'))).toBe('next');
    expect(shortcutOf(key('K'))).toBe('previous');
    expect(shortcutOf(key('a'))).toBe('approve');
    expect(shortcutOf(key('r'))).toBe('reject');
    expect(shortcutOf(key('x'))).toBeNull();
    expect(shortcutOf(key('r', { ctrlKey: true }))).toBeNull();
    expect(shortcutOf(key('a', { metaKey: true }))).toBeNull();
    expect(shortcutOf(key('j', { defaultPrevented: true }))).toBeNull();
    const input = document.createElement('input');
    expect(shortcutOf(key('a', { target: input }))).toBeNull();
    const select = document.createElement('select');
    expect(shortcutOf(key('j', { target: select }))).toBeNull();
  });

  it('keeps only a UUID as the open payout, and the params of others', () => {
    expect(openOf(`?payout=${A}`)).toBe(A);
    expect(openOf('?payout=<script>')).toBeNull();
    expect(withOpen('?mock=1&v1=approvals', A)).toBe(`?mock=1&v1=approvals&payout=${A}`);
    expect(withOpen(`?mock=1&payout=${A}`, null)).toBe('?mock=1');
    expect(withOpen('', 'not-a-uuid')).toBe('');
  });
});
