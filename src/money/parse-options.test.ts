// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// parseMoney options that are present but not an object. The contract only
// names options.rounding, so anything that cannot hold it is a bad rounding.

import { describe, expect, it } from 'vitest';

import * as moneyIndex from './index.js';
import { InvalidScaleError } from './index.js';
import type { MoneyError } from './index.js';
import { parseMoney } from './parse.js';

type ErrorClass = abstract new (message?: string) => MoneyError;
const InvalidRoundingModeError = (moneyIndex as Record<string, unknown>)[
  'InvalidRoundingModeError'
] as ErrorClass;

describe('parseMoney options that are not an object', () => {
  it.each([
    ['null', null],
    ['a string', 'half-even'],
    ['a boolean', true],
    ['a bigint', 1n],
  ])('throws InvalidRoundingModeError for %s', (_label, options) => {
    let err: unknown;
    try {
      parseMoney('1.5', 'USD', options as never);
    } catch (caught) {
      err = caught;
    }
    expect(err).toBeInstanceOf(InvalidRoundingModeError);
  });
});

describe('parseMoney given a bare number as options', () => {
  it('throws InvalidScaleError, since it is a scale passed the old way', () => {
    let err: unknown;
    try {
      parseMoney('1.5', 'USD', 2 as never);
    } catch (caught) {
      err = caught;
    }
    expect(err).toBeInstanceOf(InvalidScaleError);
  });
});
