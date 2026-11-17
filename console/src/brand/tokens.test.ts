// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

/// <reference types="node" />

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

// Read from disk: the landing page lives outside the console, where the
// bundler does not look.
const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const tokens = read('./tokens.css');
const site = read('../../../site/index.html');

/** The first `:root { ... }` block of a stylesheet, as written. */
function firstRoot(css: string): string {
  const start = css.indexOf(':root {');
  const end = css.indexOf('\n}', start);
  if (start < 0 || end < 0) throw new Error('No :root block found');
  return css.slice(start, end + 2).replace(/\r\n/g, '\n');
}

function roles(block: string): string[] {
  return [...block.matchAll(/^\s+(--[a-z0-9-]+):/gm)].map((m) => m[1] ?? '').sort();
}

describe('the dashboard tokens', () => {
  it('start with the landing page tokens, line for line', () => {
    expect(firstRoot(tokens)).toBe(firstRoot(site));
  });

  it('use Urbanist for text and JetBrains Mono for addresses', () => {
    expect(tokens).toContain('--sans: "Urbanist"');
    expect(tokens).toContain('--mono: "JetBrains Mono"');
  });

  it('follow the device unless a theme is chosen', () => {
    expect(tokens).toContain(":root[data-theme='dark']");
    expect(tokens).toContain('@media (prefers-color-scheme: dark)');
    expect(tokens).toContain(":root:not([data-theme='light'])");
    expect(tokens).toContain('color-scheme: dark;');
  });

  it('give dark mode every colour role light mode has', () => {
    const [, light = '', rest = ''] = tokens.split(/^\/\* (?:Light|Dark):.*\*\/$/m);
    const [dark = '', media = ''] = rest.split('@media');
    const lightRoles = roles(light).filter((r) => !r.startsWith('--r-'));
    expect(roles(dark)).toEqual(lightRoles);
    expect(roles(media)).toEqual(lightRoles);
  });
});
