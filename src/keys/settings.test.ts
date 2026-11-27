// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { EngineError } from '../errors.js';
import { requireSealer, sealerFromEnv } from './settings.js';

function refusal(work: () => unknown): EngineError {
  try {
    work();
  } catch (error) {
    if (error instanceof EngineError) return error;
    throw error;
  }
  throw new Error('expected an EngineError');
}

describe('the key encryption key setting', () => {
  it('builds a sealer from 32 bytes of base64', () => {
    const sealer = sealerFromEnv({ UJIRA_KEY_ENCRYPTION_KEY: randomBytes(32).toString('base64') });
    expect(sealer).toBeDefined();
    const box = sealer?.seal(Buffer.from('x'), 'a');
    expect(box === undefined ? '' : sealer?.open(box, 'a').toString()).toBe('x');
  });

  it('is absent when unset, empty or blank', () => {
    expect(sealerFromEnv({})).toBeUndefined();
    expect(sealerFromEnv({ UJIRA_KEY_ENCRYPTION_KEY: '' })).toBeUndefined();
    expect(sealerFromEnv({ UJIRA_KEY_ENCRYPTION_KEY: ' \n' })).toBeUndefined();
  });

  it('takes a key with the newline a paste leaves behind', () => {
    const key = randomBytes(32).toString('base64');
    expect(sealerFromEnv({ UJIRA_KEY_ENCRYPTION_KEY: `${key}\n` })).toBeDefined();
  });

  it.each([
    ['31 bytes', randomBytes(31).toString('base64')],
    ['33 bytes', randomBytes(33).toString('base64')],
    ['hex', randomBytes(32).toString('hex')],
    [
      'a line break inside',
      `${randomBytes(16).toString('base64')}\n${randomBytes(16).toString('base64')}`,
    ],
  ])('refuses %s, without repeating any of it', (_, value) => {
    const error = refusal(() => sealerFromEnv({ UJIRA_KEY_ENCRYPTION_KEY: value }));
    expect(error.code).toBe('config_invalid');
    expect(error.message).toContain('UJIRA_KEY_ENCRYPTION_KEY');
    expect(error.message).not.toContain(value.trim().slice(0, 8));
    expect(error.cause).toBeUndefined();
    expect(JSON.stringify(error)).not.toContain(value.trim().slice(0, 8));
  });

  it('is required where a role keeps agent keys, and says what needs it', () => {
    const error = refusal(() => requireSealer({}, 'UJIRA_SIGN_IN=on'));
    expect(error.code).toBe('config_invalid');
    expect(error.message).toContain('UJIRA_SIGN_IN=on needs UJIRA_KEY_ENCRYPTION_KEY');
    expect(
      requireSealer({ UJIRA_KEY_ENCRYPTION_KEY: randomBytes(32).toString('base64') }, 'x'),
    ).toBeDefined();
  });
});
