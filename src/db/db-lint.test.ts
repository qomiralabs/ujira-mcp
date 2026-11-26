// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// Proves the database bans are wired into the real ESLint config: the
// driver and the query builder are importable only inside src/db, type
// parsers cannot be changed anywhere, and a session level SET of a tenant
// key is refused in source. Snippets are linted in memory under the paths of
// files that exist, so the scoped configuration applies exactly as it would
// to a committed file, and the type aware rules find each file's program.

import path from 'node:path';

import { ESLint } from 'eslint';
import { beforeAll, describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');
const FIXTURE = path.join(REPO_ROOT, 'src/payouts/db-fence.fixture.ts');
const INSIDE_DB = path.join(REPO_ROOT, 'src/db/database.ts');
const INSIDE_DB_TEST = path.join(REPO_ROOT, 'src/db/tenant.test.ts');
const IN_MCP = path.join(REPO_ROOT, 'src/mcp/server.ts');
const IN_TEST = path.join(REPO_ROOT, 'test/units.test.ts');

const HEADER = ['// SPDX-License-Identifier: Apache-2.0', '// Copyright 2026 Qomira Labs', ''].join(
  '\n',
);

let eslint: ESLint;

beforeAll(() => {
  // ignore: false so the fixture, which a normal run skips, is linted.
  eslint = new ESLint({ cwd: REPO_ROOT, ignore: false });
});

function errorsOf(result: ESLint.LintResult | undefined): string[] {
  if (result === undefined) throw new Error('ESLint returned no result');
  const fatal = result.messages.filter((message) => message.fatal === true);
  expect(fatal.map((message) => message.message)).toEqual([]);
  return result.messages
    .filter((message) => message.severity === 2 && message.ruleId !== null)
    .map((message) => `${String(message.ruleId)}: ${message.message}`);
}

async function errorsFor(code: string, filePath: string): Promise<string[]> {
  const [result] = await eslint.lintText(HEADER + code, { filePath });
  return errorsOf(result);
}

const restrictedImports = (errors: string[]): string[] =>
  errors.filter((error) => error.startsWith('no-restricted-imports'));

describe('the driver fence', () => {
  it('refuses the committed fixture that imports pg from src/payouts', async () => {
    const [result] = await eslint.lintFiles([FIXTURE]);
    expect(restrictedImports(errorsOf(result))).toEqual([
      "no-restricted-imports: 'pg' import is restricted from being used. The Postgres driver loads only in src/db. Use the repository layer it exports.",
    ]);
  });

  it('leaves the fixture out of a normal lint run', async () => {
    const normal = new ESLint({ cwd: REPO_ROOT });
    expect(await normal.isPathIgnored(FIXTURE)).toBe(true);
  });

  it.each([
    ["import pg from 'pg';\nexport const client = pg.Client;\n", 'pg'],
    ["import { Pool } from 'pg';\nexport const pool = Pool;\n", 'pg named'],
    ["import { Kysely } from 'kysely';\nexport const k = Kysely;\n", 'kysely'],
    ["import { runner } from 'node-pg-migrate';\nexport const m = runner;\n", 'node-pg-migrate'],
    [
      "import { PostgreSqlContainer } from '@testcontainers/postgresql';\nexport const c = PostgreSqlContainer;\n",
      'the test container',
    ],
    ["export type { Schema } from '../db/schema.js';\n", 'db internals'],
    ["export { createDatabase } from '../db/database.js';\n", 'a db module that is not the entry'],
  ])('fails outside src/db for %s', async (code) => {
    expect(restrictedImports(await errorsFor(code, IN_MCP))).not.toHaveLength(0);
  });

  it('fails in a test outside src/db as well, since a test can leak a connection too', async () => {
    const errors = await errorsFor("import pg from 'pg';\nexport const c = pg.Client;\n", IN_TEST);
    expect(restrictedImports(errors)).not.toHaveLength(0);
  });

  it('passes inside src/db', async () => {
    const errors = await errorsFor(
      "import pg from 'pg';\nimport { Kysely } from 'kysely';\nexport const both = [pg.Client, Kysely];\n",
      INSIDE_DB,
    );
    expect(restrictedImports(errors)).toEqual([]);
  });

  it('allows the entry of the module and of its test harness', async () => {
    const errors = await errorsFor(
      "export type { TenantContext } from '../db/index.js';\nexport { createTestDatabase } from '../db/testing/index.js';\n",
      IN_MCP,
    );
    expect(restrictedImports(errors)).toEqual([]);
  });
});

describe('no-set-type-parser', () => {
  const typeParser = (errors: string[]): string[] =>
    errors.filter((error) => error.includes('Type parsers stay as pg ships them'));

  it.each([
    ["import pg from 'pg';\npg.types.setTypeParser(1082, String);\n", 'through types'],
    [
      'declare const pool: { setTypeParser: (id: number) => void };\npool.setTypeParser(1082);\n',
      'on any object',
    ],
  ])('fails inside src/db for %s', async (code) => {
    expect(typeParser(await errorsFor(code, INSIDE_DB))).not.toHaveLength(0);
  });

  it('fails outside src/db and in tests, because the ban is repository wide', async () => {
    const code =
      'declare const types: { setTypeParser: (id: number) => void };\ntypes.setTypeParser(1082);\n';
    expect(typeParser(await errorsFor(code, IN_MCP))).not.toHaveLength(0);
    expect(typeParser(await errorsFor(code, INSIDE_DB_TEST))).not.toHaveLength(0);
  });

  it('leaves an unrelated call alone', async () => {
    const errors = await errorsFor(
      'declare const parser: { setTypeName: (id: number) => void };\nparser.setTypeName(1082);\n',
      INSIDE_DB,
    );
    expect(typeParser(errors)).toEqual([]);
  });
});

describe('no-session-set-of-tenant-keys', () => {
  const syntax = (errors: string[]): string[] =>
    errors.filter((error) => error.startsWith('no-restricted-syntax'));

  it.each([
    ['export const sql = "set ujira.principal_id = \'p\'";\n', 'a set in a string'],
    ['export const sql = `set ujira.scope = ${String(1)}`;\n', 'a set in a template'],
    ["export const sql = 'reset ujira.principal_id';\n", 'a reset'],
    [
      'export const sql = "select set_config(\'ujira.principal_id\', $1, false)";\n',
      'a session scoped set_config',
    ],
  ])('fails in source for %s', async (code) => {
    expect(syntax(await errorsFor(code, INSIDE_DB))).not.toHaveLength(0);
    expect(syntax(await errorsFor(code, IN_MCP))).not.toHaveLength(0);
  });

  it('allows the transaction local form', async () => {
    const errors = await errorsFor(
      'export const sql = "select set_config(\'ujira.principal_id\', $1, true)";\n',
      INSIDE_DB,
    );
    expect(syntax(errors)).toEqual([]);
  });

  it('exempts tests, which write these statements to prove they are refused', async () => {
    const errors = await errorsFor(
      'export const sql = "set ujira.principal_id = \'p\'";\n',
      INSIDE_DB_TEST,
    );
    expect(syntax(errors)).toEqual([]);
  });
});

// The chain boundary and the float ban set no-restricted-syntax after this
// fence, for src and for the money folders. These fail if either entry stops
// carrying the fence's selectors, or the fence's own selectors push theirs out.
describe('alongside the float ban and the chain boundary', () => {
  const IN_PAYOUTS = path.join(REPO_ROOT, 'src/payouts/status.ts');
  const IN_PAYOUTS_TEST = path.join(REPO_ROOT, 'src/payouts/status.test.ts');
  const IN_CHAIN = path.join(REPO_ROOT, 'src/chain/stellar/adapter.ts');
  const IN_SRC_TEST = path.join(REPO_ROOT, 'src/rails/sdp.test.ts');
  const messages = (errors: string[]): string => errors.join('\n');

  it('still refuses the db bans in src/chain, which the chain boundary skips', async () => {
    const set = 'export const sql = "set ujira.principal_id = \'p\'";\n';
    const parser =
      'declare const types: { setTypeParser: (id: number) => void };\ntypes.setTypeParser(1082);\n';
    expect(messages(await errorsFor(set, IN_CHAIN))).toMatch(/transaction local/);
    expect(messages(await errorsFor(parser, IN_CHAIN))).toMatch(/Type parsers stay/);
  });

  it('still refuses a type parser change in a src test outside the money folders', async () => {
    const code =
      'declare const types: { setTypeParser: (id: number) => void };\ntypes.setTypeParser(1082);\n';
    expect(messages(await errorsFor(code, IN_SRC_TEST))).toMatch(/Type parsers stay/);
    const set = 'export const sql = "set ujira.principal_id = \'p\'";\n';
    expect(messages(await errorsFor(set, IN_SRC_TEST))).not.toMatch(/transaction local/);
  });

  it('keeps the dynamic Stellar import ban in src/db and in money tests', async () => {
    const code = "export const sdk = import('@stellar/stellar-sdk');\n";
    for (const file of [INSIDE_DB, INSIDE_DB_TEST, IN_PAYOUTS_TEST, IN_SRC_TEST]) {
      expect(messages(await errorsFor(code, file)), file).toMatch(/through the adapter/);
    }
  });

  it('still refuses a session level SET of a tenant key in source', async () => {
    const code = 'export const sql = "set ujira.principal_id = \'p\'";\n';
    expect(messages(await errorsFor(code, IN_PAYOUTS))).toMatch(/transaction local/);
    expect(messages(await errorsFor(code, INSIDE_DB))).toMatch(/transaction local/);
  });

  it('still refuses a type parser change in source and in tests', async () => {
    const code =
      'declare const types: { setTypeParser: (id: number) => void };\ntypes.setTypeParser(1082);\n';
    for (const file of [IN_PAYOUTS, IN_PAYOUTS_TEST, INSIDE_DB, INSIDE_DB_TEST]) {
      expect(messages(await errorsFor(code, file)), file).toMatch(/Type parsers stay/);
    }
  });

  it('keeps the float ban in the same files', async () => {
    const code = "export const x = Number('15');\n";
    for (const file of [IN_PAYOUTS, IN_PAYOUTS_TEST, INSIDE_DB, INSIDE_DB_TEST]) {
      expect(messages(await errorsFor(code, file)), file).toMatch(/bigint minor units/);
    }
  });

  it('still exempts tests from the tenant SET ban', async () => {
    const code = 'export const sql = "set ujira.principal_id = \'p\'";\n';
    expect(messages(await errorsFor(code, IN_PAYOUTS_TEST))).not.toMatch(/transaction local/);
  });
});
