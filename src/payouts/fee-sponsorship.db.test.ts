// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The fee ledger the server runs on, against a real database as the role the
// API runs as: the daily cap is one total per principal across its projects,
// and each call is its own short tenant transaction.

import { createHash, randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { entryPoints, projects, type Database, type ProjectContext } from '../db/index.js';
import {
  createTestDatabase,
  databaseAsServiceRoles,
  type TestDatabase,
} from '../db/testing/index.js';
import { databaseFeeLedger, type FeeLedger } from './fee-sponsorship.js';

const adminUrl = inject('dbAdminUrl');
const roleUrls = inject('dbRoleUrls');

const DAY = '2026-11-27';

let database: TestDatabase;
let db: Database;
let ledger: FeeLedger;

beforeAll(async () => {
  database = await createTestDatabase(adminUrl, import.meta.url);
  db = databaseAsServiceRoles(roleUrls, database, 4);
  ledger = databaseFeeLedger(db);
});

afterAll(async () => {
  await db.close();
  await database.drop();
});

const txHash = (): string => createHash('sha256').update(randomUUID()).digest('hex');

function wallet(): string {
  return `G${randomUUID().replace(/-/g, '').toUpperCase()}`;
}

async function newTenant(): Promise<ProjectContext> {
  const created = await db.unscoped((tx) =>
    entryPoints.createPrincipal(tx, { name: 'Tenant', projectName: 'Main', ownerWallet: wallet() }),
  );
  return { principalId: created.principalId, projectId: created.projectId };
}

async function siblingOf(tenant: ProjectContext): Promise<ProjectContext> {
  const projectId = await db
    .tenant(tenant)
    .transaction((tx) => projects.create(tx, { name: 'Second' }));
  return { principalId: tenant.principalId, projectId };
}

describe('the database fee ledger', () => {
  it('reserves, settles and releases, with one cap across every project of a principal', async () => {
    const main = await newTenant();
    const second = await siblingOf(main);
    const reserve = (tenant: ProjectContext, innerTxHash: string, maxFee: bigint) =>
      ledger.reserve(tenant, { innerTxHash, day: DAY, maxFee, dailyCap: 1_000n });

    const first = txHash();
    expect(await reserve(main, first, 600n)).toEqual({ kind: 'reserved', used: 600n });
    expect(await reserve(second, txHash(), 500n)).toEqual({ kind: 'capped', used: 600n });
    expect(await ledger.settle(main, { innerTxHash: first, charged: 100n })).toBe(true);
    expect(await reserve(second, txHash(), 500n)).toEqual({ kind: 'reserved', used: 600n });

    const refused = txHash();
    expect(await reserve(second, refused, 400n)).toEqual({ kind: 'reserved', used: 1_000n });
    expect(await ledger.release(second, { innerTxHash: refused })).toBe(true);
    expect(await reserve(main, txHash(), 400n)).toEqual({ kind: 'reserved', used: 1_000n });

    const other = await newTenant();
    expect(await reserve(other, txHash(), 1_000n)).toEqual({ kind: 'reserved', used: 1_000n });
  });
});
