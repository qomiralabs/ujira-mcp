// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// Agent keys end to end on a real database, as the roles the server runs as:
// the app makes and funds them, the worker opens them to sign. Another
// project's key is not found, from a sibling project or another principal.

import { randomBytes, randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';

import { StellarAgentAccounts } from '../chain/stellar/agent-accounts.js';
import { entryPoints, projects, type Database, type ProjectContext } from '../db/index.js';
import {
  createTestDatabase,
  databaseAsServiceRoles,
  type TestDatabase,
} from '../db/testing/index.js';
import { createAgentKeyService, type AgentKeyService } from './agent-keys.js';
import { postgresAgentKeyStore } from './postgres-store.js';
import { createSealer } from './sealer.js';

const adminUrl = inject('dbAdminUrl');
const roleUrls = inject('dbRoleUrls');

let database: TestDatabase;
let db: Database;
let service: AgentKeyService;
const friendbot = vi.fn<(address: string) => Promise<void>>(() => Promise.resolve());

const accountsParser = {
  parseAccount: (raw: string) => {
    if (!/^G[A-Z2-7]{55}$/.test(raw)) throw new Error('not an account');
    return raw;
  },
};

beforeAll(async () => {
  database = await createTestDatabase(adminUrl, import.meta.url);
  db = databaseAsServiceRoles(roleUrls, database, 4);
  service = createAgentKeyService({
    store: postgresAgentKeyStore(db, { accounts: accountsParser }),
    sealer: createSealer(randomBytes(32).toString('base64')),
    accounts: new StellarAgentAccounts({
      network: 'stellar:testnet',
      chain: {
        friendbot,
        accountFacts: () => Promise.resolve({ exists: true, trustlines: [], memoRequired: false }),
      },
    }),
  });
});

afterAll(async () => {
  await db.close();
  await database.drop();
});

async function newTenant(): Promise<ProjectContext> {
  const owner = `G${randomUUID().replace(/-/g, '').toUpperCase()}`;
  const created = await db.unscoped((tx) =>
    entryPoints.createPrincipal(tx, { name: 'Tenant', projectName: 'Main', ownerWallet: owner }),
  );
  return { principalId: created.principalId, projectId: created.projectId };
}

async function siblingOf(tenant: ProjectContext): Promise<ProjectContext> {
  const projectId = await db
    .tenant(tenant)
    .transaction((tx) => projects.create(tx, { name: `Second ${randomUUID().slice(0, 8)}` }));
  return { principalId: tenant.principalId, projectId };
}

describe('agent keys on Postgres', () => {
  it('makes one funded key per project, even when provisioning races', async () => {
    const a = await newTenant();
    const made = await Promise.all([
      service.provision(a, 'req-1'),
      service.provision(a, 'req-2'),
      service.provision(a, 'req-3'),
    ]);
    expect(new Set(made.map((k) => k.id)).size).toBe(1);
    const active = await service.active(a);
    expect(active?.funding.status).toBe('funded');
    expect(friendbot).toHaveBeenCalledWith(active?.publicKey);
  });

  it('signs with the project own key and finds no other project key', async () => {
    const a = await newTenant();
    const sibling = await siblingOf(a);
    const stranger = await newTenant();
    const ka = await service.provision(a, 'req-4');
    const ks = await service.provision(sibling, 'req-5');
    const kx = await service.provision(stranger, 'req-6');

    expect((await service.signer(a, ka.id)).publicKey).toBe(ka.publicKey);
    expect((await service.activeSigner(sibling)).publicKey).toBe(ks.publicKey);
    for (const foreign of [ks.id, kx.id]) {
      await expect(service.signer(a, foreign)).rejects.toMatchObject({ code: 'KEY_NOT_FOUND' });
      await expect(service.fund(a, foreign, 'req-7')).rejects.toMatchObject({
        code: 'KEY_NOT_FOUND',
      });
    }
  });
});
