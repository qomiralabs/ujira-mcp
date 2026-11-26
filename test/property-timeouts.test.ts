// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// Property tests with many runs take several times longer on a loaded runner
// than on an idle one, and the default 5 second timeout then fails them at
// random. Any test file under src/ that runs more than MAX_DEFAULT_RUNS cases
// must give its property describe blocks an explicit timeout.

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

const SRC = join(import.meta.dirname, '..', 'src');
const MAX_DEFAULT_RUNS = 200n;
const NUM_RUNS = /numRuns:\s*([\d_]+)/g;
const DESCRIBE_WITH_TIMEOUT = /describe\(\s*'[^']*',\s*\{\s*timeout:\s*PROPERTY_TIMEOUT_MS\s*\}/;
const TIMEOUT_CONSTANT = /^const PROPERTY_TIMEOUT_MS = ([\d_]+);$/m;

const digits = (text: string | undefined): bigint => BigInt((text ?? '0').replaceAll('_', ''));

function testFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return testFiles(path);
    return entry.name.endsWith('.test.ts') ? [path] : [];
  });
}

const heavy = testFiles(SRC)
  .map((file) => ({ file, text: readFileSync(file, 'utf8') }))
  .filter(({ text }) =>
    [...text.matchAll(NUM_RUNS)].some((match) => digits(match[1]) > MAX_DEFAULT_RUNS),
  );

describe('property test timeouts', () => {
  it('finds the heavy property test files', () => {
    expect(heavy.map(({ file }) => relative(SRC, file).replaceAll('\\', '/')).sort()).toEqual([
      'money/allocate.property.test.ts',
      'money/format.property.test.ts',
      'money/money-forged.test.ts',
      'money/money.property.test.ts',
      'money/parse.property.test.ts',
      'money/rescale.property.test.ts',
      'payouts/legs.test.ts',
    ]);
  });

  it.each(heavy.map(({ file, text }) => [relative(SRC, file), text]))(
    '%s sets an explicit timeout of at least 30 seconds',
    (_file, text) => {
      const constant = TIMEOUT_CONSTANT.exec(text);
      expect(constant, 'declares PROPERTY_TIMEOUT_MS').not.toBeNull();
      expect(digits(constant?.[1])).toBeGreaterThanOrEqual(30_000n);
      expect(DESCRIBE_WITH_TIMEOUT.test(text), 'passes it to a describe block').toBe(true);
    },
  );
});
