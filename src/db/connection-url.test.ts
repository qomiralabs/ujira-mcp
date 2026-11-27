// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// A deployment's database URLs carry real passwords, so the loaded
// configuration must not print them by any route a failure or a log takes:
// the runner's serialiser, JSON, string conversion, inspect, or a walk of
// every own property such as that serialiser does.

import { inspect } from 'node:util';

import { beforeAll, describe, expect, it } from 'vitest';

import { loadDatabaseConfig, type DatabaseEnvironment } from './config.js';
import { CONNECTION_URL_PLACEHOLDER, ConnectionUrl } from './connection-url.js';
import { loadRunnerSerialiser, type Serialise } from './testing/runner-serialiser.js';

const PROBE = ['deploy', 'probe', String(process.pid)].join('-');

function urlFor(role: string, port: number): string {
  const url = new URL(`postgresql://${role}@pooler.example:${String(port)}/postgres`);
  url.password = PROBE;
  return url.toString();
}

const ENV: DatabaseEnvironment = {
  UJIRA_DB_APP_URL: urlFor('app', 6543),
  UJIRA_DB_WORKER_URL: urlFor('worker', 5432),
  UJIRA_DB_READER_URL: urlFor('reader', 6543),
  UJIRA_DB_MIGRATOR_URL: urlFor('migrator', 5432),
};

// Every string reachable by reading own property names up each prototype
// chain, non-enumerable ones included, which is the walk the runner does.
// Methods are not called: a walk reads, it does not invoke.
function reachableStrings(value: unknown, seen = new Set<object>()): string[] {
  if (typeof value === 'string') return [value];
  if (value === null || typeof value !== 'object') return [];
  if (seen.has(value)) return [];
  seen.add(value);
  const found: string[] = [];
  for (
    let level: object | null = value;
    level !== null && level !== Object.prototype;
    level = Object.getPrototypeOf(level) as object | null
  ) {
    for (const key of Object.getOwnPropertyNames(level)) {
      let read: unknown;
      try {
        read = (value as Record<string, unknown>)[key];
      } catch {
        continue;
      }
      found.push(...reachableStrings(read, seen));
    }
  }
  return found;
}

let serialise: Serialise;

beforeAll(async () => {
  serialise = await loadRunnerSerialiser();
});

describe('ConnectionUrl', () => {
  it('hands the value to whoever reveals it', () => {
    expect(new ConnectionUrl(ENV.UJIRA_DB_APP_URL ?? '').reveal()).toBe(ENV.UJIRA_DB_APP_URL);
  });

  it('answers a placeholder to JSON, string conversion and inspect', () => {
    const held = new ConnectionUrl(PROBE);
    expect(JSON.stringify({ held })).toBe(`{"held":${JSON.stringify(CONNECTION_URL_PLACEHOLDER)}}`);
    expect(String(held)).toBe(CONNECTION_URL_PLACEHOLDER);
    expect(inspect(held, { showHidden: true, depth: null })).not.toContain(PROBE);
  });

  it('is out of reach of an own property walk', () => {
    expect(reachableStrings(new ConnectionUrl(PROBE))).not.toContain(PROBE);
  });

  it('cannot be given another value after it is made', () => {
    const held = new ConnectionUrl(PROBE);
    expect(Object.isFrozen(held)).toBe(true);
  });
});

describe('the loaded database configuration', () => {
  it('needs two failures to print a password: no walk reaches it, and toJSON hides it', () => {
    const config = loadDatabaseConfig(ENV);
    expect(reachableStrings(config).join('\n')).not.toContain(PROBE);
    expect(JSON.stringify(config)).not.toContain(PROBE);
    expect(JSON.stringify(config.app)).toContain(JSON.stringify(CONNECTION_URL_PLACEHOLDER));
  });

  it('prints no password when a failing test throws an error carrying it', () => {
    const config = loadDatabaseConfig(ENV);
    const error = Object.assign(new Error('could not connect'), { config, role: config.app });
    const printed = JSON.stringify(serialise(error));
    expect(printed).toContain('could not connect');
    expect(printed).not.toContain(PROBE);
  });

  it('still gives the driver the URL it was configured with', () => {
    const config = loadDatabaseConfig(ENV);
    expect(config.app.url.reveal()).toBe(ENV.UJIRA_DB_APP_URL);
    expect(config.migration.url.reveal()).toBe(ENV.UJIRA_DB_MIGRATOR_URL);
  });
});
