// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// Fails when the built widget breaks its budget. Runs after every build.
//
//   node scripts/size.ts [dist folder]
//
// The main file is checked in full. Albedo's library is a chunk of its own,
// loaded only when someone picks Albedo; the main file and every chunk are
// still held to the budget together.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { BUDGET_BYTES, checkBundle, checkNames, checkTotal, gzipSize } from './budget.ts';

const MAIN = 'ujira-embed.js';
const dist = process.argv[2] ?? join(import.meta.dirname, '..', 'dist');
const names = readdirSync(dist)
  .filter((name) => name.endsWith('.js'))
  .sort();
const kb = (bytes: number): string => (bytes / 1024).toFixed(1);

const main = readFileSync(join(dist, MAIN), 'utf8');
const report = checkBundle(main);
process.stdout.write(
  `${MAIN}: ${kb(report.bytes)} KB raw, ${kb(report.gzipBytes)} KB gzipped, ` +
    `budget ${kb(BUDGET_BYTES)} KB gzipped\n`,
);

const files = names.map((name) => readFileSync(join(dist, name), 'utf8'));
for (const [index, name] of names.entries()) {
  if (name === MAIN) continue;
  process.stdout.write(
    `${name}: ${kb(gzipSize(files[index] ?? ''))} KB gzipped, loaded on demand\n`,
  );
}

const problems = [...report.problems, ...checkTotal(files), ...checkNames(names)];
for (const problem of problems) process.stderr.write(`${problem}\n`);
if (problems.length > 0) process.exitCode = 1;
