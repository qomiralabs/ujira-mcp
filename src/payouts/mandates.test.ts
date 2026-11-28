// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The mandate service's own refusals and corner cases, on a stub adapter and
// store so each answer from the chain or the database can be chosen. The full
// flows, on the fake RPC and over HTTP, are in test/mandate-routes.test.ts.

import { describe, expect, it } from 'vitest';

import {
  ChainError,
  type ChainAdapter,
  type MandateAction,
  type MandateConfigView,
  type MandateStateView,
  type SigningRequest,
  type SubmitResult,
} from '../chain/adapter.js';
import { RECIPIENT_MODE } from '../chain/types.js';
import type {
  Mandate,
  NewMandate,
  NewSigningRequest,
  Page,
  StoredSigningRequest,
} from '../db/index.js';
import { MandateTakenError, type MandateStore, type RecipientWallet } from './mandate-store.js';
import {
  MAX_ALLOW_RECIPIENTS,
  MandateService,
  MandateServiceError,
  type MandateCaller,
  type PrepareInput,
} from './mandates.js';

const NOW = Date.parse('2026-11-27T10:00:00.000Z');
const DAY_MS = 86_400_000;
const account = (fill: string): string => `G${fill.repeat(55)}`;
const OWNER = account('O');
const AGENT = account('K');
const EXECUTOR = account('E');
const APPROVER = account('P');
const CONTRACT = `C${'M'.repeat(55)}`;
const ASSET = `C${'A'.repeat(55)}`;
const TX = 'ab'.repeat(32);
const MANDATE_ID = '0b9c3a52-6f1e-4c39-9a57-3f7d2e1c0a11';

const caller = (wallet: string | null = OWNER): MandateCaller => ({
  principalId: '6d0f2c1e-8a4b-4f3e-9c2d-1b0a9f8e7d6c',
  projectId: '2a4c6e80-1b3d-4f5a-8c7e-9d0b1a2c3e4f',
  wallet,
});

function config(over: Partial<MandateConfigView> = {}): MandateConfigView {
  return {
    principal: OWNER,
    asset: ASSET,
    recipientMode: RECIPIENT_MODE.allowlist,
    agents: [AGENT],
    approvers: [OWNER],
    approvalsRequired: 1,
    executors: [EXECUTOR],
    limits: {
      totalBudget: 5_000n,
      perPaymentCap: 500n,
      perRecipientDailyCap: 1_000n,
      approvalThreshold: 250n,
      payoutTtlSeconds: 86_400n,
      expiresAt: BigInt(Math.floor((NOW + 30 * DAY_MS) / 1000)),
    },
    maxFeeBps: 0,
    feeAddress: account('F'),
    ...over,
  };
}

function state(over: Partial<MandateStateView> = {}): MandateStateView {
  return {
    spent: 0n,
    pending: 0n,
    committed: 0n,
    balance: 5_000n,
    free: 5_000n,
    paused: false,
    revoked: false,
    expired: false,
    ...over,
  };
}

function prepareInput(over: Partial<PrepareInput> = {}): PrepareInput {
  return {
    name: 'Payroll',
    approvers: [],
    approvalsRequired: 1,
    limits: {
      totalBudget: 5_000n,
      perPaymentCap: 500n,
      perRecipientDailyCap: 1_000n,
      approvalThreshold: 250n,
      payoutTtlSeconds: 86_400,
      expiresAt: new Date(NOW + 30 * DAY_MS),
    },
    recipientMode: 'allowlist',
    ...over,
  };
}

const MANDATE: Mandate = {
  id: MANDATE_ID,
  projectId: caller().projectId,
  name: 'Payroll',
  network: 'stellar:testnet',
  contractAddress: CONTRACT,
  asset: 'USDC',
  scale: 7,
  agentKeyId: 'key-1',
  agentAddress: AGENT,
  principalWallet: OWNER,
  createdTxHash: null,
  createdAt: new Date(NOW),
};

type Read = () => Promise<{ config: MandateConfigView; state: MandateStateView }>;

/** The adapter calls the service makes, each one replaceable by a test. */
class StubAdapter {
  readonly network = 'stellar:testnet' as const;
  read: Read = () => Promise.resolve({ config: config(), state: state() });
  send: () => Promise<SubmitResult> = () => Promise.resolve({ txHash: TX, contract: CONTRACT });

  parseAccount(raw: string): string {
    // An unexpected failure inside the adapter, rather than a bad address.
    if (raw === 'boom') throw new TypeError('the adapter broke');
    if (!/^G[A-Z2-7]{55}$/.test(raw.trim())) {
      throw new ChainError('INVALID_ADDRESS', 'not an account');
    }
    return raw.trim();
  }

  readMandate(): ReturnType<Read> {
    return this.read();
  }

  prepareMandateAction(_contract: string | null, action: MandateAction): Promise<SigningRequest> {
    return Promise.resolve({
      network: this.network,
      xdr: 'AAAA',
      signer: OWNER,
      action: action.kind,
      summary: `sign ${action.kind}`,
      expiresAt: new Date(NOW + 600_000).toISOString(),
    });
  }

  submitSigned(): Promise<SubmitResult> {
    return this.send();
  }
}

/** The store the service reads and writes, with the answers a test sets. */
class StubStore implements MandateStore {
  readonly requests = new Map<string, StoredSigningRequest>();
  readonly submitted: string[] = [];
  people: RecipientWallet[] = [];
  add: (input: NewMandate) => Promise<{ mandate: Mandate; created: boolean }> = (input) =>
    Promise.resolve({
      mandate: { ...MANDATE, contractAddress: input.contractAddress },
      created: true,
    });
  record: () => Promise<Mandate> = () => Promise.resolve(MANDATE);

  activeAgentKey() {
    return Promise.resolve({ id: 'key-1', publicKey: AGENT });
  }
  mandate(_t: unknown, id: string) {
    return Promise.resolve(id === MANDATE_ID ? MANDATE : undefined);
  }
  mandates(): Promise<Page<Mandate>> {
    return Promise.resolve({ items: [MANDATE], next: null });
  }
  addMandate(_t: unknown, input: NewMandate) {
    return this.add(input);
  }
  recipients(_t: unknown, ids: readonly string[]) {
    return Promise.resolve(this.people.filter((r) => ids.includes(r.id)));
  }
  payout() {
    return Promise.resolve(undefined);
  }
  mandateRecipients() {
    return Promise.resolve(this.people);
  }
  createSigningRequest(_t: unknown, input: NewSigningRequest): Promise<StoredSigningRequest> {
    const stored: StoredSigningRequest = {
      id: `request-${String(this.requests.size + 1)}`,
      projectId: caller().projectId,
      mandateId: input.mandateId,
      action: input.action,
      network: input.network,
      signer: input.signer,
      envelope: input.envelope,
      summary: input.summary,
      expiresAt: input.expiresAt,
      mandateName: input.mandateName ?? null,
      agentKeyId: input.agentKeyId ?? null,
      submittedTxHash: null,
      submittedAt: null,
      createdAt: new Date(NOW),
    };
    this.requests.set(stored.id, stored);
    return Promise.resolve(stored);
  }
  signingRequest(_t: unknown, id: string) {
    return Promise.resolve(this.requests.get(id));
  }
  markSubmitted(_t: unknown, id: string) {
    this.submitted.push(id);
    return Promise.resolve(true);
  }
  recordCreated() {
    return this.record();
  }
}

function setup(o: { clock?: boolean } = {}) {
  const adapter = new StubAdapter();
  const store = new StubStore();
  const service = new MandateService({
    // The service uses only these calls of the adapter.
    adapter: adapter as unknown as ChainAdapter,
    store,
    executor: EXECUTOR,
    unit: { code: 'USDC', scale: 7, contract: ASSET },
    ...(o.clock === false ? {} : { now: () => new Date(NOW) }),
  });
  return { adapter, store, service };
}

async function refusal(promise: Promise<unknown>): Promise<{ code: string; details: unknown }> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof MandateServiceError) return { code: error.code, details: error.details };
    throw error;
  }
  throw new Error('expected a refusal');
}

const issue = (path: string, name: string) => ({
  code: 'INVALID_REQUEST',
  details: [{ path, issue: name }],
});

describe('the mandate service', () => {
  it('needs a wallet for anything that is signed', async () => {
    const { service } = setup();
    expect(await refusal(service.prepare(caller(null), prepareInput(), 'r'))).toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(
      await refusal(service.submit(caller(null), { signingRequestId: 'x', xdr: 'AAAA' }, 'r')),
    ).toMatchObject({ code: 'FORBIDDEN' });
  });

  it('refuses an address the chain cannot read, and lets any other failure through', async () => {
    const { service } = setup();
    expect(
      await refusal(service.prepare(caller(), prepareInput({ approvers: ['nope'] }), 'r')),
    ).toEqual(issue('body.approvers.0', 'invalid_address'));
    await expect(
      service.prepare(caller(), prepareInput({ approvers: ['boom'] }), 'r'),
    ).rejects.toThrow(TypeError);
  });

  it('takes the approvers it is given, once each, and never UJIRA as the owner', async () => {
    const { service } = setup();
    const named = await service.prepare(
      caller(),
      prepareInput({ approvers: [APPROVER, OWNER], approvalsRequired: 2 }),
      'r',
    );
    expect(named).toMatchObject({ id: 'request-1', action: 'create' });
    expect(
      await refusal(
        service.prepare(caller(), prepareInput({ approvers: [APPROVER, APPROVER] }), 'r'),
      ),
    ).toEqual(issue('body.approvers', 'duplicate'));
    for (const wallet of [AGENT, EXECUTOR]) {
      expect(await refusal(service.prepare(caller(wallet), prepareInput(), 'r'))).toEqual(
        issue('wallet', 'role_conflict'),
      );
    }
  });

  it('holds every limit to what the contract takes', async () => {
    const { service } = setup();
    const base = prepareInput().limits;
    const cases: [Partial<PrepareInput['limits']>, string, string][] = [
      [{ totalBudget: 0n }, 'body.limits.totalBudget', 'not_positive'],
      [{ perPaymentCap: 0n }, 'body.limits.perPaymentCap', 'not_positive'],
      [{ perRecipientDailyCap: 0n }, 'body.limits.perRecipientDailyCap', 'not_positive'],
      [{ approvalThreshold: -1n }, 'body.limits.approvalThreshold', 'negative'],
      [{ expiresAt: new Date(NOW + 367 * DAY_MS) }, 'body.limits.expiresAt', 'too_late'],
    ];
    for (const [over, path, name] of cases) {
      expect(
        await refusal(
          service.prepare(caller(), prepareInput({ limits: { ...base, ...over } }), 'r'),
        ),
        path,
      ).toEqual(issue(path, name));
    }
  });

  it('reads the time from the clock when it is given none', async () => {
    const { service } = setup({ clock: false });
    const limits = { ...prepareInput().limits, expiresAt: new Date(Date.now() + 30 * DAY_MS) };
    expect(await service.prepare(caller(), prepareInput({ limits }), 'r')).toMatchObject({
      action: 'create',
    });
  });

  it('shows each status the chain reports, and values no person would set', async () => {
    const { adapter, store, service } = setup();
    const statusOf = async (s: Partial<MandateStateView>) => {
      adapter.read = () => Promise.resolve({ config: config(), state: state(s) });
      return (await service.detail(caller(), MANDATE_ID, 'r')).status;
    };
    expect(await statusOf({})).toBe('active');
    expect(await statusOf({ paused: true })).toBe('paused');
    expect(await statusOf({ expired: true, paused: true })).toBe('expired');
    expect(await statusOf({ revoked: true, expired: true })).toBe('revoked');

    const far = config({
      recipientMode: 9,
      limits: { ...config().limits, payoutTtlSeconds: 2n ** 60n, expiresAt: 10n ** 18n },
    });
    adapter.read = () => Promise.resolve({ config: far, state: state() });
    store.people = [
      {
        id: 'r-1',
        mandateId: MANDATE_ID,
        label: 'Short',
        recipientRef: 'a',
        status: 'active',
        destination: 'GSHORT',
      },
      {
        id: 'r-2',
        mandateId: MANDATE_ID,
        label: 'Long',
        recipientRef: 'b',
        status: 'active',
        destination: APPROVER,
      },
    ];
    const detail = await service.detail(caller(), MANDATE_ID, 'r');
    expect(detail.config.recipientMode).toBe('unknown');
    expect(detail.config.limits.payoutTtlSeconds).toBe(Number.MAX_SAFE_INTEGER);
    expect(detail.config.limits.expiresAt).toBe(new Date(8_640_000_000_000_000).toISOString());
    expect(detail.recipients.map((r) => r.address)).toEqual(['GSHORT', 'GPPP...PPPP']);
  });

  it('imports only what it can read, in the asset it pays, and passes on a store failure', async () => {
    const { adapter, store, service } = setup();
    const input = { contractId: CONTRACT, name: null };
    adapter.read = () => Promise.reject(new TypeError('the reader broke'));
    await expect(service.importMandate(caller(), input, 'r')).rejects.toThrow(TypeError);
    adapter.read = () => Promise.reject(new ChainError('UNAVAILABLE', 'down'));
    await expect(service.importMandate(caller(), input, 'r')).rejects.toThrow(ChainError);

    adapter.read = () =>
      Promise.resolve({ config: config({ asset: account('X') }), state: state() });
    expect(await refusal(service.importMandate(caller(), input, 'r'))).toEqual(
      issue('body.contractId', 'unsupported_asset'),
    );

    adapter.read = () => Promise.resolve({ config: config(), state: state() });
    store.add = () => Promise.reject(new Error('the database is down'));
    await expect(service.importMandate(caller(), input, 'r')).rejects.toThrow(
      'the database is down',
    );
  });

  it('allows at most one call worth of recipients at a time', async () => {
    const { store, service } = setup();
    store.people = Array.from({ length: MAX_ALLOW_RECIPIENTS + 1 }, (_, i) => ({
      id: `r-${String(i)}`,
      mandateId: MANDATE_ID,
      label: `Person ${String(i)}`,
      recipientRef: String(i),
      status: 'active',
      destination: APPROVER,
    }));
    expect(
      await refusal(
        service.action(
          caller(),
          MANDATE_ID,
          { kind: 'allow_recipients', recipientIds: store.people.map((r) => r.id) },
          'r',
        ),
      ),
    ).toEqual(issue('body.recipientIds', 'too_many'));
  });

  describe('after a create lands', () => {
    async function prepared() {
      const s = setup();
      const req = await s.service.prepare(caller(), prepareInput(), 'r');
      return {
        ...s,
        submit: () => s.service.submit(caller(), { signingRequestId: req.id, xdr: 'AAAA' }, 'r'),
      };
    }

    it('says where the mandate is when it cannot be read back, and uses up the request', async () => {
      const { adapter, store, submit } = await prepared();
      adapter.read = () => Promise.reject(new ChainError('UNAVAILABLE', 'down'));
      const failure = await submit().catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(MandateServiceError);
      expect((failure as MandateServiceError).code).toBe('CHAIN_UNAVAILABLE');
      expect((failure as MandateServiceError).message).toContain(CONTRACT);
      expect(store.submitted).toEqual(['request-1']);
    });

    it('lets an unexpected read failure through without using up the request', async () => {
      const { adapter, store, submit } = await prepared();
      adapter.read = () => Promise.reject(new TypeError('the reader broke'));
      await expect(submit()).rejects.toThrow(TypeError);
      expect(store.submitted).toEqual([]);
    });

    it("answers MANDATE_TAKEN for another project's contract, and passes on other failures", async () => {
      const taken = await prepared();
      taken.store.record = () => Promise.reject(new MandateTakenError());
      expect(await refusal(taken.submit())).toMatchObject({ code: 'MANDATE_TAKEN' });

      const broken = await prepared();
      broken.store.record = () => Promise.reject(new Error('the database is down'));
      await expect(broken.submit()).rejects.toThrow('the database is down');
    });
  });
});
