// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The recipient routes end to end: the /v1 app, the recipient service, the
// real database as the app role, and the Stellar adapter on the fake RPC and
// an in-memory network. Two principals, the first with two projects, so every
// route is also run across tenants.

import { randomBytes, randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { FakeNetwork } from '../../../test/fake-network.js';
import { ASSET, FakeMandateRpc, MANDATE, principal, testSigner } from '../../../test/fake-rpc.js';
import { ChainError } from '../../chain/adapter.js';
import { StellarChainAdapter } from '../../chain/stellar/adapter.js';
import {
  agentKeys,
  entryPoints,
  mandates,
  payoutMethods,
  projects,
  recipientPii,
  recipients,
  signingRequests,
  type Database,
  type ProjectContext,
} from '../../db/index.js';
import {
  createTestDatabase,
  databaseAsServiceRoles,
  type TestDatabase,
} from '../../db/testing/index.js';
import { createSealer } from '../../keys/sealer.js';
import { createRecipientService, emailAssociatedData } from '../../payouts/recipients.js';
import { createV1App } from '../app.js';
import { errorEnvelopeSchema } from '../errors.js';
import { recipientRoutes } from './recipients.js';

const adminUrl = inject('dbAdminUrl');
const roleUrls = inject('dbRoleUrls');

const FACTORY = 'CB4AYBA5NVQPVPNOWUCSZQK6ZIGOF7KSCS6SF6UV6D2OKPDXLHEPD4V7';
const ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
const USDC = `USDC:${ISSUER}`;
const TESTNET = 'stellar:testnet';

interface Tenant {
  readonly context: ProjectContext;
  readonly mandateId: string;
}

let database: TestDatabase;
let db: Database;
let rpc: FakeMandateRpc;
let network: FakeNetwork;
let adapter: StellarChainAdapter;
const sealer = createSealer(randomBytes(32).toString('base64'));
const logged: string[] = [];

// A on the mandate the fake RPC serves; A's second project and B elsewhere.
let a: Tenant;
let aSecond: Tenant;
let b: Tenant;

let seed = 0;
function wallet(): string {
  seed += 1;
  return testSigner(`recipient-${String(seed)}-${randomUUID()}`).publicKey;
}

function receivable(address: string): string {
  network.facts.set(address, { exists: true, trustlines: [USDC], memoRequired: false });
  return address;
}

async function mandateFor(
  context: ProjectContext,
  contractAddress: string,
  networkId = TESTNET,
): Promise<string> {
  return db.tenant(context).transaction(async (tx) => {
    const key = await agentKeys.create(
      tx,
      {
        network: networkId,
        publicKey: wallet(),
        secretCiphertext: Buffer.alloc(48, 1),
        secretNonce: Buffer.alloc(12, 2),
      },
      adapter,
    );
    const mandate = await mandates.create(
      tx,
      {
        name: 'Payroll',
        network: networkId,
        contractAddress,
        asset: 'USDC',
        scale: 7,
        agent: { keyId: key.id },
        principalWallet: principal.publicKey,
      },
      adapter,
    );
    return mandate.id;
  });
}

async function newPrincipal(name: string): Promise<ProjectContext> {
  const created = await db.unscoped((tx) =>
    entryPoints.createPrincipal(tx, { name, projectName: 'Main', ownerWallet: wallet() }),
  );
  return { principalId: created.principalId, projectId: created.projectId };
}

function appFor(context: ProjectContext, chainTimeoutMs?: number) {
  const service = createRecipientService({
    db,
    chain: adapter,
    sealer,
    destinationAsset: () => USDC,
    ...(chainTimeoutMs === undefined ? {} : { chainTimeoutMs }),
    log: (line) => logged.push(line),
  });
  const { app } = createV1App({
    routes: recipientRoutes({ service, authenticate: () => Promise.resolve(context) }),
  });
  const send = async (path: string, init: RequestInit = {}) => {
    const response = await app.request(path, init);
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
  return {
    send,
    post: (body: unknown) =>
      send('/v1/recipients', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
  };
}

function codeOf(body: Record<string, unknown>): string {
  return errorEnvelopeSchema.parse(body).error.code;
}

interface CreatedBody {
  readonly recipient: {
    readonly id: string;
    readonly status: string;
    readonly payable: boolean;
    readonly address: string | null;
  };
  readonly signingRequest: { readonly id: string; readonly signer: string } | null;
}

beforeAll(async () => {
  database = await createTestDatabase(adminUrl, import.meta.url);
  db = databaseAsServiceRoles(roleUrls, database);
  rpc = new FakeMandateRpc();
  network = new FakeNetwork();
  adapter = new StellarChainAdapter({
    gateway: rpc,
    chain: network,
    factory: FACTORY,
    asset: { code: 'USDC', issuer: ISSUER, contract: ASSET },
  });
  const first = await newPrincipal('Alpha');
  const second = {
    principalId: first.principalId,
    projectId: await db.tenant(first).transaction((tx) => projects.create(tx, { name: 'Two' })),
  };
  const other = await newPrincipal('Bravo');
  a = { context: first, mandateId: await mandateFor(first, MANDATE) };
  aSecond = { context: second, mandateId: await mandateFor(second, FACTORY) };
  b = { context: other, mandateId: await mandateFor(other, ASSET) };
});

afterAll(async () => {
  await db.close();
  await database.drop();
});

describe('POST /v1/recipients', () => {
  it('saves a recipient with a wallet that can receive, and the allow_recipients request', async () => {
    const address = receivable(wallet());
    const answer = await appFor(a.context).post({
      mandateId: a.mandateId,
      label: 'Receivable',
      address,
    });
    expect(answer.status).toBe(201);
    const body = answer.body as unknown as CreatedBody;
    expect(body.recipient).toMatchObject({ status: 'active', payable: true });
    expect(body.recipient.address).toBe(`${address.slice(0, 4)}...${address.slice(-4)}`);
    // The principal is whoever the chain names, not anything the caller said.
    expect(body.signingRequest?.signer).toBe(principal.publicKey);
    const stored = await db
      .tenant(a.context)
      .transaction((tx) => signingRequests.get(tx, body.signingRequest?.id ?? ''));
    expect(stored).toMatchObject({
      mandateId: a.mandateId,
      action: 'allow_recipients',
      network: TESTNET,
      signer: principal.publicKey,
      submittedTxHash: null,
    });
    expect(answer.body['signingRequest']).toMatchObject({
      xdr: stored?.envelope,
      expiresAt: stored?.expiresAt.toISOString(),
    });
  });

  it.each([
    ['no_trustline', { exists: true, trustlines: [], memoRequired: false }],
    ['no_account', undefined],
  ] as const)(
    'saves a wallet that cannot receive as %s, not payable, still with its signing request',
    async (status, facts) => {
      const address = wallet();
      if (facts !== undefined) network.facts.set(address, facts);
      const answer = await appFor(a.context).post({
        mandateId: a.mandateId,
        label: `Cannot ${status}`,
        address,
      });
      expect(answer.status).toBe(201);
      const body = answer.body as unknown as CreatedBody;
      expect(body.recipient).toMatchObject({ status, payable: false });
      expect(body.signingRequest).not.toBeNull();
      const methods = await db
        .tenant(a.context)
        .transaction((tx) => payoutMethods.forRecipients(tx, [body.recipient.id]));
      expect(methods.map((m) => m.destinationStatus)).toEqual([status]);
    },
  );

  it('refuses a wallet that needs a memo and writes nothing', async () => {
    const address = wallet();
    network.facts.set(address, { exists: true, trustlines: [USDC], memoRequired: true });
    const answer = await appFor(a.context).post({
      mandateId: a.mandateId,
      label: 'Exchange',
      address,
    });
    expect(answer.status).toBe(400);
    expect(errorEnvelopeSchema.parse(answer.body).error.details).toEqual([
      { path: 'body.address', issue: 'needs_memo' },
    ]);
    const found = await db
      .tenant(a.context)
      .transaction((tx) => recipients.findByLabel(tx, a.mandateId, 'Exchange'));
    expect(found).toBeUndefined();
  });

  it('refuses an address that is not an account, before any chain call', async () => {
    const calls = network.calls.length;
    const answer = await appFor(a.context).post({
      mandateId: a.mandateId,
      label: 'Typo',
      address: `${wallet().slice(0, -1)}A`,
    });
    expect(answer.status).toBe(400);
    expect(errorEnvelopeSchema.parse(answer.body).error.details).toEqual([
      { path: 'body.address', issue: 'invalid_address' },
    ]);
    expect(network.calls).toHaveLength(calls);
  });

  it('saves a recipient with no wallet and no signing request, without asking the chain', async () => {
    const calls = network.calls.length;
    const answer = await appFor(a.context).post({ mandateId: a.mandateId, label: 'No wallet' });
    expect(answer.status).toBe(201);
    expect(answer.body).toMatchObject({
      recipient: { status: 'needs_wallet', payable: false, address: null },
      signingRequest: null,
    });
    expect(network.calls).toHaveLength(calls);
  });

  it('answers 409 to a label already on the mandate, in any case', async () => {
    const app = appFor(a.context);
    expect((await app.post({ mandateId: a.mandateId, label: 'Grace' })).status).toBe(201);
    const again = await app.post({ mandateId: a.mandateId, label: 'GRACE' });
    expect(again.status).toBe(409);
    expect(codeOf(again.body)).toBe('RECIPIENT_LABEL_TAKEN');
    // The same label on another mandate is someone else.
    const elsewhere = await appFor(aSecond.context).post({
      mandateId: aSecond.mandateId,
      label: 'Grace',
    });
    expect(elsewhere.status).toBe(201);
  });

  it('lets exactly one of two racing creates with one label through', async () => {
    const app = appFor(a.context);
    const answers = await Promise.all(
      [1, 2, 3].map(() => app.post({ mandateId: a.mandateId, label: 'Racer' })),
    );
    expect(answers.map((x) => x.status).sort()).toEqual([201, 409, 409]);
    for (const loser of answers.filter((x) => x.status === 409)) {
      expect(codeOf(loser.body)).toBe('RECIPIENT_LABEL_TAKEN');
    }
  });

  it('answers 404 for a mandate that does not exist', async () => {
    const answer = await appFor(a.context).post({ mandateId: randomUUID(), label: 'Nobody' });
    expect(answer.status).toBe(404);
    expect(codeOf(answer.body)).toBe('NOT_FOUND');
  });

  it('answers 503 and writes nothing when the chain is down or silent', async () => {
    const address = receivable(wallet());
    try {
      network.down = true;
      const down = await appFor(a.context).post({ mandateId: a.mandateId, label: 'Down', address });
      expect(down.status).toBe(503);
      expect(codeOf(down.body)).toBe('CHAIN_UNAVAILABLE');
      network.down = false;
      network.silent = true;
      const silent = await appFor(a.context, 200).post({
        mandateId: a.mandateId,
        label: 'Down',
        address,
      });
      expect(silent.status).toBe(503);
      expect(codeOf(silent.body)).toBe('CHAIN_UNAVAILABLE');
    } finally {
      network.down = false;
      network.silent = false;
    }
    const found = await db
      .tenant(a.context)
      .transaction((tx) => recipients.findByLabel(tx, a.mandateId, 'Down'));
    expect(found).toBeUndefined();
    // Nothing was half written, so the same request now goes through.
    const retried = await appFor(a.context).post({
      mandateId: a.mandateId,
      label: 'Down',
      address,
    });
    expect(retried.status).toBe(201);
  });

  it('answers 409 MANDATE_REFUSED when the mandate refuses the allowlist change', async () => {
    const original = network.prepare.bind(network);
    network.prepare = () =>
      Promise.reject(
        new ChainError('CONTRACT_REFUSED', 'refused', { specError: 'MANDATE_REVOKED' }),
      );
    try {
      const answer = await appFor(a.context).post({
        mandateId: a.mandateId,
        label: 'Refused',
        address: receivable(wallet()),
      });
      expect(answer.status).toBe(409);
      expect(errorEnvelopeSchema.parse(answer.body).error).toMatchObject({
        code: 'MANDATE_REFUSED',
        details: [{ path: 'mandate', issue: 'mandate_revoked' }],
      });
    } finally {
      network.prepare = original;
    }
  });

  it('refuses a mandate on a network this server does not serve', async () => {
    const pubnet = await mandateFor(a.context, `C${'A'.repeat(55)}`, 'stellar:pubnet');
    const answer = await appFor(a.context).post({
      mandateId: pubnet,
      label: 'Elsewhere',
      address: receivable(wallet()),
    });
    expect(answer.status).toBe(409);
    expect(codeOf(answer.body)).toBe('MANDATE_REFUSED');
  });
});

describe('emails', () => {
  it('are stored sealed to the recipient, shown in its detail and never in a list', async () => {
    const email = 'ada.lovelace@example.org';
    const app = appFor(a.context);
    const created = await app.post({ mandateId: a.mandateId, label: 'Ada', email });
    expect(created.status).toBe(201);
    expect(JSON.stringify(created.body)).not.toContain(email);
    const id = (created.body as unknown as CreatedBody).recipient.id;

    const sealed = await db.tenant(a.context).transaction((tx) => recipientPii.email(tx, id));
    if (sealed === undefined) throw new Error('no sealed email stored');
    expect(sealed.ciphertext.includes(Buffer.from(email))).toBe(false);
    expect(sealer.open(sealed, emailAssociatedData(a.context, id)).toString()).toBe(email);

    const detail = await app.send(`/v1/recipients/${id}`);
    expect(detail.body).toMatchObject({ recipient: { id, email } });

    const list = await app.send(`/v1/recipients?mandateId=${a.mandateId}&limit=100`);
    expect(JSON.stringify(list.body)).not.toContain(email);
    expect(JSON.stringify(list.body)).toContain(id);
  });

  it('answers null for a recipient without one', async () => {
    const app = appFor(a.context);
    const created = await app.post({ mandateId: a.mandateId, label: 'No email' });
    const id = (created.body as unknown as CreatedBody).recipient.id;
    expect((await app.send(`/v1/recipients/${id}`)).body).toMatchObject({
      recipient: { email: null },
    });
  });
});

describe('GET /v1/recipients/{id}', () => {
  it('asks the chain again about a wallet that could not receive, and keeps the answer', async () => {
    const address = wallet();
    network.facts.set(address, { exists: true, trustlines: [], memoRequired: false });
    const app = appFor(a.context);
    const created = await app.post({ mandateId: a.mandateId, label: 'Fixes later', address });
    const id = (created.body as unknown as CreatedBody).recipient.id;

    // Still no trustline: unchanged.
    expect((await app.send(`/v1/recipients/${id}`)).body).toMatchObject({
      recipient: { status: 'no_trustline', payable: false },
    });

    receivable(address);
    expect((await app.send(`/v1/recipients/${id}`)).body).toMatchObject({
      recipient: { status: 'active', payable: true },
    });
    const list = await app.send(`/v1/recipients?mandateId=${a.mandateId}&limit=100`);
    const items = (list.body as { items: { id: string; status: string }[] }).items;
    expect(items.find((item) => item.id === id)?.status).toBe('active');
  });

  it('keeps the stored answer, and logs no address, when the chain does not reply', async () => {
    const address = wallet();
    network.facts.set(address, { exists: false, trustlines: [], memoRequired: false });
    const app = appFor(a.context, 200);
    const created = await app.post({ mandateId: a.mandateId, label: 'Quiet chain', address });
    const id = (created.body as unknown as CreatedBody).recipient.id;
    network.silent = true;
    try {
      const detail = await app.send(`/v1/recipients/${id}`);
      expect(detail.status).toBe(200);
      expect(detail.body).toMatchObject({ recipient: { status: 'no_account' } });
    } finally {
      network.silent = false;
    }
    expect(
      logged.some((line) => line.startsWith('event=recipient_destination_recheck_failed')),
    ).toBe(true);
    expect(logged.join('\n')).not.toContain(address);
  });

  it('does not store a wallet that now needs a memo as payable', async () => {
    const address = wallet();
    network.facts.set(address, { exists: true, trustlines: [], memoRequired: false });
    const app = appFor(a.context);
    const created = await app.post({ mandateId: a.mandateId, label: 'Now an exchange', address });
    const id = (created.body as unknown as CreatedBody).recipient.id;
    network.facts.set(address, { exists: true, trustlines: [USDC], memoRequired: true });
    expect((await app.send(`/v1/recipients/${id}`)).body).toMatchObject({
      recipient: { status: 'no_trustline', payable: false },
    });
  });

  it('answers 404 for an id that is no recipient', async () => {
    const answer = await appFor(a.context).send(`/v1/recipients/${randomUUID()}`);
    expect(answer.status).toBe(404);
  });
});

describe('GET /v1/recipients', () => {
  it('pages through a mandate in a stable order with the cursor it hands out', async () => {
    const app = appFor(aSecond.context);
    for (const name of ['P1', 'P2', 'P3']) {
      expect((await app.post({ mandateId: aSecond.mandateId, label: name })).status).toBe(201);
    }
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const query: string =
        cursor === null ? 'limit=2' : `limit=2&cursor=${encodeURIComponent(cursor)}`;
      const page = await app.send(`/v1/recipients?mandateId=${aSecond.mandateId}&${query}`);
      expect(page.status).toBe(200);
      const body = page.body as { items: { id: string }[]; nextCursor: string | null };
      expect(body.items.length).toBeLessThanOrEqual(2);
      seen.push(...body.items.map((item) => item.id));
      cursor = body.nextCursor;
    } while (cursor !== null);
    expect(new Set(seen).size).toBe(seen.length);
    const all = await app.send(`/v1/recipients?limit=100`);
    const ids = (all.body as { items: { id: string }[] }).items.map((item) => item.id);
    expect(ids).toEqual([...seen].sort());
  });
});

// Every route as tenant A against the rows of A's other project and of
// another principal. None of them may find, list or write anything there.
describe('across tenants', () => {
  let foreign: { tenant: Tenant; recipientId: string }[];

  // Written through the repositories, since the fake RPC serves only A's
  // contract and these rows need a wallet and an email to be worth hiding.
  beforeAll(async () => {
    foreign = [];
    for (const tenant of [aSecond, b]) {
      const recipientId = await db.tenant(tenant.context).transaction(async (tx) => {
        const recipient = await recipients.create(tx, {
          mandateId: tenant.mandateId,
          label: 'Private',
          recipientRef: randomBytes(32).toString('hex'),
        });
        await recipientPii.setEmail(
          tx,
          recipient.id,
          sealer.seal(
            Buffer.from('private@example.org'),
            emailAssociatedData(tenant.context, recipient.id),
          ),
        );
        await payoutMethods.addWallet(
          tx,
          {
            recipientId: recipient.id,
            destination: wallet(),
            destinationCheck: { receivable: true },
            verified: false,
          },
          adapter,
        );
        return recipient.id;
      });
      foreign.push({ tenant, recipientId });
    }
  });

  const cases: Record<string, () => Promise<void>> = {
    createRecipient: async () => {
      for (const { tenant } of foreign) {
        const answer = await appFor(a.context).post({
          mandateId: tenant.mandateId,
          label: 'Planted',
          address: receivable(wallet()),
        });
        expect(answer.status).toBe(404);
        const planted = await db
          .tenant(tenant.context)
          .transaction((tx) => recipients.findByLabel(tx, tenant.mandateId, 'Planted'));
        expect(planted).toBeUndefined();
      }
    },
    listRecipients: async () => {
      const app = appFor(a.context);
      const all = JSON.stringify((await app.send('/v1/recipients?limit=100')).body);
      for (const { tenant, recipientId } of foreign) {
        expect(all).not.toContain(recipientId);
        const named = await app.send(`/v1/recipients?mandateId=${tenant.mandateId}`);
        expect(named.status).toBe(200);
        expect(named.body).toEqual({ items: [], nextCursor: null });
      }
    },
    getRecipient: async () => {
      for (const { recipientId } of foreign) {
        const answer = await appFor(a.context).send(`/v1/recipients/${recipientId}`);
        expect(answer.status).toBe(404);
        expect(JSON.stringify(answer.body)).not.toContain('private@example.org');
      }
    },
  };

  it('has a case for every recipient route', () => {
    const routes = recipientRoutes({
      service: createRecipientService({
        db,
        chain: adapter,
        sealer,
        destinationAsset: () => USDC,
      }),
      authenticate: () => Promise.resolve(a.context),
    });
    expect(routes.map((route) => route.operationId).sort()).toEqual(Object.keys(cases).sort());
  });

  it.each(Object.keys(cases))('%s cannot reach another tenant', async (name) => {
    const run = cases[name];
    if (run === undefined) throw new Error(`no case named ${name}`);
    await run();
  });

  it('cannot open another tenant email even with its ciphertext in hand', async () => {
    const [first] = foreign;
    if (first === undefined) throw new Error('no foreign recipient');
    const sealed = await db
      .tenant(first.tenant.context)
      .transaction((tx) => recipientPii.email(tx, first.recipientId));
    if (sealed === undefined) throw new Error('no sealed email');
    expect(() => sealer.open(sealed, emailAssociatedData(a.context, first.recipientId))).toThrow(
      /not one this key sealed/,
    );
  });
});
