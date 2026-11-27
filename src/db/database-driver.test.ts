// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The parts of the query layer that do not need a server: what the driver
// refuses, and what closing a database does. The behaviour against a real
// Postgres is in database.test.ts.

import { describe, expect, it } from 'vitest';

import type pg from 'pg';

import { CompiledQuery } from 'kysely';

import { loadDatabaseConfig, type DatabaseEnvironment } from './config.js';
import { ClientConnection, createDatabase, OwnedClientDriver } from './database.js';
import { SessionStateError } from './errors.js';

const URLS: DatabaseEnvironment = {
  // Port 1 is never listening, so a connection attempt fails fast. Nothing
  // in this file reaches a server.
  UJIRA_DB_APP_URL: 'postgresql://app:secret@127.0.0.1:1/postgres',
  UJIRA_DB_WORKER_URL: 'postgresql://worker:secret@127.0.0.1:1/postgres',
  UJIRA_DB_READER_URL: 'postgresql://reader:secret@127.0.0.1:1/postgres',
  UJIRA_DB_MIGRATOR_URL: 'postgresql://migrator:secret@127.0.0.1:1/postgres',
  UJIRA_DB_ACQUIRE_TIMEOUT_MS: '500',
};

const CONTEXT = {
  principalId: '0199a1f6-1e3f-7c21-9b8a-2d4e6f8a0b12',
  projectId: '0199a1f6-4c7d-7a55-8e21-5b9c7d3e1f04',
  scope: 'project',
} as const;

describe('createDatabase', () => {
  it('refuses a tenant context that fails its checks before connecting', async () => {
    const db = createDatabase(loadDatabaseConfig(URLS));
    try {
      await expect(
        db.withTenant('app', { ...CONTEXT, principalId: 'nope' }, () => Promise.resolve()),
      ).rejects.toThrow(/principalId/);
    } finally {
      await db.close();
    }
  });

  it('reports the connection failure rather than hanging', async () => {
    const db = createDatabase(loadDatabaseConfig(URLS));
    try {
      await expect(db.withTenant('app', CONTEXT, () => Promise.resolve())).rejects.toThrow();
    } finally {
      await db.close();
    }
  });

  it('closes every pool, and closing twice is not an error', async () => {
    const db = createDatabase(loadDatabaseConfig(URLS));
    await db.close();
    await expect(db.close()).resolves.toBeUndefined();
  });
});

describe('the driver kysely is handed', () => {
  // These methods exist to satisfy the driver interface. Nothing reaches
  // them through withTenant, which is the point: each one refuses rather
  // than quietly opening a second transaction on the same connection, or
  // committing one this package did not open.
  const connection = new ClientConnection({
    query: () => Promise.reject(new Error('not used')),
  } as unknown as pg.PoolClient);
  const driver = new OwnedClientDriver(connection);

  it('hands back the one connection it owns', async () => {
    await expect(driver.init()).resolves.toBeUndefined();
    await expect(driver.acquireConnection()).resolves.toBe(connection);
    await expect(driver.releaseConnection()).resolves.toBeUndefined();
    await expect(driver.destroy()).resolves.toBeUndefined();
  });

  it.each([
    ['beginTransaction', () => driver.beginTransaction()],
    ['commitTransaction', () => driver.commitTransaction()],
    ['rollbackTransaction', () => driver.rollbackTransaction()],
  ])('refuses %s, because withTenant owns the transaction', async (_name, call) => {
    await expect(call()).rejects.toThrow(/withTenant/);
  });

  it('refuses to stream, which a pooled connection does not promise', () => {
    expect(() => connection.streamQuery()).toThrow(/streaming/);
  });

  it('checks the statement before sending it, even on this connection', async () => {
    await expect(
      connection.executeQuery(CompiledQuery.raw("set ujira.principal_id = 'p'")),
    ).rejects.toThrow(SessionStateError);
  });
});
