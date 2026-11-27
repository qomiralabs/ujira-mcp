// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The UJIRA mark for the footer line, as the landing page draws it: the arc
// in the colour of the text beside it, the dot in saffron. Never redraw it.

import { svg, type SVGTemplateResult } from 'lit';

/** The coordinate system the mark is drawn in. */
export const markViewBox = '0 0 100 100';

export const markShapes: SVGTemplateResult = svg`<path d="M34 46C30 38 22 32 14 32C14 56 30 68 50 68C70 68 86 56 86 32C78 32 70 38 66 46" fill="none" stroke="currentColor" stroke-width="7.5" stroke-linecap="round" stroke-linejoin="round"></path><circle class="mark-dot" cx="50" cy="40" r="11"></circle>`;
