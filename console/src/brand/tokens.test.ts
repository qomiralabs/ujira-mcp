// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

import { describe, expect, it } from 'vitest';

import tokens from './tokens.json';
import { tokensToCss } from './tokens';

describe('tokensToCss', () => {
  const css = tokensToCss(tokens);

  it('carries every light and dark mode colour', () => {
    expect(css).toContain('--bg: #FBF7F0;');
    expect(css).toContain('--accent: #F4A300;');
    expect(css).toContain('--bg: #0A3540;');
    expect(css).toContain('--accent-text: #FFC14D;');
    expect(css).toContain('--status-paid-fill: #16A34A;');
    expect(css).not.toContain('--logo');
  });

  it('follows the device unless a theme is chosen', () => {
    expect(css).toContain(':root[data-theme="dark"]');
    expect(css).toContain('@media (prefers-color-scheme: dark)');
    expect(css).toContain(':root:not([data-theme="light"])');
    expect(css).toContain('color-scheme: dark;');
  });
});
