// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The default value of every custom property, taken from the landing page
// and the dashboard (console/src/brand/tokens.css). A test reads that file
// and fails when a value here drifts from the token it names.
//
// The widget loads no font of its own: Urbanist and JetBrains Mono are used
// when the page has them, and the system faces otherwise.

/** Custom properties that are the same in every colour mode. */
export const themeBase = {
  '--ujira-embed-font': '"Urbanist", "Segoe UI", system-ui, sans-serif',
  '--ujira-embed-font-mono': '"JetBrains Mono", ui-monospace, Consolas, monospace',
  '--ujira-embed-radius-card': '24px',
  '--ujira-embed-radius-control': '12px',
  '--ujira-embed-focus-width': '2px',
  '--ujira-embed-focus-offset': '2px',
  '--ujira-embed-focus-inner-width': '2px',
  '--ujira-embed-ease': 'cubic-bezier(.16,1,.3,1)',
} as const;

/** Colour properties per mode. The light mode is the default. */
export const themeModes = {
  light: {
    '--ujira-embed-surface': '#FFFFFF',
    '--ujira-embed-field': '#EDF5F6',
    '--ujira-embed-rule': '#e3eaec',
    '--ujira-embed-field-border': '#6D7E83',
    '--ujira-embed-text': '#0A1F26',
    '--ujira-embed-text-secondary': '#3F5258',
    '--ujira-embed-accent': '#000',
    '--ujira-embed-accent-hover': '#0F4C5C',
    '--ujira-embed-on-accent': '#fff',
    '--ujira-embed-link': '#0A1F26',
    '--ujira-embed-mark': '#F4A300',
    '--ujira-embed-mark-track': '#cbd7da',
    '--ujira-embed-error': '#B91C1C',
    '--ujira-embed-focus': '#8F5A00',
    '--ujira-embed-focus-inner': '#FFFFFF',
    '--ujira-embed-shadow': '0 2px 6px rgba(10,31,38,.06), 0 24px 60px -18px rgba(10,31,38,.28)',
  },
  dark: {
    '--ujira-embed-surface': '#0f3a45',
    '--ujira-embed-field': '#0b2a33',
    '--ujira-embed-rule': '#1c4f5b',
    '--ujira-embed-field-border': '#86a9b0',
    '--ujira-embed-text': '#eaf4f5',
    '--ujira-embed-text-secondary': '#a9c6cc',
    '--ujira-embed-accent': '#eaf4f5',
    '--ujira-embed-accent-hover': '#ffffff',
    '--ujira-embed-on-accent': '#0b2a33',
    '--ujira-embed-link': '#eaf4f5',
    '--ujira-embed-mark': '#F4A300',
    '--ujira-embed-mark-track': '#2e5e69',
    '--ujira-embed-error': '#FCA5A5',
    '--ujira-embed-focus': '#F4A300',
    '--ujira-embed-focus-inner': '#0b2a33',
    '--ujira-embed-shadow': 'none',
  },
} as const;

/** A colour mode the widget can render in. */
export type ThemeMode = keyof typeof themeModes;
