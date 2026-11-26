// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The database fence. The driver, the query builder and the migration tool
// load only in src/db, so every query runs through its repository layer,
// under a tenant context, inside one transaction; an import elsewhere would
// be a query with no context on a pooled connection, and would tie code
// outside src/db to this store.
//
// A later flat config entry replaces a rule for the files it matches rather
// than adding to it. Another fence that sets no-restricted-imports for the
// same files must therefore spread DB_RESTRICTED_PATHS and
// DB_RESTRICTED_PATTERNS into its own entry, or it switches this one off.
// The same holds for no-restricted-syntax and DB_SOURCE_SYNTAX or
// DB_TEST_SYNTAX. src/db/db-lint.test.ts fails if that happens.

const DRIVER_MESSAGE =
  'The Postgres driver loads only in src/db. Use the repository layer it exports.';

export const DB_RESTRICTED_PATHS = [
  { name: 'pg', message: DRIVER_MESSAGE },
  { name: 'pg-pool', message: DRIVER_MESSAGE },
  {
    name: 'kysely',
    message: 'The query builder loads only in src/db. Use the repository layer it exports.',
  },
  {
    name: 'node-pg-migrate',
    message: 'Migrations run from src/db, which owns the migration tool.',
  },
  {
    name: '@testcontainers/postgresql',
    message: 'Test databases come from src/db/testing/index.js, which owns the container.',
  },
];

export const DB_RESTRICTED_PATTERNS = [
  { group: ['pg/*', 'kysely/*'], message: DRIVER_MESSAGE },
  {
    // Anything under a db folder but its two entries: the module itself, and
    // the test harness other tests use.
    regex: String.raw`(?:^|/)db/(?!index\.js$|testing/index\.js$)`,
    message: 'Import src/db through its entry, index.js, or testing/index.js in a test.',
  },
];

const TYPE_PARSER_MESSAGE =
  'Type parsers stay as pg ships them: changing one changes every value of that type in the process.';

const TYPE_PARSER_SELECTORS = [
  {
    selector: "CallExpression[callee.property.name='setTypeParser']",
    message: TYPE_PARSER_MESSAGE,
  },
  { selector: "CallExpression[callee.name='setTypeParser']", message: TYPE_PARSER_MESSAGE },
];

// Tenant context is transaction local. A session level SET of a tenant key
// reaches the next client on a pooled backend.
const TENANT_SESSION_MESSAGE =
  'Tenant context is transaction local: send it with set_config(key, value, true), never a session level SET.';

const TENANT_SESSION_SELECTORS = [
  {
    selector: String.raw`Literal[value=/(?:^|[^a-z_])(?:set|reset)\s+(?:session\s+)?ujira\./i]`,
    message: TENANT_SESSION_MESSAGE,
  },
  {
    selector: String.raw`TemplateElement[value.raw=/(?:^|[^a-z_])(?:set|reset)\s+(?:session\s+)?ujira\./i]`,
    message: TENANT_SESSION_MESSAGE,
  },
  {
    selector: String.raw`Literal[value=/set_config\s*\([^)]*,\s*(?:false|'f')\s*\)/i]`,
    message:
      'set_config with a false third argument is session level and reaches the next client on a pooled connection.',
  },
];

// Exported for the same reason as the import lists: an entry after this one
// that sets no-restricted-syntax must carry these too.
export const DB_SOURCE_SYNTAX = [...TYPE_PARSER_SELECTORS, ...TENANT_SESSION_SELECTORS];
export const DB_TEST_SYNTAX = [...TYPE_PARSER_SELECTORS];

const TS_FILES = ['**/*.ts'];
const TESTS = ['**/*.test.ts'];

export const dbFence = [
  {
    files: TS_FILES,
    ignores: ['src/db/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        { paths: DB_RESTRICTED_PATHS, patterns: DB_RESTRICTED_PATTERNS },
      ],
    },
  },
  {
    // Everywhere, src/db included: the type parser ban is repository wide.
    files: TS_FILES,
    ignores: TESTS,
    rules: { 'no-restricted-syntax': ['error', ...DB_SOURCE_SYNTAX] },
  },
  {
    // Tests write the statements the bans refuse in order to prove they are
    // refused, so only the type parser ban applies to them.
    files: TESTS,
    rules: { 'no-restricted-syntax': ['error', ...DB_TEST_SYNTAX] },
  },
];
