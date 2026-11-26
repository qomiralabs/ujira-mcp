// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

import { describe, expect, it } from 'vitest';

import { reasonText, statusWord } from './words';

describe('words for /v1 codes', () => {
  it('reads the mandate rules /v1 names in capitals', () => {
    expect(reasonText('MANDATE_PAUSED')).toBe('The mandate is paused. Resume it to pay again.');
    expect(reasonText('PAYMENT_CAP_EXCEEDED')).toBe('Over the max per payment.');
    expect(reasonText('RECIPIENT_HAS_NO_METHOD')).toBe(
      'This recipient has no wallet to be paid to yet.',
    );
    expect(reasonText('SOME_NEW_RULE')).toBe('Some new rule.');
    expect(reasonText('mandate_paused')).toBe('The mandate is paused. Resume it to pay again.');
  });

  it('has a word and a tone for every /v1 payout status', () => {
    for (const status of [
      'queued',
      'submitting',
      'pending_approval',
      'approved',
      'settling',
      'needs_attention',
      'paid',
      'blocked',
      'rejected',
      'cancelled',
      'failed',
    ]) {
      const word = statusWord(status);
      expect(word.label).not.toBe('');
      expect(word.label).not.toContain('_');
    }
    expect(statusWord('needs_attention')).toEqual({ label: 'Needs a look', tone: 'blocked' });
    expect(statusWord('partly_paid').label).toBe('Partly paid');
  });
});
