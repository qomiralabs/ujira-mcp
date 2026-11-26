// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// Proves the lint rule that keeps the Stellar library inside src/chain and
// src/demo. The repository's own ESLint config decides which rules apply at
// a path; the fixture, which breaks the rule three ways, is then linted with
// exactly those rules. Type aware rules are left out, since they need the
// file on disk and say nothing about imports.

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ESLint, type Linter } from 'eslint';
import tseslint from 'typescript-eslint';
import { describe, expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixture = readFileSync(join(root, 'test/fixtures/lint/stellar-sdk-import.ts'), 'utf8');
const BOUNDARY_RULES = ['@typescript-eslint/no-restricted-imports', 'no-restricted-syntax'];

/** The boundary rules the real config turns on for a file at `path`. */
async function boundaryRulesAt(path: string): Promise<Linter.RulesRecord> {
  const config = (await new ESLint({ cwd: root }).calculateConfigForFile(join(root, path))) as {
    rules?: Linter.RulesRecord;
  };
  const rules: Linter.RulesRecord = {};
  for (const name of BOUNDARY_RULES) {
    const setting = config.rules?.[name];
    if (setting !== undefined) rules[name] = setting;
  }
  return rules;
}

async function boundaryErrors(path: string): Promise<string[]> {
  const eslint = new ESLint({
    cwd: root,
    overrideConfigFile: true,
    overrideConfig: {
      files: ['**/*.ts'],
      languageOptions: { parser: tseslint.parser },
      plugins: { '@typescript-eslint': tseslint.plugin },
      rules: await boundaryRulesAt(path),
    },
  });
  const [result] = await eslint.lintText(fixture, { filePath: join(root, path) });
  return (result?.messages ?? []).map((m) => `${String(m.line)}:${m.ruleId ?? m.message}`);
}

describe('the chain boundary lint rule', () => {
  it('refuses Stellar imports, type imports and dynamic imports in product code', async () => {
    for (const path of ['src/payouts/fixture.ts', 'src/engine/fixture.ts', 'src/fixture.ts']) {
      expect(await boundaryErrors(path), path).toEqual([
        '8:@typescript-eslint/no-restricted-imports',
        '9:@typescript-eslint/no-restricted-imports',
        '15:no-restricted-syntax',
      ]);
    }
  }, 120_000);

  it('allows them in src/chain, src/demo and the tests', async () => {
    for (const path of [
      'src/chain/stellar/fixture.ts',
      'src/demo/fixture.ts',
      'test/fixtures/lint/stellar-sdk-import.ts',
    ]) {
      expect(await boundaryErrors(path), path).toEqual([]);
    }
  }, 120_000);
});
