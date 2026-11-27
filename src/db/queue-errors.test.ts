// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// What the queue keeps of a failed attempt: a code, never a message, since the
// library stores the message in the job row and logs it. No database here.

import { describe, expect, it } from 'vitest';

import { attemptFailure, JobAttemptFailed } from './queue.js';

describe('attemptFailure', () => {
  it.each([
    [
      Object.assign(new Error('GABC... has no trustline'), { code: 'NO_TRUSTLINE' }),
      'NO_TRUSTLINE',
    ],
    [Object.assign(new Error('x'), { code: '57P01' }), '57P01'],
    [Object.assign(new Error('x'), { code: 'not a code: it has spaces' }), 'Error'],
    [Object.assign(new Error('x'), { code: 42 }), 'Error'],
    [new TypeError('cannot read the secret of undefined'), 'TypeError'],
    ['thrown as a string', 'unknown'],
    [null, 'unknown'],
  ])('keeps only the code of %s', (error, code) => {
    const failure = attemptFailure(error);
    expect(failure).toBeInstanceOf(JobAttemptFailed);
    expect(failure.code).toBe(code);
    expect(failure.message).toBe(code);
    expect(failure.cause).toBeUndefined();
  });

  it('passes one already reduced through as it is', () => {
    const failure = new JobAttemptFailed('TIMEOUT');
    expect(attemptFailure(failure)).toBe(failure);
  });

  it('never repeats an error name that is not a plain word', () => {
    const error = new Error('x');
    error.name = 'a name with a value in it';
    expect(attemptFailure(error).code).toBe('Error');
  });
});
