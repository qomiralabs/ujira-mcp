// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The mandate store and the payout store on Postgres, as the services use
// them: each call one tenant transaction, a contract held by one project, and
// another project's rows reading as nothing.

import { randomBytes } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import {
  agentKeys,
  entryPoints,
  payoutMethods,
  recipients,
  unwiredJobQueue,
  type AccountParser,
  type Database,
  type NewMandate,
  type ProjectContext,
} from '../db/index.js';
import {
  createTestDatabase,
  databaseAsServiceRoles,
  testAccount,
  testContract,
  type TestDatabase,
} from '../db/testing/index.js';
import { MandateTakenError } from './mandate-store.js';
import { databasePayoutStore } from './payout-store.js';
import { postgresMandateStore } from './postgres-mandate-store.js';

const adminUrl = inject('dbAdminUrl');
const roleUrls = inject('dbRoleUrls');

const TESTNET = 'stellar:testnet';
// The database checks the shape; the adapter's own parsing is tested with it.
const accounts: AccountParser = { parseAccount: (raw) => raw.trim() };

let database: TestDatabase;
let db: Database;

beforeAll(async () => {
  database = await createTestDatabase(adminUrl, import.meta.url);
  db = databaseAsServiceRoles(roleUrls, database);
});

afterAll(async () => {
  await db.close();
  await database.drop();
});

interface Project {
  readonly context: ProjectContext;
  readonly owner: string;
  readonly keyId: string;
  readonly agent: string;
}

async function project(withKey = true): Promise<Project> {
  const owner = testAccount();
  const made = await db.unscoped((tx) =>
    entryPoints.createPrincipal(tx, { name: 'Acme', projectName: 'Main', ownerWallet: owner }),
  );
  const context = { principalId: made.principalId, projectId: made.projectId };
  const agent = testAccount();
  if (!withKey) return { context, owner, keyId: '', agent };
  const key = await db.tenant(context).transaction((tx) =>
    agentKeys.create(
      tx,
      {
        network: TESTNET,
        publicKey: agent,
        secretCiphertext: Buffer.alloc(48, 1),
        secretNonce: Buffer.alloc(12, 2),
      },
      accounts,
    ),
  );
  return { context, owner, keyId: key.id, agent };
}

function newMandate(p: Project, contractAddress = testContract()): NewMandate {
  return {
    name: 'Payroll',
    network: TESTNET,
    contractAddress,
    asset: 'USDC',
    scale: 7,
    agent: { keyId: p.keyId },
    principalWallet: p.owner,
  };
}

/** A recipient on the mandate, paid at a wallet unless told otherwise. */
async function recipientOn(p: Project, mandateId: string, label: string, wallet: boolean) {
  return db.tenant(p.context).transaction(async (tx) => {
    const r = await recipients.create(tx, {
      mandateId,
      label,
      recipientRef: randomBytes(32).toString('hex'),
    });
    const method = wallet
      ? await payoutMethods.addWallet(
          tx,
          {
            recipientId: r.id,
            destination: testAccount(),
            destinationCheck: { receivable: true },
            verified: false,
          },
          accounts,
        )
      : null;
    return { recipient: r, method };
  });
}

const store = () => postgresMandateStore(db, accounts);

/** A create for the project's owner to sign, naming the project's key. */
function createRequest(p: Project) {
  return store().createSigningRequest(p.context, {
    mandateId: null,
    action: 'create',
    network: TESTNET,
    signer: p.owner,
    envelope: 'AAAA',
    summary: 'Create a mandate',
    expiresAt: new Date(Date.now() + 600_000),
    mandateName: 'Payroll',
    agentKeyId: p.keyId,
  });
}

describe('the mandate store on Postgres', () => {
  it("finds the project's agent key, and none for a project without one", async () => {
    const keyed = await project();
    expect(await store().activeAgentKey(keyed.context, TESTNET)).toEqual({
      id: keyed.keyId,
      publicKey: keyed.agent,
    });
    const bare = await project(false);
    expect(await store().activeAgentKey(bare.context, TESTNET)).toBeUndefined();
  });

  it('attaches a contract once, finds it again, and refuses it to another project', async () => {
    const mine = await project();
    const theirs = await project();
    const input = newMandate(mine);
    const first = await store().addMandate(mine.context, input);
    expect(first.created).toBe(true);
    const again = await store().addMandate(mine.context, input);
    expect(again).toEqual({ mandate: first.mandate, created: false });
    await expect(
      store().addMandate(theirs.context, {
        ...newMandate(theirs),
        contractAddress: input.contractAddress,
      }),
    ).rejects.toBeInstanceOf(MandateTakenError);

    expect(await store().mandate(mine.context, first.mandate.id)).toEqual(first.mandate);
    expect(await store().mandate(theirs.context, first.mandate.id)).toBeUndefined();
    const listed = await store().mandates(mine.context, { limit: 10 });
    expect(listed.items.map((m) => m.id)).toEqual([first.mandate.id]);
  });

  it('passes on a refusal that is not a contract held elsewhere', async () => {
    const mine = await project();
    const theirs = await project();
    // Another project's key reads as nothing, so the row has no agent address.
    const borrowed = { ...newMandate(mine), agent: { keyId: theirs.keyId } };
    const failure = await store()
      .addMandate(mine.context, borrowed)
      .catch((error: unknown) => error);
    expect(failure).not.toBeInstanceOf(MandateTakenError);
    expect(['23502', '23503']).toContain((failure as { code?: string }).code);
  });

  it('reads recipients with the wallet each is paid at, only in their own project', async () => {
    const mine = await project();
    const theirs = await project();
    const { mandate } = await store().addMandate(mine.context, newMandate(mine));
    const paid = await recipientOn(mine, mandate.id, 'Ada', true);
    const unpaid = await recipientOn(mine, mandate.id, 'Grace', false);

    const found = await store().recipients(mine.context, [
      paid.recipient.id,
      unpaid.recipient.id,
      '7c9e6679-7425-40de-944b-e07fc1f90ae7',
    ]);
    expect(found.map((r) => [r.label, r.destination])).toEqual([
      ['Ada', paid.method?.destination],
      ['Grace', null],
    ]);
    expect(await store().recipients(theirs.context, [paid.recipient.id])).toEqual([]);

    const listed = await store().mandateRecipients(mine.context, mandate.id, 10);
    expect(listed.map((r) => r.label).sort()).toEqual(['Ada', 'Grace']);
    expect(await store().mandateRecipients(theirs.context, mandate.id, 10)).toEqual([]);

    expect(
      await store().payout(mine.context, '7c9e6679-7425-40de-944b-e07fc1f90ae7'),
    ).toBeUndefined();
  });

  it('keeps a signing request, marks it submitted once, and records the mandate a create made', async () => {
    const mine = await project();
    const theirs = await project();
    const contract = testContract();
    const request = await createRequest(mine);
    expect(await store().signingRequest(mine.context, request.id)).toEqual(request);
    expect(await store().signingRequest(theirs.context, request.id)).toBeUndefined();

    const txHash = randomBytes(32).toString('hex');
    const made = await store().recordCreated(mine.context, request.id, txHash, {
      ...newMandate(mine, contract),
      createdTxHash: txHash,
    });
    expect(made).toMatchObject({ contractAddress: contract, createdTxHash: txHash });
    expect((await store().signingRequest(mine.context, request.id))?.submittedTxHash).toBe(txHash);

    // A retry of the same create finds the row it made.
    const second = await createRequest(mine);
    const retried = await store().recordCreated(mine.context, second.id, txHash, {
      ...newMandate(mine, contract),
      createdTxHash: txHash,
    });
    expect(retried.id).toBe(made.id);
    expect(await store().markSubmitted(mine.context, second.id, txHash)).toBe(false);

    const theirsRequest = await createRequest(theirs);
    await expect(
      store().recordCreated(theirs.context, theirsRequest.id, txHash, newMandate(theirs, contract)),
    ).rejects.toBeInstanceOf(MandateTakenError);
    const broken = store().recordCreated(theirs.context, theirsRequest.id, txHash, {
      ...newMandate(theirs),
      agent: { keyId: mine.keyId },
    });
    const brokenFailure = await broken.catch((error: unknown) => error);
    expect(brokenFailure).not.toBeInstanceOf(MandateTakenError);
    expect(['23502', '23503']).toContain((brokenFailure as { code?: string }).code);
  });
});

describe('the payout store on Postgres', () => {
  it('records what the chain said of a destination, and finds no target across mandates', async () => {
    const mine = await project();
    const { mandate } = await store().addMandate(mine.context, newMandate(mine));
    const other = await store().addMandate(mine.context, newMandate(mine));
    const { recipient, method } = await recipientOn(mine, mandate.id, 'Ada', true);
    if (method === null) throw new Error('expected a wallet');
    const payouts = databasePayoutStore(db, unwiredJobQueue);

    await payouts.recordCheck(mine.context, method.id, {
      receivable: false,
      reason: 'NO_TRUSTLINE',
    });
    const [checked] = await db
      .tenant(mine.context)
      .transaction((tx) => payoutMethods.forRecipients(tx, [recipient.id]));
    expect(checked?.destinationStatus).toBe('no_trustline');

    expect(await payouts.target(mine.context, other.mandate.id, recipient.id)).toEqual({
      mandate: other.mandate,
      recipient: undefined,
      method: null,
    });
    expect(await payouts.hasTask(mine.context, mandate.id, 'task-1')).toBe(false);
  });
});
