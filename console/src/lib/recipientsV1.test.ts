// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_INVITE_SECONDS,
  INVITE_LIFETIMES,
  emailProblem,
  inviteLink,
  inviteState,
  recipientLabelProblem,
  recipientWord,
} from './recipientsV1';

const STATUSES = [
  'active',
  'suspended',
  'needs_wallet',
  'no_account',
  'no_trustline',
  'unchecked',
] as const;

describe('recipient words', () => {
  it('gives every status a word, and every one that cannot be paid a reason and a fix', () => {
    for (const status of STATUSES) {
      const word = recipientWord({ status, payable: status === 'active' });
      expect(word.label).not.toBe('');
      if (status === 'active') {
        expect(word).toMatchObject({ tone: 'paid', why: null, todo: null });
      } else {
        expect(word.why).toMatch(/\.$/);
        expect(word.todo).toMatch(/\.$/);
        expect(word.tone).not.toBe('paid');
      }
    }
  });

  it('sends a person without a wallet an invite, and checks a wallet that may get fixed', () => {
    expect(recipientWord({ status: 'needs_wallet', payable: false })).toMatchObject({
      invite: true,
      recheck: false,
    });
    for (const status of ['no_account', 'no_trustline', 'unchecked']) {
      expect(recipientWord({ status, payable: false }).recheck).toBe(true);
    }
    expect(recipientWord({ status: 'no_trustline', payable: false }).todo).toContain('USDC');
  });

  it('is honest about a status it does not know, and trusts the payable flag', () => {
    expect(recipientWord({ status: 'frozen_by_partner', payable: false })).toMatchObject({
      label: 'Unknown',
      tone: 'neutral',
    });
    expect(recipientWord({ status: 'verified', payable: true })).toMatchObject({
      label: 'Ready',
      why: null,
    });
    // A name inherited from Object never reads as a status.
    expect(recipientWord({ status: 'constructor', payable: false }).label).toBe('Unknown');
  });
});

describe('the add form checks', () => {
  it('needs a name of up to 100 characters with no control characters', () => {
    expect(recipientLabelProblem('  ')).toBe('Enter a name.');
    expect(recipientLabelProblem('a'.repeat(101))).toContain('100');
    expect(recipientLabelProblem('Ada\u0007')).not.toBeNull();
    expect(recipientLabelProblem(' Ada Obi ')).toBeNull();
  });

  it('takes an empty email, and refuses one that is not an address', () => {
    expect(emailProblem('')).toBeNull();
    expect(emailProblem('ada@example.com')).toBeNull();
    expect(emailProblem('ada at example')).not.toBeNull();
  });
});

describe('invite links', () => {
  it('carries the token in the fragment, never the path or the query', () => {
    const token = `ujes_test_${'a'.repeat(24)}`;
    const link = new URL(inviteLink('https://ujira.co/', token));
    expect(link.origin).toBe('https://ujira.co');
    expect(link.pathname).toBe('/embed/v1/invite');
    expect(link.search).toBe('');
    expect(link.hash).toBe(`#token=${token}`);
  });

  it('is live until it expires or is revoked', () => {
    const now = Date.parse('2026-11-27T12:00:00.000Z');
    const live = { expiresAt: '2026-11-27T13:00:00.000Z', revokedAt: null };
    expect(inviteState(live, now)).toBe('live');
    expect(inviteState({ ...live, expiresAt: '2026-11-27T12:00:00.000Z' }, now)).toBe('expired');
    expect(inviteState({ ...live, revokedAt: '2026-11-27T11:00:00.000Z' }, now)).toBe('revoked');
    expect(inviteState({ ...live, expiresAt: 'soon' }, now)).toBe('expired');
  });

  it('offers lifetimes the server takes, with the default among them', () => {
    for (const l of INVITE_LIFETIMES) {
      expect(l.seconds).toBeGreaterThanOrEqual(5 * 60);
      expect(l.seconds).toBeLessThanOrEqual(7 * 24 * 3600);
    }
    expect(INVITE_LIFETIMES.map((l) => l.seconds)).toContain(DEFAULT_INVITE_SECONDS);
  });
});
