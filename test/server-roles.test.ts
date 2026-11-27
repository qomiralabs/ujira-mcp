// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

import { describe, expect, it } from 'vitest';

import { EngineError } from '../src/errors.js';
import { DEFAULT_ROLES, parseRoles } from '../src/server/roles.js';

function refusal(raw: string): EngineError {
  try {
    parseRoles(raw);
  } catch (error) {
    if (error instanceof EngineError) return error;
    throw error;
  }
  throw new Error(`parseRoles accepted ${raw}`);
}

describe('parseRoles', () => {
  it('runs both roles when UJIRA_ROLES is unset or blank, so a deploy changes nothing', () => {
    expect(DEFAULT_ROLES).toEqual(['web', 'worker']);
    expect(parseRoles(undefined)).toEqual(['web', 'worker']);
    expect(parseRoles('')).toEqual(['web', 'worker']);
    expect(parseRoles('   ')).toEqual(['web', 'worker']);
  });

  it('reads one role or both, trimmed, always in the same order', () => {
    expect(parseRoles('web')).toEqual(['web']);
    expect(parseRoles('worker')).toEqual(['worker']);
    expect(parseRoles('web,worker')).toEqual(['web', 'worker']);
    expect(parseRoles(' worker , web ')).toEqual(['web', 'worker']);
  });

  it('refuses an unknown role and names it', () => {
    const error = refusal('web,wroker');
    expect(error.code).toBe('config_invalid');
    expect(error.message).toBe(
      'UJIRA_ROLES must be web, worker or web,worker; "wroker" is not a role',
    );
  });

  it('is case sensitive', () => {
    expect(refusal('Web').message).toContain('"Web" is not a role');
  });

  it('never echoes an entry that is long or not plain', () => {
    const pasted = `S${'A'.repeat(55)}`;
    const error = refusal(pasted);
    expect(error.message).toBe(
      'UJIRA_ROLES must be web, worker or web,worker; an entry is not a role',
    );
    expect(error.message).not.toContain(pasted);
    expect(refusal('web worker').message).toContain('an entry is not a role');
  });

  it('refuses an empty entry and a repeated role', () => {
    expect(refusal('web,').message).toBe(
      'UJIRA_ROLES must be web, worker or web,worker, with no empty entry',
    );
    expect(refusal(',worker').message).toContain('no empty entry');
    expect(refusal('web,web').message).toBe(
      'UJIRA_ROLES must be web, worker or web,worker; "web" is named twice',
    );
  });
});
