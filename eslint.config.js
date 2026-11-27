// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

import { DB_SOURCE_SYNTAX, DB_TEST_SYNTAX, dbFence } from './eslint/db-fence.js';

// A rule set in a later block replaces the same rule from an earlier one.
// no-restricted-syntax is set by the database fence, the chain and demo
// boundaries and the float ban, so every block that sets it lists every
// selector that applies to its files. The lint tests prove each one still
// fires.

const FLOAT_BAN_MESSAGE =
  'Money code works in bigint minor units. Parse amounts with BigInt from a string.';

const FLOAT_BAN_SYNTAX = [
  { selector: "CallExpression[callee.name='Number']", message: FLOAT_BAN_MESSAGE },
  { selector: "NewExpression[callee.name='Number']", message: FLOAT_BAN_MESSAGE },
];

const CHAIN_BOUNDARY =
  'Reach the chain through the adapter in src/chain; only src/chain and src/demo import Stellar libraries.';

const DEMO_BOUNDARY =
  'Product code never depends on the testnet demo; only an entry point composes src/demo.';

const DYNAMIC_STELLAR_IMPORT = {
  selector: 'ImportExpression[source.value=/^@stellar/]',
  message: CHAIN_BOUNDARY,
};
const DYNAMIC_DEMO_IMPORT = {
  // esquery ends a regex at the first slash, so the slashes are written as \x2F.
  selector: 'ImportExpression[source.value=/(^|\\x2F)demo(\\x2F|$)/]',
  message: DEMO_BOUNDARY,
};
const STELLAR_PATTERN = { group: ['@stellar/*', '@stellar/*/**'], message: CHAIN_BOUNDARY };
const DEMO_PATTERN = { regex: '(^|/)demo(/|$)', message: DEMO_BOUNDARY };

// The files that compose the server, and so may build the demo.
const ENTRY_POINTS = ['src/mcp/main.ts', 'src/mcp/http-main.ts', 'src/server/**'];

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
  // The console web app and the embed widget have their own lint setups in
  // console/ and embed/. site/ is the static marketing site, kept as
  // published, with a bundled wallet script. A *.fixture.ts file breaks a
  // rule on purpose; the lint tests lint it explicitly to prove the rule fires.
  {
    ignores: [
      'dist/',
      'coverage/',
      'node_modules/',
      'console/',
      'embed/',
      'site/',
      '**/*.fixture.ts',
    ],
  },
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
  //
  // Nor does product code import the demo, so the demo can be deleted before
  // mainnet as one folder. Only the entry points compose it, behind its flag.
  {
    files: ['src/**/*.ts'],
    ignores: [...CHAIN_FREE_IGNORES, ...ENTRY_POINTS],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        { patterns: [STELLAR_PATTERN, DEMO_PATTERN] },
      ],
      'no-restricted-syntax': [
        'error',
        DYNAMIC_STELLAR_IMPORT,
        DYNAMIC_DEMO_IMPORT,
        ...DB_SOURCE_SYNTAX,
      ],
    },
  },
  {
    files: ENTRY_POINTS,
    rules: {
      '@typescript-eslint/no-restricted-imports': ['error', { patterns: [STELLAR_PATTERN] }],
      'no-restricted-syntax': ['error', DYNAMIC_STELLAR_IMPORT, ...DB_SOURCE_SYNTAX],
    },
  },
  {
    files: ['src/chain/**/*.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': ['error', { patterns: [DEMO_PATTERN] }],
      'no-restricted-syntax': ['error', DYNAMIC_DEMO_IMPORT, ...DB_SOURCE_SYNTAX],
    },
  },
  {
    files: ['src/**/*.test.ts'],
    ignores: CHAIN_FREE_IGNORES,
    rules: {
      'no-restricted-syntax': [
        'error',
        DYNAMIC_STELLAR_IMPORT,
        DYNAMIC_DEMO_IMPORT,
        ...DB_TEST_SYNTAX,
      ],
    },
  },
  {
    // Chain tests may load the Stellar library, but not the demo.
    files: ['src/chain/**/*.test.ts'],
    rules: { 'no-restricted-syntax': ['error', DYNAMIC_DEMO_IMPORT, ...DB_TEST_SYNTAX] },
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
        DYNAMIC_DEMO_IMPORT,
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
        DYNAMIC_DEMO_IMPORT,
        ...DB_TEST_SYNTAX,
      ],
    },
  },
);
