// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// Every method of the agent key, mandate and recipient repositories, run as
// tenant A against tenant B's rows and against A's own second project. Two
// principals with two projects each, one of everything in each project. Each
// case shows the call finds nothing, changes nothing, is refused, or lands on
// A's own project. The matrix fails when a method is added without a case.

import type { Kysely } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import type { Database, ProjectContext } from '../database.js';
import type { Schema } from '../schema.js';
import {
  nonce,
  sealed,
  testAccount,
  testAccounts,
  testContract,
  testHex32,
} from '../testing/accounts.js';
import { insertProject, insertTenant } from '../testing/admin-tenants.js';
import { caseProblems } from '../testing/cross-tenant.js';
import { databaseAsServiceRoles } from '../testing/databases.js';
import { createTestDatabase, type TestDatabase } from '../testing/harness.js';
import { agentKeyRepositories, agentKeys } from './agent-keys.js';
import { mandateRepositories, mandates } from './mandates.js';
import { payoutMethods, recipientPii, recipientRepositories, recipients } from './recipients.js';
import {
  signingRequestRepositories,
  signingRequests,
  type NewSigningRequest,
} from './signing-requests.js';

const adminUrl = inject('dbAdminUrl');
const roleUrls = inject('dbRoleUrls');

const TESTNET = 'stellar:testnet';

interface Rows {
  readonly context: ProjectContext;
  readonly keyId: string;
  readonly mandateId: string;
  readonly contractAddress: string;
  readonly recipientId: string;
  readonly label: string;
  readonly methodId: string;
  readonly signingRequestId: string;
}

interface World {
  readonly first: Rows;
  readonly second: Rows;
}

const REPOSITORIES = {
  ...agentKeyRepositories,
  ...mandateRepositories,
  ...recipientRepositories,
  ...signingRequestRepositories,
};

let database: TestDatabase;
let admin: pg.Client;
let db: Database;
let a: World;
let b: World;

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

async function ownerOf(table: string, id: string): Promise<ProjectContext | undefined> {
  const result = await admin.query<{ principal_id: string; project_id: string }>(
    `select principal_id, project_id from ${table} where id = $1`,
    [id],
  );
  const row = result.rows[0];
  return row === undefined
    ? undefined
    : { principalId: row.principal_id, projectId: row.project_id };
}

async function columnOf(table: string, column: string, id: string): Promise<unknown> {
  const result = await admin.query<{ value: unknown }>(
    `select ${column} as value from ${table} where id = $1`,
    [id],
  );
  return result.rows[0]?.value;
}

// One project with a key, a mandate that names it, a recipient with an email
// and a wallet.
async function rows(context: ProjectContext): Promise<Rows> {
  const label = `Ada ${context.projectId.slice(0, 8)}`;
  return db.tenant(context).transaction(async (tx) => {
    const key = await agentKeys.create(
      tx,
      {
        network: TESTNET,
        publicKey: testAccount(),
        secretCiphertext: sealed(1),
        secretNonce: nonce(2),
      },
      testAccounts,
    );
    const mandate = await mandates.create(
      tx,
      {
        name: 'Payroll',
        network: TESTNET,
        contractAddress: testContract(),
        asset: 'USDC',
        scale: 7,
        agent: { keyId: key.id },
        principalWallet: testAccount(),
      },
      testAccounts,
    );
    const recipient = await recipients.create(tx, {
      mandateId: mandate.id,
      label,
      recipientRef: testHex32(),
    });
    await recipientPii.setEmail(tx, recipient.id, { ciphertext: sealed(3), nonce: nonce(4) });
    const method = await payoutMethods.addWallet(
      tx,
      {
        recipientId: recipient.id,
        destination: testAccount(),
        destinationCheck: { receivable: true },
        verified: false,
      },
      testAccounts,
    );
    const request = await signingRequests.create(tx, signingRequestFor(mandate.id), testAccounts);
    return {
      context,
      keyId: key.id,
      mandateId: mandate.id,
      contractAddress: mandate.contractAddress,
      recipientId: recipient.id,
      label,
      methodId: method.id,
      signingRequestId: request.id,
    };
  });
}

function signingRequestFor(mandateId: string): NewSigningRequest {
  return {
    mandateId,
    action: 'allow_recipients',
    network: TESTNET,
    signer: testAccount(),
    envelope: 'AAAAAgAAAAB=',
    summary: 'Allow a recipient',
    expiresAt: new Date(Date.now() + 600_000),
  };
}

async function world(name: string): Promise<World> {
  const first = await insertTenant(admin, name);
  const second = {
    principalId: first.principalId,
    projectId: await insertProject(admin, first.principalId, `${name} two`),
  };
  return { first: await rows(first), second: await rows(second) };
}

const asA = async <T>(work: (tx: Kysely<Schema>) => Promise<T>): Promise<T> =>
  db.tenant(a.first.context).transaction(work);
// Every project of A, read only.
const acrossA = async <T>(work: (tx: Kysely<Schema>) => Promise<T>): Promise<T> =>
  db.principal(a.first.context, 'app').transaction(work);
const asAWorker = async <T>(work: (tx: Kysely<Schema>) => Promise<T>): Promise<T> =>
  db.withTenant('worker', { ...a.first.context, scope: 'project' }, work);

// The rows A must not reach: all of B's, and A's other project.
const foreign = (): readonly Rows[] => [b.first, b.second, a.second];

const cases: Record<string, () => Promise<void>> = {
  'agentKeys.create': async () => {
    const key = await asA(async (tx) =>
      agentKeys.create(
        tx,
        {
          network: 'stellar:pubnet',
          publicKey: testAccount(),
          secretCiphertext: sealed(5),
          secretNonce: nonce(6),
        },
        testAccounts,
      ),
    );
    expect(await ownerOf('ujira.agent_keys', key.id)).toEqual(a.first.context);
  },
  'agentKeys.get': async () => {
    for (const other of foreign()) {
      expect(await asA(async (tx) => agentKeys.get(tx, other.keyId))).toBeUndefined();
    }
    expect(await asA(async (tx) => agentKeys.get(tx, a.first.keyId))).toBeDefined();
  },
  'agentKeys.active': async () => {
    expect((await asA(async (tx) => agentKeys.active(tx, TESTNET)))?.id).toBe(a.first.keyId);
  },
  'agentKeys.retire': async () => {
    for (const other of foreign()) {
      expect(await asA(async (tx) => agentKeys.retire(tx, other.keyId))).toBe(false);
      expect(await columnOf('ujira.agent_keys', 'status', other.keyId)).toBe('active');
    }
  },
  'agentKeys.sealedSecret': async () => {
    for (const other of foreign()) {
      expect(
        await asAWorker(async (tx) => agentKeys.sealedSecret(tx, other.keyId)),
      ).toBeUndefined();
    }
    expect(await asAWorker(async (tx) => agentKeys.sealedSecret(tx, a.first.keyId))).toBeDefined();
  },
  'mandates.create': async () => {
    // Another tenant's key reads as nothing, so the row has no agent address.
    for (const other of foreign()) {
      const borrowed = asA(async (tx) =>
        mandates.create(
          tx,
          {
            name: 'Borrowed',
            network: TESTNET,
            contractAddress: testContract(),
            asset: 'USDC',
            scale: 7,
            agent: { keyId: other.keyId },
            principalWallet: testAccount(),
          },
          testAccounts,
        ),
      );
      expect(await codeOf(borrowed)).toBe('23502');
    }
    const own = await asA(async (tx) =>
      mandates.create(
        tx,
        {
          name: 'Own',
          network: TESTNET,
          contractAddress: testContract(),
          asset: 'USDC',
          scale: 7,
          agent: { keyId: a.first.keyId },
          principalWallet: testAccount(),
        },
        testAccounts,
      ),
    );
    expect(await ownerOf('ujira.mandates', own.id)).toEqual(a.first.context);
  },
  'mandates.get': async () => {
    for (const other of foreign()) {
      expect(await asA(async (tx) => mandates.get(tx, other.mandateId))).toBeUndefined();
    }
    expect(await asA(async (tx) => mandates.get(tx, a.first.mandateId))).toBeDefined();
  },
  'mandates.list': async () => {
    // Across A's projects, so A's second shows and B's never does.
    const page = await acrossA(async (tx) => mandates.list(tx, { limit: 100 }));
    const ids = page.items.map((mandate) => mandate.id);
    expect(ids).toContain(a.first.mandateId);
    expect(ids).toContain(a.second.mandateId);
    expect(ids).not.toContain(b.first.mandateId);
    expect(ids).not.toContain(b.second.mandateId);
    const own = await asA(async (tx) => mandates.list(tx, { limit: 100 }));
    expect(own.items.map((mandate) => mandate.id)).not.toContain(a.second.mandateId);
  },
  'mandates.findByContract': async () => {
    for (const other of foreign()) {
      expect(
        await asA(async (tx) => mandates.findByContract(tx, TESTNET, other.contractAddress)),
      ).toBeUndefined();
    }
  },
  'mandates.rename': async () => {
    for (const other of foreign()) {
      expect(await asA(async (tx) => mandates.rename(tx, other.mandateId, 'Taken'))).toBe(false);
      expect(await columnOf('ujira.mandates', 'name', other.mandateId)).toBe('Payroll');
    }
  },
  'recipients.create': async () => {
    for (const other of foreign()) {
      const planted = asA(async (tx) =>
        recipients.create(tx, {
          mandateId: other.mandateId,
          label: 'Planted',
          recipientRef: testHex32(),
        }),
      );
      expect(await codeOf(planted)).toBe('23503');
    }
    const own = await asA(async (tx) =>
      recipients.create(tx, {
        mandateId: a.first.mandateId,
        label: 'Own',
        recipientRef: testHex32(),
      }),
    );
    expect(await ownerOf('ujira.recipients', own.id)).toEqual(a.first.context);
  },
  'recipients.get': async () => {
    for (const other of foreign()) {
      expect(await asA(async (tx) => recipients.get(tx, other.recipientId))).toBeUndefined();
    }
  },
  'recipients.listInProject': async () => {
    const own = await asA(async (tx) => recipients.listInProject(tx, { limit: 100 }));
    const ids = own.items.map((recipient) => recipient.id);
    expect(ids).toContain(a.first.recipientId);
    for (const other of foreign()) expect(ids).not.toContain(other.recipientId);
    // Read across A's projects, A's second shows and B's never does.
    const across = await acrossA(async (tx) => recipients.listInProject(tx, { limit: 100 }));
    const all = across.items.map((recipient) => recipient.id);
    expect(all).toContain(a.second.recipientId);
    expect(all).not.toContain(b.first.recipientId);
    expect(all).not.toContain(b.second.recipientId);
  },
  'recipients.list': async () => {
    for (const other of foreign()) {
      const page = await acrossA(async (tx) =>
        recipients.list(tx, other.mandateId, { limit: 100 }),
      );
      const expected = other === a.second ? [a.second.recipientId] : [];
      expect(page.items.map((recipient) => recipient.id)).toEqual(expected);
      expect(
        (await asA(async (tx) => recipients.list(tx, other.mandateId, { limit: 100 }))).items,
      ).toEqual([]);
    }
  },
  'recipients.findByLabel': async () => {
    for (const other of foreign()) {
      expect(
        await asA(async (tx) => recipients.findByLabel(tx, other.mandateId, other.label)),
      ).toBeUndefined();
    }
  },
  'recipients.setStatus': async () => {
    for (const other of foreign()) {
      expect(
        await asA(async (tx) => recipients.setStatus(tx, other.recipientId, 'suspended')),
      ).toBe(false);
      expect(await columnOf('ujira.recipients', 'status', other.recipientId)).toBe('active');
    }
  },
  'recipientPii.setEmail': async () => {
    for (const other of foreign()) {
      const planted = asA(async (tx) =>
        recipientPii.setEmail(tx, other.recipientId, { ciphertext: sealed(9), nonce: nonce(9) }),
      );
      expect(await codeOf(planted)).toBe('23503');
      const kept = await admin.query<{ email_nonce: Buffer }>(
        'select email_nonce from ujira.recipient_pii where recipient_id = $1',
        [other.recipientId],
      );
      expect(kept.rows).toEqual([{ email_nonce: nonce(4) }]);
    }
  },
  'recipientPii.email': async () => {
    for (const other of foreign()) {
      expect(await asA(async (tx) => recipientPii.email(tx, other.recipientId))).toBeUndefined();
    }
    expect(await asA(async (tx) => recipientPii.email(tx, a.first.recipientId))).toBeDefined();
  },
  'payoutMethods.addWallet': async () => {
    for (const other of foreign()) {
      const planted = asA(async (tx) =>
        payoutMethods.addWallet(
          tx,
          {
            recipientId: other.recipientId,
            destination: testAccount(),
            destinationCheck: { receivable: true },
            verified: true,
          },
          testAccounts,
        ),
      );
      expect(await codeOf(planted)).toBe('23503');
    }
  },
  'payoutMethods.get': async () => {
    for (const other of foreign()) {
      expect(await asA(async (tx) => payoutMethods.get(tx, other.methodId))).toBeUndefined();
    }
    expect(await asA(async (tx) => payoutMethods.get(tx, a.first.methodId))).toBeDefined();
  },
  'payoutMethods.list': async () => {
    for (const other of foreign()) {
      expect(
        (await asA(async (tx) => payoutMethods.list(tx, other.recipientId, { limit: 100 }))).items,
      ).toEqual([]);
    }
  },
  'payoutMethods.forRecipients': async () => {
    const ids = foreign().map((other) => other.recipientId);
    expect(await asA(async (tx) => payoutMethods.forRecipients(tx, ids))).toEqual([]);
    const own = await asA(async (tx) =>
      payoutMethods.forRecipients(tx, [...ids, a.first.recipientId]),
    );
    expect(own.map((method) => method.id)).toEqual([a.first.methodId]);
  },
  'payoutMethods.recordCheck': async () => {
    for (const other of foreign()) {
      expect(
        await asA(async (tx) =>
          payoutMethods.recordCheck(tx, other.methodId, {
            receivable: false,
            reason: 'NO_ACCOUNT',
          }),
        ),
      ).toBe(false);
      expect(await columnOf('ujira.payout_methods', 'destination_status', other.methodId)).toBe(
        'receivable',
      );
    }
  },
  'signingRequests.create': async () => {
    for (const other of foreign()) {
      const planted = asA(async (tx) =>
        signingRequests.create(tx, signingRequestFor(other.mandateId), testAccounts),
      );
      expect(await codeOf(planted)).toBe('23503');
    }
    const own = await asA(async (tx) =>
      signingRequests.create(tx, signingRequestFor(a.first.mandateId), testAccounts),
    );
    expect(await ownerOf('ujira.signing_requests', own.id)).toEqual(a.first.context);
  },
  'signingRequests.get': async () => {
    for (const other of foreign()) {
      expect(
        await asA(async (tx) => signingRequests.get(tx, other.signingRequestId)),
      ).toBeUndefined();
    }
    expect(
      await asA(async (tx) => signingRequests.get(tx, a.first.signingRequestId)),
    ).toBeDefined();
  },
  'signingRequests.markSubmitted': async () => {
    for (const other of foreign()) {
      expect(
        await asA(async (tx) =>
          signingRequests.markSubmitted(tx, other.signingRequestId, testHex32()),
        ),
      ).toBe(false);
      expect(
        await columnOf('ujira.signing_requests', 'submitted_tx_hash', other.signingRequestId),
      ).toBeNull();
    }
  },
  'payoutMethods.markVerified': async () => {
    for (const other of foreign()) {
      expect(await asA(async (tx) => payoutMethods.markVerified(tx, other.methodId))).toBe(false);
      expect(await columnOf('ujira.payout_methods', 'verified_at', other.methodId)).toBeNull();
    }
  },
};

beforeAll(async () => {
  database = await createTestDatabase(adminUrl, import.meta.url);
  admin = new pg.Client({ connectionString: database.url });
  await admin.connect();
  db = databaseAsServiceRoles(roleUrls, database);
  a = await world('alpha');
  b = await world('bravo');
});

afterAll(async () => {
  await db.close();
  await admin.end();
  await database.drop();
});

describe('across tenants', () => {
  it('has a case for every repository method, and no case without one', () => {
    expect(caseProblems(REPOSITORIES, Object.keys(cases))).toEqual([]);
  });

  it.each(Object.keys(cases))('%s cannot reach another tenant', async (name) => {
    const run = cases[name];
    if (run === undefined) throw new Error(`no case named ${name}`);
    await run();
  });

  it('refuses a row written for another tenant, whatever the caller names', async () => {
    const planted = asA(async (tx) =>
      tx
        .insertInto('ujira.recipients')
        .values({
          principal_id: b.first.context.principalId,
          project_id: b.first.context.projectId,
          mandate_id: b.first.mandateId,
          label: 'Planted',
          recipient_ref: Buffer.alloc(32, 1),
        })
        .execute(),
    );
    expect(await codeOf(planted)).toBe('42501');
  });
});
