// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The theme: every property is painted and documented, the defaults are the
// landing page's tokens, and the colours pass WCAG AA in both modes.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { themeBase, themeModes } from './defaults.js';
import { widgetStyles } from './styles.js';
import { declarations, registerFocusProperties } from './theme.js';

const EMBED = join(import.meta.dirname, '..', '..');
const STYLES = widgetStyles.map((sheet) => sheet.cssText).join('\n');
const MARK = readFileSync(join(EMBED, 'src', 'brand', 'mark.ts'), 'utf8');
const PROPERTIES = [...Object.keys(themeBase), ...Object.keys(themeModes.light)].sort();

/** The custom properties in the theming table of the README. */
function documented(): string[] {
  const readme = readFileSync(join(EMBED, 'README.md'), 'utf8');
  return [...readme.matchAll(/^\| `(--ujira-embed-[a-z-]+)`/gm)].map((match) => match[1] ?? '');
}

/** The `--name: value` pairs of one block of a stylesheet. */
function block(css: string, selector: string): Map<string, string> {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`no ${selector} block`);
  const body = css.slice(start, css.indexOf('}', start));
  return new Map(
    [...body.matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)].map((m) => [m[1] ?? '', (m[2] ?? '').trim()]),
  );
}

/** A token's value with every var() resolved against the landing page's own tokens. */
function resolved(map: Map<string, string>, base: Map<string, string>, name: string): string {
  let value = map.get(name) ?? base.get(name);
  for (let depth = 0; value?.startsWith('var(') === true && depth < 5; depth++) {
    const inner = /^var\((--[a-z0-9-]+)\)$/.exec(value)?.[1] ?? '';
    value = map.get(inner) ?? base.get(inner);
  }
  if (value === undefined) throw new Error(`no token ${name}`);
  return value.toLowerCase();
}

function luminance(hex: string): number {
  const digits = hex.replace('#', '');
  const full = digits.length === 3 ? digits.replace(/./g, (d) => d + d) : digits;
  const channel = (offset: number): number => {
    const value = Number.parseInt(full.slice(offset, offset + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
}

function contrast(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((light ?? 0) + 0.05) / ((dark ?? 0) + 0.05);
}

describe('the theme', () => {
  it('sets the same colour properties in both modes', () => {
    expect(Object.keys(themeModes.dark).sort()).toEqual(Object.keys(themeModes.light).sort());
  });

  it('paints with every property it offers: one that changes nothing is a broken promise', () => {
    const unused = PROPERTIES.filter(
      (name) => !STYLES.includes(`var(${name})`) && !MARK.includes(`var(${name})`),
    );
    expect(unused).toEqual([]);
  });

  it('documents every property in the README, and nothing that does not exist', () => {
    expect([...documented()].sort()).toEqual(PROPERTIES);
  });

  it('defaults to light, and switches to dark on mode="dark" or a dark system', () => {
    expect(STYLES).toContain(':host {');
    expect(STYLES).toContain(":host([mode='dark'])");
    expect(STYLES).toContain('@media (prefers-color-scheme: dark)');
    expect(STYLES).toContain(":host([mode='system'])");
  });

  it('refuses a property name or a value that could break out of its declaration', () => {
    expect(() => declarations({ '--other': 'red' })).toThrow('not an embed custom property');
    expect(() => declarations({ '--ujira-embed-text': 'red; } body { color: red' })).toThrow(
      'cannot take',
    );
    expect(() => declarations({ '--ujira-embed-text': 'red /* x' })).toThrow('cannot take');
  });

  it('registers the five focus properties, and shrugs off a second load', () => {
    const registered: string[] = [];
    registerFocusProperties({
      registerProperty: ({ name, initialValue }) => {
        registered.push(`${name}=${initialValue}`);
      },
    });
    expect(registered).toEqual([
      '--ujira-embed-focus-width=2px',
      '--ujira-embed-focus-offset=2px',
      '--ujira-embed-focus-inner-width=2px',
      '--ujira-embed-focus=#8F5A00',
      '--ujira-embed-focus-inner=#FFFFFF',
    ]);
    const again = () => {
      registerFocusProperties({
        registerProperty: () => {
          throw new DOMException('already', 'InvalidModificationError');
        },
      });
    };
    expect(again).not.toThrow();
    expect(() => {
      registerFocusProperties({
        registerProperty: () => {
          throw new TypeError('bad syntax');
        },
      });
    }).toThrow('bad syntax');
  });
});

describe('the defaults are the landing page look', () => {
  const tokens = readFileSync(join(EMBED, '..', 'console', 'src', 'brand', 'tokens.css'), 'utf8');
  const base = block(tokens, ':root');
  const light = block(tokens.slice(tokens.indexOf('/* Light')), ':root');
  const dark = block(tokens, ":root[data-theme='dark']");

  // Each embed property and the dashboard token it is drawn from.
  const FROM: Readonly<Record<string, string>> = {
    '--ujira-embed-surface': '--surface',
    '--ujira-embed-field': '--field-bg',
    '--ujira-embed-rule': '--line',
    '--ujira-embed-field-border': '--text-3',
    '--ujira-embed-text': '--text',
    '--ujira-embed-text-secondary': '--text-2',
    '--ujira-embed-accent': '--btn',
    '--ujira-embed-accent-hover': '--btn-hover',
    '--ujira-embed-on-accent': '--btn-text',
    '--ujira-embed-link': '--text',
    '--ujira-embed-mark': '--saffron',
    '--ujira-embed-mark-track': '--line-2',
    '--ujira-embed-focus': '--focus',
  };

  it('in light mode', () => {
    for (const [property, token] of Object.entries(FROM)) {
      const value = themeModes.light[property as keyof typeof themeModes.light];
      expect(value.toLowerCase(), property).toBe(resolved(light, base, token));
    }
    expect(themeModes.light['--ujira-embed-error'].toLowerCase()).toBe(
      resolved(light, base, '--block-fg'),
    );
    expect(themeModes.light['--ujira-embed-shadow']).toBe(base.get('--shadow'));
  });

  it('in dark mode', () => {
    for (const [property, token] of Object.entries(FROM)) {
      const value = themeModes.dark[property as keyof typeof themeModes.dark];
      expect(value.toLowerCase(), property).toBe(resolved(dark, base, token));
    }
    expect(themeModes.dark['--ujira-embed-error'].toLowerCase()).toBe(
      resolved(dark, base, '--block-fg'),
    );
  });

  it('with the same faces and curve', () => {
    expect(themeBase['--ujira-embed-font']).toBe(base.get('--sans'));
    expect(themeBase['--ujira-embed-font-mono']).toBe(base.get('--mono'));
    expect(themeBase['--ujira-embed-ease']).toBe(base.get('--ease'));
  });
});

describe('contrast, WCAG AA', () => {
  for (const mode of ['light', 'dark'] as const) {
    const c = themeModes[mode];
    it(`holds for text, actions, errors, fields and focus in ${mode} mode`, () => {
      const surface = c['--ujira-embed-surface'];
      const field = c['--ujira-embed-field'];
      for (const text of [
        c['--ujira-embed-text'],
        c['--ujira-embed-text-secondary'],
        c['--ujira-embed-link'],
      ]) {
        expect(contrast(text, surface), `${text} on ${surface}`).toBeGreaterThanOrEqual(4.5);
        // Addresses and the message to sign sit on the field colour.
        expect(contrast(text, field), `${text} on ${field}`).toBeGreaterThanOrEqual(4.5);
      }
      // A problem is only ever shown on the card itself.
      expect(contrast(c['--ujira-embed-error'], surface)).toBeGreaterThanOrEqual(4.5);
      const accent = c['--ujira-embed-accent'];
      expect(contrast(c['--ujira-embed-on-accent'], accent)).toBeGreaterThanOrEqual(4.5);
      expect(
        contrast(c['--ujira-embed-on-accent'], c['--ujira-embed-accent-hover']),
      ).toBeGreaterThanOrEqual(4.5);
      // Edges of a control and the focus ring: 3 to 1.
      expect(contrast(c['--ujira-embed-field-border'], surface)).toBeGreaterThanOrEqual(3);
      expect(contrast(c['--ujira-embed-field-border'], field)).toBeGreaterThanOrEqual(3);
      expect(contrast(c['--ujira-embed-focus'], surface)).toBeGreaterThanOrEqual(3);
      // On the action the ring sits on the band, which sits on the action.
      const band = c['--ujira-embed-focus-inner'];
      expect(contrast(c['--ujira-embed-focus'], band)).toBeGreaterThanOrEqual(3);
      expect(
        Math.max(contrast(band, accent), contrast(c['--ujira-embed-focus'], accent)),
      ).toBeGreaterThanOrEqual(3);
    });
  }
});
