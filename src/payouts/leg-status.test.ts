// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

import { describe, expect, it } from 'vitest';

import { InvalidTransitionError } from './errors.js';
import {
  LEG_STATUSES,
  LEG_TRANSITIONS,
  assertLegTransition,
  canLegTransition,
  isLegStatus,
  legStatus,
} from './leg-status.js';
import type { LegStatus } from './leg-status.js';

// Written out by hand, so a change to the module's table cannot also change
// what it is checked against.
const ALLOWED: Readonly<Record<string, readonly string[]>> = {
  planned: ['submitted', 'settled', 'failed', 'cancelled'],
  submitted: ['settled', 'planned', 'failed'],
};

const EVERY_STATUS = ['planned', 'submitted', 'settled', 'failed', 'cancelled'];

const PAIRS = EVERY_STATUS.flatMap((from) =>
  EVERY_STATUS.map((to): [string, string, boolean] => [
    from,
    to,
    (ALLOWED[from] ?? []).includes(to),
  ]),
);

describe('payout leg statuses', () => {
  it('names every wire status', () => {
    expect([...LEG_STATUSES].sort()).toEqual([...EVERY_STATUS].sort());
    for (const status of EVERY_STATUS) expect(legStatus.parse(status)).toBe(status);
    expect(legStatus.safeParse('delivered').success).toBe(false);
  });

  it('knows its own statuses and nothing else', () => {
    for (const status of EVERY_STATUS) expect(isLegStatus(status)).toBe(true);
    for (const value of ['', 'PLANNED', '__proto__', 'constructor', 1, null, undefined]) {
      expect(isLegStatus(value)).toBe(false);
    }
  });

  it('is frozen', () => {
    expect(Object.isFrozen(LEG_STATUSES)).toBe(true);
    expect(Object.isFrozen(LEG_TRANSITIONS)).toBe(true);
    for (const status of LEG_STATUSES) expect(Object.isFrozen(LEG_TRANSITIONS[status])).toBe(true);
  });

  it.each(PAIRS)('%s to %s allowed: %s', (from, to, allowed) => {
    expect(canLegTransition(from as LegStatus, to as LegStatus)).toBe(allowed);
    if (allowed) {
      expect(() => {
        assertLegTransition(from as LegStatus, to as LegStatus);
      }).not.toThrow();
    } else {
      expect(() => {
        assertLegTransition(from as LegStatus, to as LegStatus);
      }).toThrow(new InvalidTransitionError(`payout leg cannot move from ${from} to ${to}`));
    }
  });

  it('refuses unknown values without repeating them', () => {
    for (const value of ['__proto__', 'constructor', 'delivered']) {
      expect(canLegTransition(value as LegStatus, 'settled')).toBe(false);
      expect(() => {
        assertLegTransition(value as LegStatus, 'settled');
      }).toThrow(new InvalidTransitionError('unknown payout leg status'));
      expect(() => {
        assertLegTransition('planned', value as LegStatus);
      }).toThrow(new InvalidTransitionError('unknown payout leg status'));
    }
  });
});
