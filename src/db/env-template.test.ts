// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// db/.env.example is the only documentation an operator reads before the
// first deploy, and a document that describes configuration drifts the moment
// the configuration moves. These tests tie it to the code in four directions:
// a variable the module reads and the file omits, a variable the file lists
// and nothing reads, a default printed in the file that no longer matches
// the one the loader applies, and placeholder values that no longer form a
// configuration the loader accepts.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  DATABASE_ENVIRONMENT_KEYS,
  loadDatabaseConfig,
  type DatabaseConfig,
  type DatabaseEnvironment,
} from './config.js';
import { DatabaseConfigError } from './errors.js';

const TEMPLATE_PATH = fileURLToPath(new URL('../../db/.env.example', import.meta.url));

interface TemplateEntry {
  readonly key: string;
  readonly value: string;
  // True for a `# default: NAME=value` line, which documents a default the
  // module supplies; false for a plain `NAME=value` line, which is a
  // variable with no default and therefore required.
  readonly isDefault: boolean;
}

// Only these two line shapes carry a variable. Prose comments have no `=`
// at the start of a word, so they are skipped rather than guessed at.
const ENTRY_LINE = /^(?<prefix># default: )?(?<key>[A-Z][A-Z0-9_]*)=(?<value>.*)$/;

function readTemplate(): readonly TemplateEntry[] {
  const lines = readFileSync(TEMPLATE_PATH, 'utf8').split('\n');
  const entries: TemplateEntry[] = [];
  for (const line of lines) {
    const match = ENTRY_LINE.exec(line);
    if (match?.groups === undefined) continue;
    const { prefix, key, value } = match.groups;
    if (key === undefined || value === undefined) continue;
    entries.push({ key, value, isDefault: prefix !== undefined });
  }
  return entries;
}

const ENTRIES = readTemplate();
const REQUIRED = ENTRIES.filter((entry) => !entry.isDefault);
const OPTIONAL = ENTRIES.filter((entry) => entry.isDefault);

// The environment an operator would have after filling in the required
// lines and leaving every default alone.
function templateEnvironment(): DatabaseEnvironment {
  return Object.fromEntries(REQUIRED.map((entry) => [entry.key, entry.value]));
}

// A value no variable accepts, so a variable the loader ignores shows up as
// a configuration that loaded when it should have failed.
function rejectableValue(key: string): string {
  if (key.endsWith('_URL')) return 'not a url';
  if (key === 'UJIRA_DB_TLS') return 'maybe';
  return 'none';
}

// What the loader actually applied, for each variable that documents a
// default. Every optional variable needs a reader here, so a new one cannot
// be added to the template without saying where its value lands.
const DEFAULT_READERS: Readonly<Record<string, (config: DatabaseConfig) => string>> = {
  UJIRA_DB_TLS: (config) => config.tls,
  // Empty in the file because the default is a fallback, not a value.
  UJIRA_DB_READER_URL: (config) =>
    config.reader.url.reveal() === config.app.url.reveal() ? '' : config.reader.url.reveal(),
  UJIRA_DB_POOL_SIZE: (config) => {
    expect(config.worker.poolSize).toBe(config.app.poolSize);
    return String(config.app.poolSize);
  },
  UJIRA_DB_ACQUIRE_TIMEOUT_MS: (config) => String(config.acquireTimeoutMs),
  UJIRA_DB_STATEMENT_TIMEOUT_MS: (config) => String(config.statementTimeoutMs),
  UJIRA_DB_LOCK_TIMEOUT_MS: (config) => String(config.lockTimeoutMs),
};

describe('.env.example', () => {
  it('was parsed, so an unreadable or reshaped file cannot pass silently', () => {
    expect(ENTRIES.map((entry) => entry.key)).toHaveLength(9);
    expect(REQUIRED).toHaveLength(3);
    expect(OPTIONAL).toHaveLength(6);
  });

  it('lists every variable the module reads', () => {
    const listed = new Set(ENTRIES.map((entry) => entry.key));
    const missing = DATABASE_ENVIRONMENT_KEYS.filter((key) => !listed.has(key));
    expect(missing, 'variables the module reads and .env.example does not document').toEqual([]);
  });

  it('lists no variable the module does not read', () => {
    const known: ReadonlySet<string> = new Set<string>(DATABASE_ENVIRONMENT_KEYS);
    const extra = ENTRIES.map((entry) => entry.key).filter((key) => !known.has(key));
    expect(extra, 'variables documented in .env.example that the module never reads').toEqual([]);
  });

  it.each(ENTRIES.map((entry) => entry.key))('is read by the loader: %s', (key) => {
    // Not the same claim as being named in the key list: this one fails if
    // the variable is documented, declared, and then never consulted.
    expect(() =>
      loadDatabaseConfig({ ...templateEnvironment(), [key]: rejectableValue(key) }),
    ).toThrow(new RegExp(key));
  });

  it.each(REQUIRED.map((entry) => entry.key))('is required, as the file implies: %s', (key) => {
    const env = Object.fromEntries(
      Object.entries(templateEnvironment()).filter(([name]) => name !== key),
    ) as DatabaseEnvironment;
    expect(() => loadDatabaseConfig(env)).toThrow(DatabaseConfigError);
  });

  it.each(OPTIONAL.map((entry) => [entry.key, entry.value]))(
    'prints the default the loader applies: %s',
    (key, value) => {
      const reader = DEFAULT_READERS[key];
      if (reader === undefined) {
        throw new Error(
          `${key} documents a default but no reader in this test knows where it goes`,
        );
      }
      expect(reader(loadDatabaseConfig(templateEnvironment()))).toBe(value);
    },
  );

  it('holds placeholder values that form a configuration the loader accepts', () => {
    const config = loadDatabaseConfig(templateEnvironment());
    expect(config.tls).toBe('pinned');
    expect(config.worker.url.reveal()).toContain(':5432/');
    expect(config.migration.url.reveal()).toContain(':5432/');
  });

  it('carries no password, only a placeholder', () => {
    const contents = readFileSync(TEMPLATE_PATH, 'utf8');
    for (const entry of REQUIRED) {
      expect(entry.value).toContain('REPLACE_ME');
    }
    expect(contents).not.toMatch(/REPLACE_ME[^@\s]/);
  });
});
