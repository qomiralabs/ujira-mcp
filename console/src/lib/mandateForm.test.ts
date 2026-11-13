// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

import { describe, expect, it } from 'vitest';

import { DEFAULT_DRAFT, TASK_ID, newTaskId, validateDraft, type MandateDraft } from './mandateForm';
import { encodeAddress } from './strkey';

const ADA = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
const NOW = 1_794_560_000;

const draft = (patch: Partial<MandateDraft> = {}): MandateDraft => ({
  ...DEFAULT_DRAFT,
  recipients: [{ label: 'Ada', address: ADA }],
  ...patch,
});

describe('validateDraft', () => {
  it('turns the defaults into a plan in minor units', () => {
    const r = validateDraft(draft(), { nowSeconds: NOW, walletUsdc: '500000000' });
    expect(r).toEqual({
      ok: true,
      plan: {
        budget: '400000000',
        perPaymentCap: '150000000',
        dailyCap: '300000000',
        approvalThreshold: '100000000',
        expiresAt: NOW + 30 * 86_400,
        fund: '400000000',
        recipients: [{ label: 'Ada', address: ADA }],
      },
    });
  });

  it('starts from the sprint defaults', () => {
    expect(DEFAULT_DRAFT).toMatchObject({
      budget: '40',
      perPaymentCap: '15',
      dailyCap: '30',
      approvalThreshold: '10',
      expiryDays: '30',
      fund: '40',
    });
  });

  it('names each field that is wrong', () => {
    const r = validateDraft(
      draft({ budget: '0', perPaymentCap: 'ten', dailyCap: '', expiryDays: '0', fund: '-1' }),
      { nowSeconds: NOW },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors).toMatchObject({
      budget: 'The budget must be more than zero.',
      perPaymentCap: 'Use digits and one decimal point, like 12.50.',
      dailyCap: 'Enter an amount.',
      expiryDays: 'Choose a whole number of days from 1 to 365.',
      fund: 'The amount cannot be negative.',
    });
  });

  it('keeps the limits consistent with each other', () => {
    const r = validateDraft(
      draft({
        budget: '20',
        perPaymentCap: '25',
        dailyCap: '21',
        approvalThreshold: '30',
        fund: '25',
      }),
      { nowSeconds: NOW },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.perPaymentCap).toMatch(/more than the total budget/);
    expect(r.errors.dailyCap).toMatch(/more than the total budget/);
    expect(r.errors.approvalThreshold).toMatch(/at or below the max per payment/);
    expect(r.errors.fund).toMatch(/at most the total budget/);
  });

  it('compares amounts exactly, to the last unit', () => {
    const ok = validateDraft(draft({ perPaymentCap: '40.0000000' }), { nowSeconds: NOW });
    expect(ok.ok).toBe(true);
    const over = validateDraft(draft({ perPaymentCap: '40.0000001' }), { nowSeconds: NOW });
    expect(over.ok).toBe(false);
  });

  it('checks the fund against the wallet balance when it is known', () => {
    const poor = validateDraft(draft(), { nowSeconds: NOW, walletUsdc: '399999999' });
    expect(poor.ok ? null : poor.errors.fund).toBe(
      'Your wallet does not hold that much test USDC.',
    );
    const noTrust = validateDraft(draft(), { nowSeconds: NOW, walletUsdc: null });
    expect(noTrust.ok ? null : noTrust.errors.fund).toMatch(/cannot hold USDC/);
  });

  it('needs at least one valid, distinct recipient', () => {
    const none = validateDraft(draft({ recipients: [] }), { nowSeconds: NOW });
    expect(none.ok ? null : none.errors.recipients).toMatch(/Add at least one recipient/);

    const rows = validateDraft(
      draft({
        recipients: [
          { label: 'Ada', address: ADA },
          { label: 'Kofi', address: ADA },
          { label: 'Nia', address: 'GBAD' },
          { label: '', address: encodeAddress('account', new Uint8Array(32).fill(1)) },
        ],
      }),
      { nowSeconds: NOW },
    );
    expect(rows.ok).toBe(false);
    if (rows.ok) return;
    expect(rows.errors.recipientRows?.[1]).toBe('This address is already on the list.');
    expect(rows.errors.recipientRows?.[2]).toMatch(/56 characters/);
    expect(rows.errors.recipientRows?.[3]).toBe('Give this recipient a short name.');
    expect(rows.errors.recipientRows?.[0]).toBeUndefined();
  });
});

describe('newTaskId', () => {
  it('makes a dated, valid task ID', () => {
    const id = newTaskId(new Date('2026-11-13T09:00:00Z'), () => 0);
    expect(id).toBe('task-20261113-aaaaaa');
    expect(TASK_ID.test(id)).toBe(true);
    expect(TASK_ID.test(newTaskId())).toBe(true);
  });
});
