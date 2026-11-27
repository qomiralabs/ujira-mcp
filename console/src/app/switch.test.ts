// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

import { describe, expect, it } from 'vitest';

import { v1ScreensFor } from './switch';

describe('the screens a page load reads from /v1', () => {
  it('takes only the build flag on a live build, whatever the address says', () => {
    expect([...v1ScreensFor('', false, '?v1=mandates')]).toEqual([]);
    expect([...v1ScreensFor('payouts', false, '?v1=all')]).toEqual(['payouts']);
    expect([...v1ScreensFor(undefined, false, '')]).toEqual([]);
  });

  it('adds the screens named in the address in mock mode', () => {
    expect([...v1ScreensFor('', true, '?mock=1&v1=mandates')]).toEqual(['mandates']);
    expect([...v1ScreensFor('payouts', true, '?mock=1&v1=mandates')].sort()).toEqual([
      'mandates',
      'payouts',
    ]);
    expect(v1ScreensFor(undefined, true, '?mock=1&v1=all').size).toBe(7);
    expect([...v1ScreensFor(undefined, true, '?mock=1')]).toEqual([]);
  });
});
