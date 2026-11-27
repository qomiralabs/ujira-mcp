// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// An agent key's funding record and its sealed secret against a real
// database: attempts only count up, a funded account stays funded, and a
// ciphertext an administrator moves onto another project's row does not open
// there.

import { randomBytes } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import { agentSecretAssociatedData } from '../../keys/agent-keys.js';
import { createSealer, SealError } from '../../keys/sealer.js';
import type { Database, ProjectContext } from '../database.js';
import { testAccount, testAccounts } from '../testing/accounts.js';
import { insertProject, insertTenant } from '../testing/admin-tenants.js';
import { databaseAsServiceRoles } from '../testing/databases.js';
import { createTestDatabase, type TestDatabase } from '../testing/harness.js';
import { agentKeys, type AgentKey } from './agent-keys.js';

const adminUrl = inject('dbAdminUrl');
const roleUrls = inject('dbRoleUrls');

const TESTNET = 'stellar:testnet';
const sealer = createSealer(randomBytes(32).toString('base64'));

let database: TestDatabase;
let admin: pg.Client;
let db: Database;
let tenant: ProjectContext;
let sibling: ProjectContext;

beforeAll(async () => {
  database = await createTestDatabase(adminUrl, import.meta.url);
  admin = new pg.Client({ connectionString: database.url });
  await admin.connect();
  db = databaseAsServiceRoles(roleUrls, database, 2);
});

// A project holds one active key per network, so every test makes its keys
// in projects of its own.
beforeEach(async () => {
  tenant = await insertTenant(admin, 'Funding');
  sibling = {
    principalId: tenant.principalId,
    projectId: await insertProject(admin, tenant.principalId, 'Second'),
  };
});

afterAll(async () => {
  await db.close();
  await admin.end();
  await database.drop();
});

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

// A key sealed for its own project, as the key module seals it.
async function makeKey(context: ProjectContext): Promise<AgentKey> {
  const publicKey = testAccount();
  const box = sealer.seal(randomBytes(32), agentSecretAssociatedData(context, TESTNET, publicKey));
  return db
    .tenant(context)
    .transaction(async (tx) =>
      agentKeys.create(
        tx,
        { network: TESTNET, publicKey, secretCiphertext: box.ciphertext, secretNonce: box.nonce },
        testAccounts,
      ),
    );
}

describe('agent key funding', () => {
  it('starts pending, counts each attempt, and stays funded once funded', async () => {
    const key = await makeKey(tenant);
    expect(key.funding).toEqual({
      status: 'pending',
      attempts: 0,
      lastError: null,
      fundedAt: null,
    });

    const failed = await db
      .tenant(tenant)
      .transaction(async (tx) =>
        agentKeys.recordFunding(tx, key.id, { kind: 'failed', error: 'UNAVAILABLE', final: false }),
      );
    expect(failed?.funding).toMatchObject({
      status: 'pending',
      attempts: 1,
      lastError: 'UNAVAILABLE',
    });

    const funded = await db.withTenant('worker', { ...tenant, scope: 'project' }, async (tx) =>
      agentKeys.recordFunding(tx, key.id, { kind: 'funded' }),
    );
    expect(funded?.funding.status).toBe('funded');
    expect(funded?.funding.attempts).toBe(2);
    expect(funded?.funding.lastError).toBeNull();
    expect(funded?.funding.fundedAt).toBeInstanceOf(Date);

    // A late failure from a slower attempt leaves the funded record alone.
    const late = await db
      .tenant(tenant)
      .transaction(async (tx) =>
        agentKeys.recordFunding(tx, key.id, { kind: 'failed', error: 'TIMEOUT', final: true }),
      );
    expect(late).toBeUndefined();
    expect(
      (await db.tenant(tenant).transaction(async (tx) => agentKeys.get(tx, key.id)))?.funding,
    ).toMatchObject({ status: 'funded', attempts: 2 });
  });

  it('reads failed after the last attempt', async () => {
    const key = await makeKey(tenant);
    const failed = await db
      .tenant(tenant)
      .transaction(async (tx) =>
        agentKeys.recordFunding(tx, key.id, { kind: 'failed', error: 'TIMEOUT', final: true }),
      );
    expect(failed?.funding).toMatchObject({ status: 'failed', attempts: 1, lastError: 'TIMEOUT' });
  });

  it('records nothing for another project key', async () => {
    const key = await makeKey(sibling);
    expect(
      await db
        .tenant(tenant)
        .transaction(async (tx) => agentKeys.recordFunding(tx, key.id, { kind: 'funded' })),
    ).toBeUndefined();
    const row = await admin.query<{ funding_status: string; funding_attempts: number }>(
      'select funding_status, funding_attempts from ujira.agent_keys where id = $1',
      [key.id],
    );
    expect(row.rows[0]).toEqual({ funding_status: 'pending', funding_attempts: 0 });
  });

  it('refuses to unfund an account or count attempts down, even for an administrator', async () => {
    const key = await makeKey(tenant);
    await db
      .tenant(tenant)
      .transaction(async (tx) => agentKeys.recordFunding(tx, key.id, { kind: 'funded' }));
    expect(
      await codeOf(
        admin.query(
          `update ujira.agent_keys set funding_status = 'pending', funded_at = null where id = $1`,
          [key.id],
        ),
      ),
    ).toBe('UJ004');
    expect(
      await codeOf(
        admin.query('update ujira.agent_keys set funding_attempts = 0 where id = $1', [key.id]),
      ),
    ).toBe('UJ004');
  });

  it('keeps the error to a short code and funded_at to funded keys', async () => {
    const key = await makeKey(tenant);
    expect(
      await codeOf(
        admin.query(
          `update ujira.agent_keys set funding_error = 'friendbot said: no' where id = $1`,
          [key.id],
        ),
      ),
    ).toBe('23514');
    expect(
      await codeOf(
        admin.query('update ujira.agent_keys set funded_at = now() where id = $1', [key.id]),
      ),
    ).toBe('23514');
  });

  it('still keeps the secret from the app while it reads the funding columns', async () => {
    const key = await makeKey(tenant);
    expect(
      (await db.tenant(tenant).transaction(async (tx) => agentKeys.active(tx, TESTNET)))?.funding,
    ).toBeDefined();
    expect(
      await codeOf(db.tenant(tenant).transaction(async (tx) => agentKeys.sealedSecret(tx, key.id))),
    ).toBe('42501');
  });
});

describe('a sealed agent secret', () => {
  it('opens on its own row and not after it is moved onto another project row', async () => {
    const own = await makeKey(tenant);
    const other = await makeKey(sibling);
    const read = async (context: ProjectContext, id: string) => {
      const box = await db.withTenant('worker', { ...context, scope: 'project' }, async (tx) =>
        agentKeys.sealedSecret(tx, id),
      );
      if (box === undefined) throw new Error('expected the sealed secret');
      return box;
    };

    const mine = await read(tenant, own.id);
    expect(
      sealer.open(mine, agentSecretAssociatedData(tenant, mine.network, mine.publicKey)),
    ).toHaveLength(32);

    // Copied the way a mistaken update or a bad restore would copy it.
    await admin.query(
      `update ujira.agent_keys
          set secret_ciphertext = $1, secret_nonce = $2
        where id = $3`,
      [mine.ciphertext, mine.nonce, other.id],
    );
    const moved = await read(sibling, other.id);
    expect(moved.ciphertext.equals(mine.ciphertext)).toBe(true);
    expect(() =>
      sealer.open(moved, agentSecretAssociatedData(sibling, moved.network, moved.publicKey)),
    ).toThrow(SealError);
  });
});
