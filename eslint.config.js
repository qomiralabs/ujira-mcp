// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

import { DB_SOURCE_SYNTAX, DB_TEST_SYNTAX, dbFence } from './eslint/db-fence.js';

// A rule set in a later block replaces the same rule from an earlier one.
// no-restricted-syntax is set by the database fence, the chain boundary and
// the float ban, so every block that sets it lists every selector that
// applies to its files. The lint tests prove each one still fires.

const FLOAT_BAN_MESSAGE =
  'Money code works in bigint minor units. Parse amounts with BigInt from a string.';

const FLOAT_BAN_SYNTAX = [
  { selector: "CallExpression[callee.name='Number']", message: FLOAT_BAN_MESSAGE },
  { selector: "NewExpression[callee.name='Number']", message: FLOAT_BAN_MESSAGE },
];

const CHAIN_BOUNDARY =
  'Reach the chain through the adapter in src/chain; only src/chain and src/demo import Stellar libraries.';

const DYNAMIC_STELLAR_IMPORT = {
  selector: 'ImportExpression[source.value=/^@stellar/]',
  message: CHAIN_BOUNDARY,
};

const CHAIN_FREE_IGNORES = ['src/chain/**', 'src/demo/**'];

const MONEY_FILES = [
  'src/money.ts',
  'src/money/**/*.ts',
  'src/payouts/**/*.ts',
  'src/receipts/**/*.ts',
  'src/api/**/*.ts',
  'src/db/**/*.ts',
];
const MONEY_TESTS = [
  'src/money/**/*.test.ts',
  'src/payouts/**/*.test.ts',
  'src/receipts/**/*.test.ts',
  'src/api/**/*.test.ts',
  'src/db/**/*.test.ts',
];

export default defineConfig(
  // The console web app has its own lint setup in console/. site/ is the
  // static marketing site, kept as published, with a bundled wallet script.
  // A *.fixture.ts file breaks a rule on purpose; the lint tests lint it
  // explicitly to prove the rule fires.
  { ignores: ['dist/', 'coverage/', 'node_modules/', 'console/', 'site/', '**/*.fixture.ts'] },
  js.configs.recommended,
  {
    files: ['**/*.ts'],
    extends: [tseslint.configs.strictTypeChecked],
    languageOptions: {
      globals: globals.node,
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
    },
  },
  {
    files: ['**/*.js'],
    languageOptions: { globals: globals.node },
  },
  ...dbFence,
  // Product code reaches Stellar only through the chain adapter, so the rules
  // that move money never depend on one chain library. The testnet demo may
  // use the library directly. Tests and examples play the wallet and the
  // network, so they may too.
  {
    files: ['src/**/*.ts'],
    ignores: CHAIN_FREE_IGNORES,
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        { patterns: [{ group: ['@stellar/*', '@stellar/*/**'], message: CHAIN_BOUNDARY }] },
      ],
      'no-restricted-syntax': ['error', DYNAMIC_STELLAR_IMPORT, ...DB_SOURCE_SYNTAX],
    },
  },
  {
    files: ['src/**/*.test.ts'],
    ignores: CHAIN_FREE_IGNORES,
    rules: { 'no-restricted-syntax': ['error', DYNAMIC_STELLAR_IMPORT, ...DB_TEST_SYNTAX] },
  },
  // Amounts are bigint minor units. These are the usual ways a float gets
  // into money code, so the folders that carry amounts refuse them outright.
  // Number.isSafeInteger and friends stay allowed: they check, not convert.
  {
    files: MONEY_FILES,
    rules: {
      'no-restricted-globals': ['error', { name: 'parseFloat', message: FLOAT_BAN_MESSAGE }],
      'no-restricted-properties': [
        'error',
        { object: 'Number', property: 'parseFloat', message: FLOAT_BAN_MESSAGE },
        { object: 'globalThis', property: 'parseFloat', message: FLOAT_BAN_MESSAGE },
        { object: 'Math', property: 'round', message: FLOAT_BAN_MESSAGE },
      ],
      'no-restricted-syntax': [
        'error',
        ...FLOAT_BAN_SYNTAX,
        DYNAMIC_STELLAR_IMPORT,
        ...DB_SOURCE_SYNTAX,
      ],
    },
  },
  {
    files: MONEY_TESTS,
    rules: {
      'no-restricted-syntax': [
        'error',
        ...FLOAT_BAN_SYNTAX,
        DYNAMIC_STELLAR_IMPORT,
        ...DB_TEST_SYNTAX,
      ],
    },
  },
);
