// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// Starting the container and migrating the template. This is the only part
// of the harness that runs in the vitest global setup, in the main process,
// where the workers' coverage instrumentation cannot see it. It lives in its
// own file so the rest of the harness, which runs in the workers and is
// measured, is not excluded along with it.

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';

import { HARNESS_ADMIN_PASSWORD, harnessPassword } from './credentials.js';
import {
  LOGIN_ROLES,
  PLATFORM_ROLES,
  TEMPLATE_DATABASE,
  quoteIdentifier,
  withDatabase,
} from './harness.js';
import { POSTGRES_IMAGE } from './image.js';

export interface StartedHarness {
  readonly adminUrl: string;
  // A login URL per role, pointing at the server's default database.
  readonly roleUrls: Readonly<Record<string, string>>;
  readonly stop: () => Promise<void>;
}

function adminUrlOf(container: StartedPostgreSqlContainer, database: string): string {
  const url = new URL('postgresql://host/db');
  url.hostname = container.getHost();
  url.port = String(container.getMappedPort(5432));
  url.username = container.getUsername();
  url.password = HARNESS_ADMIN_PASSWORD;
  url.pathname = `/${database}`;
  return url.toString();
}

async function withClient<T>(url: string, work: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

// Starts the container and builds the template. Called once per run.
export async function startHarness(
  migrate: (url: string) => Promise<void>,
): Promise<StartedHarness> {
  // Password authentication stays on, with a fixed value from credentials.ts
  // rather than trust authentication, so the test path logs in the way a
  // deployment does and needs no note about who else may connect.
  const container = await new PostgreSqlContainer(POSTGRES_IMAGE)
    .withPassword(HARNESS_ADMIN_PASSWORD)
    .start();
  const adminUrl = adminUrlOf(container, container.getDatabase());
  await withClient(adminUrl, async (client) => {
    await client.query(`create database ${quoteIdentifier(TEMPLATE_DATABASE)}`);
    // Supabase's API roles exist on the real server before any migration
    // runs, so they exist here too, and the grants test can show that the
    // migrations give them nothing.
    for (const role of PLATFORM_ROLES) {
      await client.query(`create role ${quoteIdentifier(role)} nologin`);
    }
  });
  await migrate(withDatabase(adminUrl, TEMPLATE_DATABASE));
  // The migrations create the login roles without passwords; production sets
  // them from the secret manager. Here each gets its fixed, published one, so
  // a test that prints a login URL prints nothing anyone could use.
  const roleUrls: Record<string, string> = {};
  await withClient(adminUrl, async (client) => {
    for (const role of LOGIN_ROLES) {
      const password = harnessPassword(role);
      // A role statement takes no parameters, so the value is checked instead.
      if (!/^[a-z0-9_-]+$/.test(password)) throw new Error(`unexpected password for ${role}`);
      await client.query(`alter role ${quoteIdentifier(role)} login password '${password}'`);
      const url = new URL(adminUrl);
      url.username = role;
      url.password = password;
      roleUrls[role] = url.toString();
    }
  });
  // A template cannot be cloned while anything is connected to it, and
  // nothing should write to it after this point either.
  await withClient(adminUrl, async (client) => {
    await client.query(
      `alter database ${quoteIdentifier(TEMPLATE_DATABASE)} with is_template true allow_connections false`,
    );
  });
  return {
    adminUrl,
    roleUrls,
    stop: async () => {
      await container.stop();
    },
  };
}
