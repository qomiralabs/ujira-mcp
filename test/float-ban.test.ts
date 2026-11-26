// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// Proves the float ban is wired into the real ESLint config, for the folders
// that handle money and only there. Snippets are linted in memory under real
// file paths, so the scoped config and the type aware parser both apply.

import path from 'node:path';

import { ESLint } from 'eslint';
import { beforeAll, describe, expect, it } from 'vitest';

const ROOT = path.resolve(import.meta.dirname, '..');

const SCOPED_DIRS = ['src/money', 'src/payouts', 'src/receipts', 'src/api', 'src/db'];

// Files that exist today, so the type aware parser can open them. One per
// scoped folder that has code, plus the old money entry point.
const SCOPED_FILES = ['src/money.ts', 'src/payouts/status.ts', 'src/receipts/log.ts'];
const OUTSIDE_FILE = 'src/console/app.ts';

const BAN_RULES = new Set([
  'no-restricted-globals',
  'no-restricted-properties',
  'no-restricted-syntax',
]);

const BANNED: [string, string][] = [
  ['parseFloat', "export const x = parseFloat('1.5');\n"],
  ['Number.parseFloat', "export const x = Number.parseFloat('1.5');\n"],
  ['globalThis.parseFloat', "export const x = globalThis.parseFloat('1.5');\n"],
  ['a Number call', "export const x = Number('15');\n"],
  ['new Number', "export const x: unknown = new Number('15');\n"],
  ['Math.round', 'export const x = Math.round(1.5);\n'],
  ['computed Math.round', "export const x = Math['round'](1.5);\n"],
  ['parseFloat passed as a value', "export const xs = ['1'].map(parseFloat);\n"],
];

const ALLOWED: [string, string][] = [
  ['BigInt of a string', "export const x = BigInt('15');\n"],
  ['Number.isSafeInteger', 'export const ok = (n: number): boolean => Number.isSafeInteger(n);\n'],
  ['Math.max', 'export const x = Math.max(1, 2);\n'],
];

let eslint: ESLint;

beforeAll(() => {
  eslint = new ESLint({ cwd: ROOT });
});

async function banErrors(code: string, file: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath: path.join(ROOT, file) });
  if (result === undefined) throw new Error('ESLint returned no result');
  // A parse failure is also an error and must never count as the ban firing.
  expect(result.messages.filter((m) => m.fatal === true)).toEqual([]);
  return result.messages
    .filter((m) => m.severity === 2 && m.ruleId !== null && BAN_RULES.has(m.ruleId))
    .map((m) => m.message);
}

describe('the float ban', { timeout: 120_000 }, () => {
  it.each(SCOPED_DIRS)('is configured for %s', async (dir) => {
    const config = (await eslint.calculateConfigForFile(path.join(ROOT, dir, 'any.ts'))) as {
      rules: Record<string, unknown>;
    };
    for (const rule of BAN_RULES) {
      expect(config.rules[rule], rule).toEqual(expect.arrayContaining([2]));
    }
  });

  for (const file of SCOPED_FILES) {
    it.each(BANNED)(`refuses %s in ${file}`, async (_name, code) => {
      const errors = await banErrors(code, file);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.join('\n')).toMatch(/bigint minor units/);
    });

    it.each(ALLOWED)(`allows %s in ${file}`, async (_name, code) => {
      expect(await banErrors(code, file)).toEqual([]);
    });
  }

  it.each(BANNED)(`leaves %s alone outside the money folders`, async (_name, code) => {
    expect(await banErrors(code, OUTSIDE_FILE)).toEqual([]);
  });
});
