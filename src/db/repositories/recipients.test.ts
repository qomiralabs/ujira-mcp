// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// Recipients, their sealed email and their payout methods against a real
// database, as the app writes them and the reader shows them.

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
import { mandates } from './mandates.js';
import {
  PayoutMethodRefusedError,
  payoutMethods,
  recipientPii,
  recipients,
  type NewWalletMethod,
  type Recipient,
} from './recipients.js';
import { RepositoryInputError } from './values.js';

const adminUrl = inject('dbAdminUrl');
const roleUrls = inject('dbRoleUrls');

let database: TestDatabase;
let admin: pg.Client;
let db: Database;
let tenant: ProjectContext;
let mandateId: string;
let otherMandateId: string;

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

async function makeMandate(): Promise<string> {
  const mandate = await db.tenant(tenant).transaction(async (tx) =>
    mandates.create(
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
    ),
  );
  return mandate.id;
}

async function addRecipient(label: string, mandate = mandateId): Promise<Recipient> {
  return db
    .tenant(tenant)
    .transaction(async (tx) =>
      recipients.create(tx, { mandateId: mandate, label, recipientRef: testHex32() }),
    );
}

function wallet(recipientId: string, overrides: Partial<NewWalletMethod> = {}): NewWalletMethod {
  return {
    recipientId,
    destination: testAccount(),
    destinationCheck: { receivable: true },
    verified: false,
    ...overrides,
  };
}

async function count(table: string): Promise<number> {
  const counted = await admin.query<{ count: string }>(
    `select count(*)::text as count from ${table} where principal_id = $1`,
    [tenant.principalId],
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
  mandateId = await makeMandate();
  otherMandateId = await makeMandate();
});

afterAll(async () => {
  await db.close();
  await admin.end();
  await database.drop();
});

describe('recipients', () => {
  it('adds a recipient, reads it back, and finds it by label in any case', async () => {
    const recipientRef = testHex32();
    const ada = await db
      .tenant(tenant)
      .transaction(async (tx) => recipients.create(tx, { mandateId, label: 'Ada', recipientRef }));
    expect(ada).toEqual({
      id: expect.any(String) as string,
      projectId: tenant.projectId,
      mandateId,
      label: 'Ada',
      recipientRef,
      status: 'active',
      createdAt: expect.any(Date) as Date,
    });
    const stored = await admin.query<{ recipient_ref: Buffer }>(
      'select recipient_ref from ujira.recipients where id = $1',
      [ada.id],
    );
    expect(stored.rows[0]?.recipient_ref.equals(Buffer.from(recipientRef, 'hex'))).toBe(true);
    expect(await db.tenant(tenant).transaction(async (tx) => recipients.get(tx, ada.id))).toEqual(
      ada,
    );
    expect(
      await db
        .tenant(tenant)
        .transaction(async (tx) => recipients.findByLabel(tx, mandateId, 'aDA')),
    ).toEqual(ada);
    expect(
      await db
        .tenant(tenant)
        .transaction(async (tx) => recipients.findByLabel(tx, otherMandateId, 'Ada')),
    ).toBeUndefined();
  });

  it('keeps a label unique per mandate in any case, and lets another mandate use it', async () => {
    await addRecipient('Ada');
    expect(await codeOf(addRecipient('Ada'))).toBe('23505');
    expect(await codeOf(addRecipient('ADA'))).toBe('23505');
    await addRecipient('Ada', otherMandateId);
  });

  it('keeps a recipient ref unique per mandate', async () => {
    const recipientRef = testHex32();
    await db
      .tenant(tenant)
      .transaction(async (tx) => recipients.create(tx, { mandateId, label: 'Ada', recipientRef }));
    const again = db
      .tenant(tenant)
      .transaction(async (tx) => recipients.create(tx, { mandateId, label: 'Bo', recipientRef }));
    expect(await codeOf(again)).toBe('23505');
  });

  it('refuses a label with space around it or a control character, and a ref that is not hex', async () => {
    expect(await codeOf(addRecipient(' Ada'))).toBe('23514');
    expect(await codeOf(addRecipient('Ada\u0007'))).toBe('23514');
    expect(await codeOf(addRecipient(''))).toBe('23514');
    expect(await codeOf(addRecipient('x'.repeat(101)))).toBe('23514');
    await expect(
      db
        .tenant(tenant)
        .transaction(async (tx) =>
          recipients.create(tx, { mandateId, label: 'Ada', recipientRef: 'zz' }),
        ),
    ).rejects.toEqual(new RepositoryInputError('recipientRef'));
    expect(await count('ujira.recipients')).toBe(0);
  });

  it('suspends and restores a recipient, and holds no status the machine does not know', async () => {
    const ada = await addRecipient('Ada');
    expect(
      await db
        .tenant(tenant)
        .transaction(async (tx) => recipients.setStatus(tx, ada.id, 'suspended')),
    ).toBe(true);
    expect(
      (await db.tenant(tenant).transaction(async (tx) => recipients.get(tx, ada.id)))?.status,
    ).toBe('suspended');
    expect(
      await db.tenant(tenant).transaction(async (tx) => recipients.setStatus(tx, ada.id, 'active')),
    ).toBe(true);
    const erased = db
      .tenant(tenant)
      .transaction(async (tx) =>
        tx
          .updateTable('ujira.recipients')
          .set({ status: 'erased' })
          .where('id', '=', ada.id)
          .execute(),
      );
    expect(await codeOf(erased)).toBe('UJ004');
  });

  it('lists one mandate recipients in pages', async () => {
    const made = [await addRecipient('A'), await addRecipient('B'), await addRecipient('C')];
    await addRecipient('Elsewhere', otherMandateId);
    const ids = made.map((recipient) => recipient.id).sort();
    const first = await db
      .tenant(tenant)
      .transaction(async (tx) => recipients.list(tx, mandateId, { limit: 2 }));
    expect(first.items.map((recipient) => recipient.id)).toEqual(ids.slice(0, 2));
    const rest = await db
      .tenant(tenant)
      .transaction(async (tx) =>
        recipients.list(tx, mandateId, { limit: 2, after: first.next ?? '' }),
      );
    expect(rest.items.map((recipient) => recipient.id)).toEqual(ids.slice(2));
    expect(rest.next).toBeNull();
  });

  it('never lets the app move a recipient to another mandate or ref', async () => {
    const ada = await addRecipient('Ada');
    const moved = db
      .tenant(tenant)
      .transaction(async (tx) =>
        tx
          .updateTable('ujira.recipients')
          .set({ mandate_id: otherMandateId })
          .where('id', '=', ada.id)
          .execute(),
      );
    expect(await codeOf(moved)).toBe('42501');
  });
});

describe('recipient email', () => {
  it('keeps one sealed email per recipient and replaces it', async () => {
    const ada = await addRecipient('Ada');
    expect(
      await db.tenant(tenant).transaction(async (tx) => recipientPii.email(tx, ada.id)),
    ).toBeUndefined();
    await db
      .tenant(tenant)
      .transaction(async (tx) =>
        recipientPii.setEmail(tx, ada.id, { ciphertext: sealed(1), nonce: nonce(2) }),
      );
    await db
      .tenant(tenant)
      .transaction(async (tx) =>
        recipientPii.setEmail(tx, ada.id, { ciphertext: sealed(3, 40), nonce: nonce(4) }),
      );
    expect(
      await db.tenant(tenant).transaction(async (tx) => recipientPii.email(tx, ada.id)),
    ).toEqual({ ciphertext: sealed(3, 40), nonce: nonce(4) });
    expect(await count('ujira.recipient_pii')).toBe(1);
  });

  it('is out of the reader reach', async () => {
    const ada = await addRecipient('Ada');
    expect(
      await codeOf(
        db.principal(tenant, 'reader').transaction(async (tx) => recipientPii.email(tx, ada.id)),
      ),
    ).toBe('42501');
  });

  it('refuses a nonce that is not 12 bytes', async () => {
    const ada = await addRecipient('Ada');
    const written = db
      .tenant(tenant)
      .transaction(async (tx) =>
        recipientPii.setEmail(tx, ada.id, { ciphertext: sealed(1), nonce: Buffer.alloc(8) }),
      );
    expect(await codeOf(written)).toBe('23514');
  });
});

describe('payout methods', () => {
  it('stores the address the adapter returns, and records the proof once', async () => {
    const ada = await addRecipient('Ada');
    const destination = testAccount();
    const method = await db
      .tenant(tenant)
      .transaction(async (tx) =>
        payoutMethods.addWallet(
          tx,
          wallet(ada.id, { destination: `\t${destination} ` }),
          testAccounts,
        ),
      );
    expect(method).toEqual({
      id: expect.any(String) as string,
      projectId: tenant.projectId,
      recipientId: ada.id,
      method: 'stellar_wallet',
      destination,
      verifiedAt: null,
      createdAt: expect.any(Date) as Date,
    });
    expect(
      await db.tenant(tenant).transaction(async (tx) => payoutMethods.markVerified(tx, method.id)),
    ).toBe(true);
    const proven = await db
      .tenant(tenant)
      .transaction(async (tx) => payoutMethods.get(tx, method.id));
    expect(proven?.verifiedAt).toBeInstanceOf(Date);
    expect(
      await db.tenant(tenant).transaction(async (tx) => payoutMethods.markVerified(tx, method.id)),
    ).toBe(false);

    for (const verifiedAt of [null, new Date('2020-01-01T00:00:00Z')]) {
      const rewritten = db
        .tenant(tenant)
        .transaction(async (tx) =>
          tx
            .updateTable('ujira.payout_methods')
            .set({ verified_at: verifiedAt })
            .where('id', '=', method.id)
            .execute(),
        );
      expect(await codeOf(rewritten)).toBe('UJ006');
    }
  });

  it('adds a wallet already proven', async () => {
    const ada = await addRecipient('Ada');
    const method = await db
      .tenant(tenant)
      .transaction(async (tx) =>
        payoutMethods.addWallet(tx, wallet(ada.id, { verified: true }), testAccounts),
      );
    expect(method.verifiedAt).toBeInstanceOf(Date);
  });

  it('refuses a destination that needs a memo, and writes nothing', async () => {
    const ada = await addRecipient('Ada');
    const refused = db
      .tenant(tenant)
      .transaction(async (tx) =>
        payoutMethods.addWallet(
          tx,
          wallet(ada.id, { destinationCheck: { receivable: false, reason: 'NEEDS_MEMO' } }),
          testAccounts,
        ),
      );
    await expect(refused).rejects.toEqual(new PayoutMethodRefusedError('DESTINATION_NEEDS_MEMO'));
    await expect(refused).rejects.toHaveProperty('code', 'DESTINATION_NEEDS_MEMO');
    expect(await count('ujira.payout_methods')).toBe(0);
  });

  it('keeps a destination that has no account or trustline yet', async () => {
    const ada = await addRecipient('Ada');
    for (const reason of ['NO_ACCOUNT', 'NO_TRUSTLINE'] as const) {
      await db
        .tenant(tenant)
        .transaction(async (tx) =>
          payoutMethods.addWallet(
            tx,
            wallet(ada.id, { destinationCheck: { receivable: false, reason } }),
            testAccounts,
          ),
        );
    }
    expect(await count('ujira.payout_methods')).toBe(2);
  });

  it('refuses an address the adapter refuses, before any row is written', async () => {
    const ada = await addRecipient('Ada');
    const refused = db
      .tenant(tenant)
      .transaction(async (tx) =>
        payoutMethods.addWallet(tx, wallet(ada.id, { destination: testContract() }), testAccounts),
      );
    await expect(refused).rejects.toBeInstanceOf(TestAddressError);
    expect(await count('ujira.payout_methods')).toBe(0);
  });

  it('keeps a destination unique per recipient and method', async () => {
    const ada = await addRecipient('Ada');
    const bo = await addRecipient('Bo');
    const destination = testAccount();
    await db
      .tenant(tenant)
      .transaction(async (tx) =>
        payoutMethods.addWallet(tx, wallet(ada.id, { destination }), testAccounts),
      );
    const again = db
      .tenant(tenant)
      .transaction(async (tx) =>
        payoutMethods.addWallet(
          tx,
          wallet(ada.id, { destination: ` ${destination}` }),
          testAccounts,
        ),
      );
    expect(await codeOf(again)).toBe('23505');
    // Two people may share a wallet; each is paid as themselves.
    await db
      .tenant(tenant)
      .transaction(async (tx) =>
        payoutMethods.addWallet(tx, wallet(bo.id, { destination }), testAccounts),
      );
  });

  it('holds only the wallet method until a partner rail adds its own', async () => {
    const ada = await addRecipient('Ada');
    const partner = db.tenant(tenant).transaction(async (tx) =>
      tx
        .insertInto('ujira.payout_methods')
        .values({
          principal_id: tenant.principalId,
          project_id: tenant.projectId,
          recipient_id: ada.id,
          method: 'mobile_money',
          destination_address: 'ref123',
        })
        .execute(),
    );
    expect(await codeOf(partner)).toBe('23514');
  });

  it('lists one recipient methods in pages, and never moves a destination', async () => {
    const ada = await addRecipient('Ada');
    const bo = await addRecipient('Bo');
    const made = [];
    for (let index = 0; index < 3; index += 1) {
      made.push(
        await db
          .tenant(tenant)
          .transaction(async (tx) => payoutMethods.addWallet(tx, wallet(ada.id), testAccounts)),
      );
    }
    await db
      .tenant(tenant)
      .transaction(async (tx) => payoutMethods.addWallet(tx, wallet(bo.id), testAccounts));
    const ids = made.map((method) => method.id).sort();
    const first = await db
      .tenant(tenant)
      .transaction(async (tx) => payoutMethods.list(tx, ada.id, { limit: 2 }));
    expect(first.items.map((method) => method.id)).toEqual(ids.slice(0, 2));
    const rest = await db
      .tenant(tenant)
      .transaction(async (tx) =>
        payoutMethods.list(tx, ada.id, { limit: 2, after: first.next ?? '' }),
      );
    expect(rest.items.map((method) => method.id)).toEqual(ids.slice(2));
    expect(rest.next).toBeNull();

    const target = made[0];
    if (target === undefined) throw new Error('no method made');
    const moved = db
      .tenant(tenant)
      .transaction(async (tx) =>
        tx
          .updateTable('ujira.payout_methods')
          .set({ destination_address: testAccount() })
          .where('id', '=', target.id)
          .execute(),
      );
    expect(await codeOf(moved)).toBe('42501');
  });
});
