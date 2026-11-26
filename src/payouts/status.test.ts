// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

import { describe, expect, it } from 'vitest';

import { InvalidTransitionError, PayoutError } from './errors.js';
import {
  PAYOUT_STATUSES,
  PAYOUT_TRANSITIONS,
  RESERVED_STATUSES,
  TERMINAL_STATUSES,
  assertTransition,
  canTransition,
  isPayoutStatus,
  isTerminal,
  nextStatuses,
  payoutStatus,
} from './status.js';
import type { PayoutStatus } from './status.js';

// Written out by hand from the design table rather than read from the module,
// so a change to the module's table cannot also change what it is checked
// against.
const ALLOWED: Readonly<Record<string, readonly string[]>> = {
  queued: ['submitting', 'blocked', 'failed'],
  submitting: ['pending_approval', 'approved', 'blocked', 'needs_attention'],
  pending_approval: ['approved', 'rejected', 'cancelled'],
  approved: ['settling'],
  settling: ['paid', 'needs_attention'],
  needs_attention: ['submitting', 'settling', 'paid', 'failed'],
};

const EVERY_STATUS = [
  'queued',
  'submitting',
  'pending_approval',
  'approved',
  'settling',
  'paid',
  'partly_paid',
  'needs_attention',
  'blocked',
  'rejected',
  'cancelled',
  'failed',
];

const TERMINAL = ['paid', 'blocked', 'rejected', 'cancelled', 'failed'];

const PAIRS = EVERY_STATUS.flatMap((from) =>
  EVERY_STATUS.map((to): [string, string, boolean] => [
    from,
    to,
    (ALLOWED[from] ?? []).includes(to),
  ]),
);

describe('payout statuses', () => {
  it('names every wire status, including the reserved one', () => {
    expect([...PAYOUT_STATUSES].sort()).toEqual([...EVERY_STATUS].sort());
    expect(RESERVED_STATUSES).toEqual(['partly_paid']);
  });

  it('marks exactly paid, blocked, rejected, cancelled and failed as terminal', () => {
    expect([...TERMINAL_STATUSES].sort()).toEqual([...TERMINAL].sort());
    for (const status of PAYOUT_STATUSES) {
      expect(isTerminal(status), status).toBe(TERMINAL.includes(status));
    }
  });

  it('checks all 144 pairs', () => {
    expect(PAIRS).toHaveLength(144);
  });

  it.each(PAIRS)('%s to %s allowed is %s', (from, to, allowed) => {
    expect(canTransition(from as PayoutStatus, to as PayoutStatus)).toBe(allowed);
    if (allowed) {
      expect(() => {
        assertTransition(from as PayoutStatus, to as PayoutStatus);
      }).not.toThrow();
    } else {
      expect(() => {
        assertTransition(from as PayoutStatus, to as PayoutStatus);
      }).toThrow(InvalidTransitionError);
    }
  });

  it('gives terminal and reserved statuses no exits and no status a self loop', () => {
    for (const status of [...TERMINAL, 'partly_paid']) {
      expect(nextStatuses(status as PayoutStatus), status).toEqual([]);
    }
    for (const status of PAYOUT_STATUSES) {
      expect(canTransition(status, status), status).toBe(false);
    }
  });

  it('never enters the reserved status', () => {
    for (const from of PAYOUT_STATUSES) {
      expect(canTransition(from, 'partly_paid'), from).toBe(false);
    }
  });

  it('reaches every non reserved status from queued', () => {
    const seen = new Set<PayoutStatus>(['queued']);
    const todo: PayoutStatus[] = ['queued'];
    for (let next = todo.pop(); next !== undefined; next = todo.pop()) {
      for (const to of nextStatuses(next)) {
        if (!seen.has(to)) {
          seen.add(to);
          todo.push(to);
        }
      }
    }
    expect([...seen].sort()).toEqual(EVERY_STATUS.filter((s) => s !== 'partly_paid').sort());
  });

  it('exports the table as frozen data matching canTransition', () => {
    expect(Object.isFrozen(PAYOUT_TRANSITIONS)).toBe(true);
    for (const status of PAYOUT_STATUSES) {
      expect(Object.isFrozen(PAYOUT_TRANSITIONS[status]), status).toBe(true);
      expect([...PAYOUT_TRANSITIONS[status]].sort(), status).toEqual(
        [...(ALLOWED[status] ?? [])].sort(),
      );
    }
    expect(Object.isFrozen(PAYOUT_STATUSES)).toBe(true);
    expect(Object.isFrozen(TERMINAL_STATUSES)).toBe(true);
  });
});

describe('untrusted status values', () => {
  const HOSTILE: unknown[] = [
    '__proto__',
    'constructor',
    'toString',
    'hasOwnProperty',
    'QUEUED',
    ' queued',
    '',
    null,
    undefined,
    0,
    {},
    new String('queued'),
  ];

  it.each(HOSTILE.map((v) => [v]))('%o is not a status', (value) => {
    expect(isPayoutStatus(value)).toBe(false);
    expect(payoutStatus.safeParse(value).success).toBe(false);
    expect(canTransition(value as PayoutStatus, 'submitting')).toBe(false);
    expect(canTransition('queued', value as PayoutStatus)).toBe(false);
    expect(isTerminal(value as PayoutStatus)).toBe(false);
    expect(nextStatuses(value as PayoutStatus)).toEqual([]);
  });

  it('refuses an unknown status without echoing it', () => {
    let caught: unknown;
    try {
      assertTransition('queued', 'secret-value-123' as PayoutStatus);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(InvalidTransitionError);
    expect(caught).toBeInstanceOf(PayoutError);
    const failure = caught as InvalidTransitionError;
    expect(failure.code).toBe('INVALID_TRANSITION');
    expect(failure.name).toBe('InvalidTransitionError');
    expect(failure.message).not.toContain('secret-value-123');
  });

  it('names both statuses when the pair is known but not allowed', () => {
    expect(() => {
      assertTransition('paid', 'queued');
    }).toThrow('payout cannot move from paid to queued');
  });

  it('accepts every status through the schema', () => {
    for (const status of EVERY_STATUS) {
      expect(payoutStatus.parse(status)).toBe(status);
      expect(isPayoutStatus(status)).toBe(true);
    }
  });
});
