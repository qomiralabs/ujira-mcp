// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// Fails when the built widget breaks its budget. Runs after every build.
//
//   node scripts/size.ts [file]

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { BUDGET_BYTES, checkBundle } from './budget.ts';

const file = process.argv[2] ?? join(import.meta.dirname, '..', 'dist', 'ujira-embed.js');
const report = checkBundle(readFileSync(file, 'utf8'));
const kb = (bytes: number): string => (bytes / 1024).toFixed(1);

process.stdout.write(
  `ujira-embed.js: ${kb(report.bytes)} KB raw, ${kb(report.gzipBytes)} KB gzipped, ` +
    `budget ${kb(BUDGET_BYTES)} KB gzipped\n`,
);
for (const problem of report.problems) process.stderr.write(`${problem}\n`);
if (report.problems.length > 0) process.exitCode = 1;
