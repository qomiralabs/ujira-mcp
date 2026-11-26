// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// Product code that reaches into the testnet demo, in four ways. The demo
// boundary test lints this text as if it lived in src/; here in test/ it is
// allowed, so the repository's own lint run stays clean.

import { createDemo } from '../../../src/demo/index.js';
import type { DemoSettings } from '../../../src/demo/settings.js';
export { SDP_RAIL } from '../../../src/demo/sdp.js';

export const build = (settings: DemoSettings): unknown => [createDemo, settings];
export const later = () => import('../../../src/demo/index.js');
// A file whose name starts with demo is not the folder.
export const fine = () => import('../../../examples/demo.js');
