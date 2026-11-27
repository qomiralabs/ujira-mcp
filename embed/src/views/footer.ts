// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The one place UJIRA appears in the widget: a single footer line with the
// mark at 16px. The widget carries no other UJIRA branding.

import { html, type TemplateResult } from 'lit';

import { markShapes, markViewBox } from '../brand/mark.js';

export function footer(byline: string): TemplateResult {
  return html`<p class="footer">
    <svg viewBox=${markViewBox} aria-hidden="true">${markShapes}</svg>
    <span>${byline}</span>
  </p>`;
}
