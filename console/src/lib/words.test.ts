// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

import { describe, expect, it } from 'vitest';

import { legStatusWord, reasonText, statusWord, waitWords } from './words';

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

  it('says why a payout is held back before the chain is asked', () => {
    expect(reasonText('DESTINATION_NOT_RECEIVABLE')).toBe('Their wallet cannot receive USDC yet.');
    expect(reasonText('RECIPIENT_SUSPENDED')).toBe('Payouts to them are on hold.');
  });

  it('says how long to wait in minutes, or in hours past two', () => {
    expect(waitWords(20)).toBe('less than a minute');
    expect(waitWords(60)).toBe('about 1 minute');
    expect(waitWords(540)).toBe('about 9 minutes');
    expect(waitWords(7200)).toBe('about 120 minutes');
    // A daily cap that resets at midnight.
    expect(waitWords(7 * 3600 - 30)).toBe('about 7 hours');
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

  it('has its own word and tone for each leg status, not a fallback', () => {
    expect(legStatusWord('planned')).toEqual({ label: 'Not sent yet', tone: 'waiting' });
    expect(legStatusWord('submitted')).toEqual({ label: 'Sent to Stellar', tone: 'waiting' });
    expect(legStatusWord('settled')).toEqual({ label: 'Paid', tone: 'paid' });
    expect(legStatusWord('failed')).toEqual({ label: 'Failed', tone: 'blocked' });
    expect(legStatusWord('cancelled')).toEqual({ label: 'Cancelled', tone: 'neutral' });
    // An answer that still uses the payout's words reads as before.
    expect(legStatusWord('pending_approval').label).toBe('Waiting for approval');
    expect(legStatusWord('toString').label).toBe('Tostring');
  });
});
