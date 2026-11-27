// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The languages that wait for a translator or a reviewer. They stay in the
// code so the work already done is not lost, but nothing in the widget
// imports this file: at the testnet launch every reader gets English.
//
// A language ships when two things are true: none of its strings is null,
// and a native speaker has reviewed it. Then it moves into the catalogue,
// with its `reviewed` flag set here first.

import type { Draft } from '../catalogue.js';
import { es } from './es.js';
import { fr } from './fr.js';
import { ha } from './ha.js';
import { ig } from './ig.js';
import { pt } from './pt.js';
import { sw } from './sw.js';
import { yo } from './yo.js';

export const DRAFT_LOCALES = ['ha', 'yo', 'ig', 'sw', 'fr', 'pt', 'es'] as const;

export type DraftLocale = (typeof DRAFT_LOCALES)[number];

export interface DraftEntry {
  readonly draft: Draft;
  /** A native speaker has read every string. None has yet. */
  readonly reviewed: boolean;
}

export const DRAFTS: Readonly<Record<DraftLocale, DraftEntry>> = {
  ha: { draft: ha, reviewed: false },
  yo: { draft: yo, reviewed: false },
  ig: { draft: ig, reviewed: false },
  sw: { draft: sw, reviewed: false },
  fr: { draft: fr, reviewed: false },
  pt: { draft: pt, reviewed: false },
  es: { draft: es, reviewed: false },
};
