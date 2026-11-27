// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The database spike, run against a migrated test database as the real
// service roles. A plain Postgres has no pooler, so this checks that every
// measurement runs and reports, not what a pooler does; the hosted numbers
// are in docs/spikes/render-postgres.md.

import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { runSpike } from './spike-cli.js';
import { createTestDatabase, roleUrl, type TestDatabase } from './testing/harness.js';

const adminUrl = inject('dbAdminUrl');
const roleUrls = inject('dbRoleUrls');

let database: TestDatabase;

beforeAll(async () => {
  database = await createTestDatabase(adminUrl, import.meta.url);
});

afterAll(async () => {
  await database.drop();
});

describe('runSpike', () => {
  it('measures every path, the tenant transaction and LISTEN, and prints no credential', async () => {
    const lines: string[] = [];
    const errors: string[] = [];
    const env = {
      UJIRA_DB_APP_URL: roleUrl(roleUrls, 'ujira_app', database.name),
      UJIRA_DB_WORKER_URL: roleUrl(roleUrls, 'ujira_worker', database.name),
      UJIRA_DB_MIGRATOR_URL: database.url,
      UJIRA_DB_TLS: 'off',
      UJIRA_DB_POOL_SIZE: '2',
    };
    const result = await runSpike(env, 5, {
      out: (line) => lines.push(line),
      err: (line) => errors.push(line),
    });
    expect(errors).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.tenantAppP50Ms).not.toBeNull();
    const printed = lines.join('\n');
    for (const role of ['app', 'worker', 'migration']) {
      expect(printed).toMatch(new RegExp(`spike: path ${role} port=\\d+ login=\\w+ `));
    }
    expect(printed).toContain('login=ujira_app');
    expect(printed).toContain('login=ujira_worker');
    expect(printed).toMatch(/spike: tenant app port=\d+ p50=/);
    expect(printed).toMatch(/spike: tenant worker port=\d+ p50=/);
    expect(printed).toMatch(/spike: listen worker port=\d+ delivered=true in /);
    expect(printed).toMatch(/spike: verdict tenant p50 /);
    for (const url of Object.values(env).filter((value) => value.startsWith('postgresql://'))) {
      const parsed = new URL(url);
      expect(printed).not.toContain(decodeURIComponent(parsed.password));
      expect(printed).not.toContain(parsed.host);
    }
  });
});
