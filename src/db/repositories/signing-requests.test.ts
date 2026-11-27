// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// Signing requests against a real database, as the app writes them.

import { randomUUID } from 'node:crypto';

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
import { insertTenant } from '../testing/admin-tenants.js';
import { databaseAsServiceRoles } from '../testing/databases.js';
import { createTestDatabase, type TestDatabase } from '../testing/harness.js';
import { agentKeys } from './agent-keys.js';
import { mandates } from './mandates.js';
import { signingRequests, type NewSigningRequest, type SigningAction } from './signing-requests.js';
import { RepositoryInputError } from './values.js';

const adminUrl = inject('dbAdminUrl');
const roleUrls = inject('dbRoleUrls');

let database: TestDatabase;
let admin: pg.Client;
let db: Database;
let tenant: ProjectContext;
let mandateId: string;

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

function request(overrides: Partial<NewSigningRequest> = {}): NewSigningRequest {
  return {
    mandateId,
    action: 'allow_recipients',
    network: 'stellar:testnet',
    signer: testAccount(),
    envelope: 'AAAAAgAAAAB=',
    summary: 'Allow a recipient to be paid',
    expiresAt: new Date('2030-01-01T00:10:00.000Z'),
    ...overrides,
  };
}

const create = (input: NewSigningRequest) =>
  db.tenant(tenant).transaction(async (tx) => signingRequests.create(tx, input, testAccounts));

beforeAll(async () => {
  database = await createTestDatabase(adminUrl, import.meta.url);
  admin = new pg.Client({ connectionString: database.url });
  await admin.connect();
  db = databaseAsServiceRoles(roleUrls, database, 2);
});

beforeEach(async () => {
  tenant = await insertTenant(admin, 'Acme');
  mandateId = await db.tenant(tenant).transaction(
    async (tx) =>
      (
        await mandates.create(
          tx,
          {
            name: 'Payroll',
            network: 'stellar:testnet',
            contractAddress: testContract(),
            asset: 'USDC',
            scale: 7,
            agent: { address: testAccount() },
            principalWallet: testAccount(),
          },
          testAccounts,
        )
      ).id,
  );
});

afterAll(async () => {
  await db.close();
  await admin.end();
  await database.drop();
});

describe('signing requests', () => {
  it('keeps what was prepared and reads it back', async () => {
    const signer = testAccount();
    const made = await create(request({ signer: ` ${signer}` }));
    expect(made).toEqual({
      id: expect.any(String) as string,
      projectId: tenant.projectId,
      mandateId,
      action: 'allow_recipients',
      network: 'stellar:testnet',
      signer,
      envelope: 'AAAAAgAAAAB=',
      summary: 'Allow a recipient to be paid',
      expiresAt: new Date('2030-01-01T00:10:00.000Z'),
      mandateName: null,
      agentKeyId: null,
      submittedTxHash: null,
      submittedAt: null,
      createdAt: expect.any(Date) as Date,
    });
    expect(
      await db.tenant(tenant).transaction(async (tx) => signingRequests.get(tx, made.id)),
    ).toEqual(made);
    expect(
      await db.tenant(tenant).transaction(async (tx) => signingRequests.get(tx, randomUUID())),
    ).toBeUndefined();
  });

  it('records the first transaction submitted and never another', async () => {
    const made = await create(request());
    const hash = testHex32();
    const mark = (txHash: string) =>
      db
        .tenant(tenant)
        .transaction(async (tx) => signingRequests.markSubmitted(tx, made.id, txHash));
    expect(await mark(hash)).toBe(true);
    expect(await mark(testHex32())).toBe(false);
    const read = await db
      .tenant(tenant)
      .transaction(async (tx) => signingRequests.get(tx, made.id));
    expect(read?.submittedTxHash).toBe(hash);
    expect(read?.submittedAt).toBeInstanceOf(Date);
    const rewritten = db.tenant(tenant).transaction(async (tx) =>
      tx
        .updateTable('ujira.signing_requests')
        .set({ submitted_tx_hash: Buffer.alloc(32, 7) })
        .where('id', '=', made.id)
        .execute(),
    );
    expect(await codeOf(rewritten)).toBe('UJ006');
    await expect(mark('not hex')).rejects.toBeInstanceOf(RepositoryInputError);
  });

  it('ties a create to no mandate and every other action to one', async () => {
    expect((await create(request({ action: 'create', mandateId: null }))).mandateId).toBeNull();
    expect(await codeOf(create(request({ action: 'create' })))).toBe('23514');
    expect(await codeOf(create(request({ action: 'pause', mandateId: null })))).toBe('23514');
  });

  it('keeps what a create needs for its mandate row, and only on a create', async () => {
    const key = await db.tenant(tenant).transaction(async (tx) =>
      agentKeys.create(
        tx,
        {
          network: 'stellar:testnet',
          publicKey: testAccount(),
          secretCiphertext: sealed(1),
          secretNonce: nonce(2),
        },
        testAccounts,
      ),
    );
    const made = await create(
      request({
        action: 'create',
        mandateId: null,
        mandateName: 'Payroll',
        agentKeyId: key.id,
      }),
    );
    expect(made).toMatchObject({
      mandateName: 'Payroll',
      agentKeyId: key.id,
    });
    expect(await codeOf(create(request({ mandateName: 'Payroll' })))).toBe('23514');
    expect(await codeOf(create(request({ agentKeyId: key.id })))).toBe('23514');
    expect(
      await codeOf(
        create(request({ action: 'create', mandateId: null, agentKeyId: randomUUID() })),
      ),
    ).toBe('23503');
  });

  it('refuses what no row may hold', async () => {
    await expect(create(request({ action: 'sweep' as SigningAction }))).rejects.toEqual(
      new RepositoryInputError('action'),
    );
    await expect(create(request({ signer: 'not an account' }))).rejects.toBeInstanceOf(
      TestAddressError,
    );
    expect(await codeOf(create(request({ envelope: 'not base64!' })))).toBe('23514');
    expect(await codeOf(create(request({ summary: '' })))).toBe('23514');
    expect(await codeOf(create(request({ mandateId: randomUUID() })))).toBe('23503');
  });

  it('never lets the app rewrite what was prepared', async () => {
    const made = await create(request());
    const rewritten = db
      .tenant(tenant)
      .transaction(async (tx) =>
        tx
          .updateTable('ujira.signing_requests')
          .set({ envelope: 'AAAA' })
          .where('id', '=', made.id)
          .execute(),
      );
    expect(await codeOf(rewritten)).toBe('42501');
  });
});
