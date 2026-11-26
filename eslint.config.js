// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const FLOAT_BAN_MESSAGE =
  'Money code works in bigint minor units. Parse amounts with BigInt from a string.';

export default defineConfig(
  // The console web app has its own lint setup in console/. site/ is the
  // static marketing site, kept as published, with a bundled wallet script.
  { ignores: ['dist/', 'coverage/', 'node_modules/', 'console/', 'site/'] },
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
  // Amounts are bigint minor units. These are the usual ways a float gets
  // into money code, so the folders that carry amounts refuse them outright.
  // Number.isSafeInteger and friends stay allowed: they check, not convert.
  {
    files: [
      'src/money.ts',
      'src/money/**/*.ts',
      'src/payouts/**/*.ts',
      'src/receipts/**/*.ts',
      'src/api/**/*.ts',
      'src/db/**/*.ts',
    ],
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
        { selector: "CallExpression[callee.name='Number']", message: FLOAT_BAN_MESSAGE },
        { selector: "NewExpression[callee.name='Number']", message: FLOAT_BAN_MESSAGE },
      ],
    },
  },
);
