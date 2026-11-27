// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// Agent keys and mandates against a real database, as the roles that use them:
// the app makes them, the worker reads the sealed secret to sign, the reader
// serves dashboards.

import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import type { Database, ProjectContext } from '../database.js';
import {
  nonce,
  sealed,
  testAccount,
  testAccounts,
  TestAddressError,
  testContract,
  testHex32,
} from '../testing/accounts.js';
import { insertProject, insertTenant } from '../testing/admin-tenants.js';
import { databaseAsServiceRoles } from '../testing/databases.js';
import { createTestDatabase, type TestDatabase } from '../testing/harness.js';
import { agentKeys, type AgentKey } from './agent-keys.js';
import { mandates, type Mandate, type NewMandate } from './mandates.js';
import { RepositoryInputError } from './values.js';

const adminUrl = inject('dbAdminUrl');
const roleUrls = inject('dbRoleUrls');

const TESTNET = 'stellar:testnet';
const PUBNET = 'stellar:pubnet';

let database: TestDatabase;
let admin: pg.Client;
let db: Database;
let tenant: ProjectContext;
let sibling: ProjectContext;

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

async function makeKey(context: ProjectContext, network = TESTNET): Promise<AgentKey> {
  return db
    .tenant(context)
    .transaction(async (tx) =>
      agentKeys.create(
        tx,
        { network, publicKey: testAccount(), secretCiphertext: sealed(1), secretNonce: nonce(2) },
        testAccounts,
      ),
    );
}

function newMandate(overrides: Partial<NewMandate> = {}): NewMandate {
  return {
    name: 'Payroll',
    network: TESTNET,
    contractAddress: testContract(),
    asset: 'USDC',
    scale: 7,
    agent: { address: testAccount() },
    principalWallet: testAccount(),
    ...overrides,
  };
}

async function rowsOf(table: string, context: ProjectContext): Promise<number> {
  const counted = await admin.query<{ count: string }>(
    `select count(*)::text as count from ${table} where principal_id = $1 and project_id = $2`,
    [context.principalId, context.projectId],
  );
  return Number.parseInt(counted.rows[0]?.count ?? '0', 10);
}

beforeAll(async () => {
  database = await createTestDatabase(adminUrl, import.meta.url);
  admin = new pg.Client({ connectionString: database.url });
  await admin.connect();
  db = databaseAsServiceRoles(roleUrls, database, 3);
});

beforeEach(async () => {
  tenant = await insertTenant(admin, 'Acme');
  sibling = {
    principalId: tenant.principalId,
    projectId: await insertProject(admin, tenant.principalId, 'Acme two'),
  };
});

afterAll(async () => {
  await db.close();
  await admin.end();
  await database.drop();
});

describe('agent keys', () => {
  it('stores the address the adapter returns and reads back only the public part', async () => {
    const address = testAccount();
    const key = await db.tenant(tenant).transaction(async (tx) =>
      agentKeys.create(
        tx,
        {
          network: TESTNET,
          publicKey: `  ${address}\n`,
          secretCiphertext: sealed(3),
          secretNonce: nonce(4),
        },
        testAccounts,
      ),
    );
    expect(key).toEqual({
      id: expect.any(String) as string,
      projectId: tenant.projectId,
      network: TESTNET,
      publicKey: address,
      status: 'active',
      // Every key starts unfunded; src/db/repositories/agent-key-funding.test.ts
      // covers how the record moves.
      funding: { status: 'pending', attempts: 0, lastError: null, fundedAt: null },
      createdAt: expect.any(Date) as Date,
    });
    expect(Object.keys(key)).not.toContain('ciphertext');
    const stored = await admin.query('select public_key from ujira.agent_keys where id = $1', [
      key.id,
    ]);
    expect(stored.rows).toEqual([{ public_key: address }]);
    expect(await db.tenant(tenant).transaction(async (tx) => agentKeys.get(tx, key.id))).toEqual(
      key,
    );
    expect(
      await db.tenant(tenant).transaction(async (tx) => agentKeys.active(tx, TESTNET)),
    ).toEqual(key);
    expect(
      await db.tenant(tenant).transaction(async (tx) => agentKeys.active(tx, PUBNET)),
    ).toBeUndefined();
  });

  it('refuses an address the adapter refuses, before any row is written', async () => {
    await expect(
      db.tenant(tenant).transaction(async (tx) =>
        agentKeys.create(
          tx,
          {
            network: TESTNET,
            publicKey: 'SBADSECRETSEEDPASTEDHERE',
            secretCiphertext: sealed(1),
            secretNonce: nonce(2),
          },
          testAccounts,
        ),
      ),
    ).rejects.toBeInstanceOf(TestAddressError);
    expect(await rowsOf('ujira.agent_keys', tenant)).toBe(0);
  });

  it('holds one active key per project and network, and a retired key stays retired', async () => {
    const first = await makeKey(tenant);
    expect(await codeOf(makeKey(tenant))).toBe('23505');
    // Another network and another project each have their own.
    await makeKey(tenant, PUBNET);
    await makeKey(sibling);

    expect(await db.tenant(tenant).transaction(async (tx) => agentKeys.retire(tx, first.id))).toBe(
      true,
    );
    expect(await db.tenant(tenant).transaction(async (tx) => agentKeys.retire(tx, first.id))).toBe(
      false,
    );
    const second = await makeKey(tenant);
    expect(
      (await db.tenant(tenant).transaction(async (tx) => agentKeys.active(tx, TESTNET)))?.id,
    ).toBe(second.id);
    expect(
      (await db.tenant(tenant).transaction(async (tx) => agentKeys.get(tx, first.id)))?.status,
    ).toBe('retired');

    const revived = db
      .tenant(tenant)
      .transaction(async (tx) =>
        tx
          .updateTable('ujira.agent_keys')
          .set({ status: 'active' })
          .where('id', '=', first.id)
          .execute(),
      );
    expect(await codeOf(revived)).toBe('UJ004');
  });

  it('gives a public key to one project only', async () => {
    const key = await makeKey(tenant);
    const other = await insertTenant(admin, 'Other');
    const reused = db.tenant(other).transaction(async (tx) =>
      agentKeys.create(
        tx,
        {
          network: TESTNET,
          publicKey: key.publicKey,
          secretCiphertext: sealed(5),
          secretNonce: nonce(6),
        },
        testAccounts,
      ),
    );
    expect(await codeOf(reused)).toBe('23505');
  });

  it('lets the worker read the sealed secret, and refuses it to the app and the reader', async () => {
    const key = await makeKey(tenant);
    const opened = await db.withTenant('worker', { ...tenant, scope: 'project' }, async (tx) =>
      agentKeys.sealedSecret(tx, key.id),
    );
    expect(opened).toEqual({
      id: key.id,
      projectId: tenant.projectId,
      network: TESTNET,
      publicKey: key.publicKey,
      ciphertext: sealed(1),
      nonce: nonce(2),
    });
    expect(
      await db.withTenant('worker', { ...sibling, scope: 'project' }, async (tx) =>
        agentKeys.sealedSecret(tx, key.id),
      ),
    ).toBeUndefined();
    expect(
      await codeOf(db.tenant(tenant).transaction(async (tx) => agentKeys.sealedSecret(tx, key.id))),
    ).toBe('42501');
    expect(
      await codeOf(
        db
          .principal(tenant, 'reader')
          .transaction(async (tx) => agentKeys.sealedSecret(tx, key.id)),
      ),
    ).toBe('42501');
  });

  it('never lets the app move a key to another address or network', async () => {
    const key = await makeKey(tenant);
    const moved = db
      .tenant(tenant)
      .transaction(async (tx) =>
        tx
          .updateTable('ujira.agent_keys')
          .set({ public_key: testAccount() })
          .where('id', '=', key.id)
          .execute(),
      );
    expect(await codeOf(moved)).toBe('42501');
  });

  it('refuses a nonce that is not 12 bytes and a network not in the adapter form', async () => {
    const insert = (network: string, secretNonce: Buffer) =>
      db
        .tenant(tenant)
        .transaction(async (tx) =>
          agentKeys.create(
            tx,
            { network, publicKey: testAccount(), secretCiphertext: sealed(1), secretNonce },
            testAccounts,
          ),
        );
    expect(await codeOf(insert(TESTNET, Buffer.alloc(16)))).toBe('23514');
    expect(await codeOf(insert('testnet', nonce(1)))).toBe('23514');
    expect(await codeOf(insert('Stellar:Testnet', nonce(1)))).toBe('23514');
  });
});

describe('mandates', () => {
  it('records a mandate that names the project key, with the key address filled in', async () => {
    const key = await makeKey(tenant);
    const txHash = testHex32();
    const input = newMandate({ agent: { keyId: key.id }, createdTxHash: txHash });
    const mandate = await db
      .tenant(tenant)
      .transaction(async (tx) => mandates.create(tx, input, testAccounts));
    expect(mandate).toEqual({
      id: expect.any(String) as string,
      projectId: tenant.projectId,
      name: 'Payroll',
      network: TESTNET,
      contractAddress: input.contractAddress,
      asset: 'USDC',
      scale: 7,
      agentKeyId: key.id,
      agentAddress: key.publicKey,
      principalWallet: input.principalWallet,
      createdTxHash: txHash,
      createdAt: expect.any(Date) as Date,
    });
    const stored = await admin.query<{ chain: string }>(
      'select chain from ujira.mandates where id = $1',
      [mandate.id],
    );
    expect(stored.rows).toEqual([{ chain: 'stellar' }]);
    expect(await db.tenant(tenant).transaction(async (tx) => mandates.get(tx, mandate.id))).toEqual(
      mandate,
    );
  });

  it('attaches a contract to one project only', async () => {
    const contractAddress = testContract();
    await db
      .tenant(tenant)
      .transaction(async (tx) =>
        mandates.create(tx, newMandate({ contractAddress }), testAccounts),
      );
    const inSibling = db
      .tenant(sibling)
      .transaction(async (tx) =>
        mandates.create(tx, newMandate({ contractAddress }), testAccounts),
      );
    expect(await codeOf(inSibling)).toBe('23505');
    const other = await insertTenant(admin, 'Other');
    const inOther = db
      .tenant(other)
      .transaction(async (tx) =>
        mandates.create(tx, newMandate({ contractAddress }), testAccounts),
      );
    expect(await codeOf(inOther)).toBe('23505');
    // The same address on another network is another contract.
    await db
      .tenant(sibling)
      .transaction(async (tx) =>
        mandates.create(tx, newMandate({ contractAddress, network: PUBNET }), testAccounts),
      );
  });

  it('refuses a key of another project, and a key on another network', async () => {
    const siblingKey = await makeKey(sibling);
    const borrowed = db
      .tenant(tenant)
      .transaction(async (tx) =>
        mandates.create(tx, newMandate({ agent: { keyId: siblingKey.id } }), testAccounts),
      );
    expect(await codeOf(borrowed)).toBe('23502');
    const pubnetKey = await makeKey(tenant, PUBNET);
    const crossed = db
      .tenant(tenant)
      .transaction(async (tx) =>
        mandates.create(tx, newMandate({ agent: { keyId: pubnetKey.id } }), testAccounts),
      );
    expect(await codeOf(crossed)).toBe('23503');
    expect(await rowsOf('ujira.mandates', tenant)).toBe(0);
  });

  it('takes an imported mandate whose agent is outside the project keys', async () => {
    const agent = testAccount();
    const mandate = await db
      .tenant(tenant)
      .transaction(async (tx) =>
        mandates.create(tx, newMandate({ agent: { address: ` ${agent} ` } }), testAccounts),
      );
    expect(mandate.agentKeyId).toBeNull();
    expect(mandate.agentAddress).toBe(agent);
    expect(mandate.createdTxHash).toBeNull();
  });

  it('refuses money in a unit the chain does not settle', async () => {
    const make = (overrides: Partial<NewMandate>) =>
      db
        .tenant(tenant)
        .transaction(async (tx) => mandates.create(tx, newMandate(overrides), testAccounts));
    expect(await codeOf(make({ scale: 6 }))).toBe('23503');
    expect(await codeOf(make({ asset: 'USDT' }))).toBe('23503');
    expect(await codeOf(make({ network: 'celo:mainnet' }))).toBe('23503');
    expect(await codeOf(make({ network: 'stellar' }))).toBe('23514');
  });

  it('refuses addresses the adapter refuses and a hash that is not 32 bytes of hex', async () => {
    const make = (overrides: Partial<NewMandate>) =>
      db
        .tenant(tenant)
        .transaction(async (tx) => mandates.create(tx, newMandate(overrides), testAccounts));
    await expect(make({ principalWallet: 'nobody' })).rejects.toBeInstanceOf(TestAddressError);
    await expect(make({ agent: { address: testContract() } })).rejects.toBeInstanceOf(
      TestAddressError,
    );
    await expect(make({ createdTxHash: 'AB'.repeat(32) })).rejects.toEqual(
      new RepositoryInputError('createdTxHash'),
    );
    await expect(make({ createdTxHash: 'ab' })).rejects.toBeInstanceOf(RepositoryInputError);
    expect(await rowsOf('ujira.mandates', tenant)).toBe(0);
  });

  it('finds a mandate by its contract, lists them in pages and renames one', async () => {
    const made: Mandate[] = [];
    for (const name of ['One', 'Two', 'Three']) {
      made.push(
        await db
          .tenant(tenant)
          .transaction(async (tx) => mandates.create(tx, newMandate({ name }), testAccounts)),
      );
    }
    const ids = made.map((mandate) => mandate.id).sort();
    const first = await db
      .tenant(tenant)
      .transaction(async (tx) => mandates.list(tx, { limit: 2 }));
    expect(first.items.map((mandate) => mandate.id)).toEqual(ids.slice(0, 2));
    expect(first.next).toBe(ids[1]);
    const rest = await db
      .tenant(tenant)
      .transaction(async (tx) => mandates.list(tx, { limit: 2, after: first.next ?? '' }));
    expect(rest.items.map((mandate) => mandate.id)).toEqual(ids.slice(2));
    expect(rest.next).toBeNull();

    const target = made[1];
    if (target === undefined) throw new Error('no mandate made');
    expect(
      (
        await db
          .tenant(tenant)
          .transaction(async (tx) => mandates.findByContract(tx, TESTNET, target.contractAddress))
      )?.id,
    ).toBe(target.id);
    expect(
      await db
        .tenant(tenant)
        .transaction(async (tx) => mandates.findByContract(tx, PUBNET, target.contractAddress)),
    ).toBeUndefined();

    expect(
      await db.tenant(tenant).transaction(async (tx) => mandates.rename(tx, target.id, 'Renamed')),
    ).toBe(true);
    expect(
      (await db.tenant(tenant).transaction(async (tx) => mandates.get(tx, target.id)))?.name,
    ).toBe('Renamed');
  });

  it('never lets the app move a mandate to another contract or agent', async () => {
    const mandate = await db
      .tenant(tenant)
      .transaction(async (tx) => mandates.create(tx, newMandate(), testAccounts));
    for (const column of ['contract_address', 'agent_address', 'principal_wallet'] as const) {
      const moved = db
        .tenant(tenant)
        .transaction(async (tx) =>
          tx
            .updateTable('ujira.mandates')
            .set(column, testAccount())
            .where('id', '=', mandate.id)
            .execute(),
        );
      expect(await codeOf(moved), column).toBe('42501');
    }
  });
});
