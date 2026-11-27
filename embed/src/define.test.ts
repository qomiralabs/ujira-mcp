// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// @vitest-environment happy-dom

// Its own file, because the element can be defined only once per page and
// every other test file loads the entry point with a working registry.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const broken = new TypeError('registerProperty was replaced by the page');

beforeEach(() => {
  vi.stubGlobal('CSS', {
    registerProperty() {
      throw broken;
    },
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('loading the script on a page that broke property registration', () => {
  it('reports the error and still defines the element', async () => {
    const reported: unknown[] = [];
    vi.stubGlobal('reportError', (error: unknown) => {
      reported.push(error);
    });

    const { TAG_NAME, UjiraOnboarding } = await import('./index.js');

    expect(customElements.get(TAG_NAME)).toBe(UjiraOnboarding);
    expect(reported).toEqual([broken]);
  });

  it('throws it from a timer where the browser has no reportError, and defines once', async () => {
    vi.stubGlobal('reportError', undefined);
    vi.useFakeTimers();
    const { define, TAG_NAME, UjiraOnboarding } = await import('./index.js');

    expect(() => {
      define();
    }).not.toThrow();
    expect(customElements.get(TAG_NAME)).toBe(UjiraOnboarding);
    expect(() => {
      vi.runAllTimers();
    }).toThrow(broken);
  });
});
