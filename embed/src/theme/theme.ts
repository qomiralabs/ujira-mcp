// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// Turns the theme defaults into CSS. Every colour, radius, font and curve
// the widget draws with is a custom property, so an integrator restyles the
// widget from their own page without reaching into the shadow root.

import { css, unsafeCSS, type CSSResult } from 'lit';

import { themeBase, themeModes } from './defaults.js';

const PROPERTY_NAME = /^--ujira-embed-[a-z-]+$/;
// Anything that could end a declaration or open a comment or a tag. The
// values come from the defaults module, and this keeps it that way.
const UNSAFE_VALUE = /[;{}<>]|\/\*/;

/** The property declarations for a set of custom properties. */
export function declarations(properties: Readonly<Record<string, string>>): CSSResult {
  const lines = Object.entries(properties).map(([name, value]) => {
    if (!PROPERTY_NAME.test(name)) throw new Error(`${name} is not an embed custom property`);
    if (UNSAFE_VALUE.test(value)) throw new Error(`${name} has a value CSS cannot take: ${value}`);
    return `${name}: ${value};`;
  });
  return unsafeCSS(lines.join('\n  '));
}

/**
 * Every property the focus ring is drawn from, typed.
 *
 * Unregistered, a value CSS cannot use, such as a unitless zero for a width
 * or a var() naming a token the page never defined, makes the whole
 * declaration it is spent in invalid at computed value time, the outline
 * falls back to its initial style of none, and the focus indicator is gone.
 *
 * Registered, the same value makes only the custom property invalid, so it
 * behaves as unset and inherits: what an ancestor set, or the initial value
 * given here. The focus rule always receives something it can draw with. A
 * valid colour still paints, transparent included: an invisible ring the
 * integrator asked for is their choice, not a value we failed to parse.
 */
const FOCUS_SYNTAX = {
  '--ujira-embed-focus-width': '<length>',
  '--ujira-embed-focus-offset': '<length>',
  '--ujira-embed-focus-inner-width': '<length>',
  '--ujira-embed-focus': '<color>',
  '--ujira-embed-focus-inner': '<color>',
} as const;

const FOCUS_INITIAL: Readonly<Record<keyof typeof FOCUS_SYNTAX, string>> = {
  '--ujira-embed-focus-width': themeBase['--ujira-embed-focus-width'],
  '--ujira-embed-focus-offset': themeBase['--ujira-embed-focus-offset'],
  '--ujira-embed-focus-inner-width': themeBase['--ujira-embed-focus-inner-width'],
  '--ujira-embed-focus': themeModes.light['--ujira-embed-focus'],
  '--ujira-embed-focus-inner': themeModes.light['--ujira-embed-focus-inner'],
};

interface PropertyRegistry {
  registerProperty?: (definition: {
    name: string;
    syntax: string;
    inherits: boolean;
    initialValue: string;
  }) => void;
}

/**
 * Registers the five. It has to happen through the API rather than an
 * at-rule in our own stylesheet, because an at-rule inside a shadow root
 * does not register. Registration is global to the page, which is why every
 * name is prefixed.
 *
 * Already registered throws InvalidModificationError, which happens when a
 * page loads the widget twice and is nothing to do about. Anything else is a
 * bug in what we passed and is rethrown.
 */
export function registerFocusProperties(registry: PropertyRegistry = CSS): void {
  for (const [name, syntax] of Object.entries(FOCUS_SYNTAX)) {
    const initialValue = FOCUS_INITIAL[name as keyof typeof FOCUS_SYNTAX];
    try {
      registry.registerProperty?.({ name, syntax, inherits: true, initialValue });
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'InvalidModificationError')) {
        throw error;
      }
    }
  }
}

/**
 * Defaults on the host element. A rule on the integrator's page that targets
 * the element beats these, so the element is where a property is set. A value
 * on an ancestor does not reach the widget, except as the fallback of the
 * five registered focus properties.
 */
export const hostTheme = css`
  :host {
    ${declarations(themeBase)}
    ${declarations(themeModes.light)}
    color-scheme: light;
    display: block;
    max-width: 420px;
    color: var(--ujira-embed-text);
    font-family: var(--ujira-embed-font);
    text-align: start;
  }

  :host([mode='dark']) {
    ${declarations(themeModes.dark)}
    color-scheme: dark;
  }

  @media (prefers-color-scheme: dark) {
    :host([mode='system']) {
      ${declarations(themeModes.dark)}
      color-scheme: dark;
    }
  }

  :host([hidden]) {
    display: none;
  }
`;
