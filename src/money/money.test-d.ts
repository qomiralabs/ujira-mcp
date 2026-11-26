// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// Compile time checks on the money types, run by typecheck.

import { describe, expectTypeOf, it } from 'vitest';

import type { Chain, TokenAmount, TokenAsset } from './index.js';

describe('money types', () => {
  it('a token amount keeps its chain field', () => {
    // There is one chain today, but the field stays so a second chain would
    // make two values that cannot mix, rather than one value that silently
    // means two things.
    expectTypeOf<TokenAmount['chain']>().toEqualTypeOf<Chain>();
    expectTypeOf<TokenAmount>().toHaveProperty('chain');
    expectTypeOf<TokenAmount['asset']>().toEqualTypeOf<TokenAsset>();
  });
});
