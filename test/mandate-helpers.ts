// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The mandate routes in memory: a store that keeps the database's tenant
// rules (rows are found only in their own project, a contract belongs to one
// project, a signing request records one transaction), sessions that act in
// a project, the Stellar adapter over the fake RPC, and a network that
// answers a factory create with the address it deployed.

import { randomUUID } from 'node:crypto';

import {
  Account,
  TransactionBuilder,
  type FeeBumpTransaction,
  type Transaction,
  type xdr,
} from '@stellar/stellar-sdk';

import { createV1App, type V1App } from '../src/api/app.js';
import { createAuthenticate } from '../src/api/authenticate.js';
import { memoryIdempotencyStore } from '../src/api/idempotency.js';
import { mandateRoutes } from '../src/api/routes/mandates.js';
import { newSessionToken, sessionTokenHash, SESSION_COOKIE } from '../src/auth/session-token.js';
import type { ApiScope } from '../src/auth/scopes.js';
import { SignIn } from '../src/auth/sign-in.js';
import type { TokenAuthenticator } from '../src/auth/token-auth.js';
import { ChainError } from '../src/chain/adapter.js';
import { StellarChainAdapter } from '../src/chain/stellar/adapter.js';
import { address } from '../src/chain/stellar/codec.js';
import { TESTNET_PASSPHRASE } from '../src/chain/stellar/gateway.js';
import type { AccountFacts, StellarNetworkPort, Submitted } from '../src/chain/stellar/network.js';
import type {
  Mandate,
  NewMandate,
  NewSigningRequest,
  Page,
  PageRequest,
  ProjectContext,
  ResolvedSession,
  StoredSigningRequest,
} from '../src/db/index.js';
import {
  MandateTakenError,
  type AgentKeyRef,
  type PayoutRef,
  type MandateStore,
  type RecipientWallet,
} from '../src/payouts/mandate-store.js';
import { SponsoredSubmitter, type FeeLedger } from '../src/payouts/fee-sponsorship.js';
import { MandateService, type Relay } from '../src/payouts/mandates.js';
import {
  ASSET,
  FakeMandateRpc,
  MANDATE,
  agent,
  executor,
  principal,
  testSigner,
} from './fake-rpc.js';
import { MemorySignInStore, ORIGIN, verifier, type Clock } from './sign-in-helpers.js';

export const FACTORY = 'CB4AYBA5NVQPVPNOWUCSZQK6ZIGOF7KSCS6SF6UV6D2OKPDXLHEPD4V7';
export const ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
export const START = Date.parse('2026-11-27T10:00:00.000Z');

const key = (t: ProjectContext) => `${t.principalId}|${t.projectId}`;

interface Row<T> {
  readonly tenant: string;
  value: T;
}

export class MemoryMandateStore implements MandateStore {
  readonly agentKeys = new Map<string, Row<AgentKeyRef & { network: string }>>();
  readonly mandateRows = new Map<string, Row<Mandate>>();
  readonly recipientRows = new Map<string, Row<RecipientWallet>>();
  readonly requests = new Map<string, Row<StoredSigningRequest>>();
  readonly payoutRows = new Map<string, Row<PayoutRef>>();

  addPayout(t: ProjectContext, payout: PayoutRef): string {
    const id = randomUUID();
    this.payoutRows.set(id, { tenant: key(t), value: payout });
    return id;
  }

  payout(t: ProjectContext, id: string): Promise<PayoutRef | undefined> {
    const row = this.payoutRows.get(id);
    return Promise.resolve(row?.tenant === key(t) ? row.value : undefined);
  }

  addAgentKey(t: ProjectContext, publicKey: string, network = 'stellar:testnet'): AgentKeyRef {
    const id = randomUUID();
    this.agentKeys.set(id, { tenant: key(t), value: { id, publicKey, network } });
    return { id, publicKey };
  }

  addRecipient(
    t: ProjectContext,
    r: Omit<RecipientWallet, 'id' | 'status'> & { status?: string },
  ): RecipientWallet {
    const id = randomUUID();
    const value = { id, status: 'active', ...r };
    this.recipientRows.set(id, { tenant: key(t), value });
    return value;
  }

  private own<T>(rows: Map<string, Row<T>>, t: ProjectContext): T[] {
    return [...rows.values()].filter((r) => r.tenant === key(t)).map((r) => r.value);
  }

  activeAgentKey(t: ProjectContext, network: string): Promise<AgentKeyRef | undefined> {
    const found = this.own(this.agentKeys, t).find((k) => k.network === network);
    return Promise.resolve(
      found === undefined ? undefined : { id: found.id, publicKey: found.publicKey },
    );
  }

  mandate(t: ProjectContext, id: string): Promise<Mandate | undefined> {
    const row = this.mandateRows.get(id);
    return Promise.resolve(row?.tenant === key(t) ? row.value : undefined);
  }

  mandates(t: ProjectContext, page: PageRequest): Promise<Page<Mandate>> {
    const all = this.own(this.mandateRows, t)
      .filter((m) => page.after === undefined || m.id > page.after)
      .sort((a, b) => (a.id < b.id ? -1 : 1));
    const items = all.slice(0, page.limit);
    const last = items.at(-1);
    return Promise.resolve({
      items,
      next: all.length > page.limit && last !== undefined ? last.id : null,
    });
  }

  private insert(t: ProjectContext, input: NewMandate): Mandate {
    const taken = [...this.mandateRows.values()].find(
      (r) => r.value.network === input.network && r.value.contractAddress === input.contractAddress,
    );
    if (taken !== undefined) {
      if (taken.tenant === key(t)) return taken.value;
      throw new MandateTakenError();
    }
    if (!('keyId' in input.agent)) throw new Error('the memory store only takes project keys');
    const agentKey = this.agentKeys.get(input.agent.keyId);
    if (agentKey?.tenant !== key(t)) throw new Error('foreign key: agent key of another project');
    const m: Mandate = {
      id: randomUUID(),
      projectId: t.projectId,
      name: input.name,
      network: input.network,
      contractAddress: input.contractAddress,
      asset: input.asset,
      scale: input.scale,
      agentKeyId: input.agent.keyId,
      agentAddress: agentKey.value.publicKey,
      principalWallet: input.principalWallet,
      createdTxHash: input.createdTxHash ?? null,
      createdAt: new Date(START),
    };
    this.mandateRows.set(m.id, { tenant: key(t), value: m });
    return m;
  }

  // Async, so a refused insert rejects the promise as the database would.
  async addMandate(
    t: ProjectContext,
    input: NewMandate,
  ): Promise<{ mandate: Mandate; created: boolean }> {
    await Promise.resolve();
    const before = this.mandateRows.size;
    const mandate = this.insert(t, input);
    return { mandate, created: this.mandateRows.size > before };
  }

  recipients(t: ProjectContext, ids: readonly string[]): Promise<RecipientWallet[]> {
    return Promise.resolve(
      ids.flatMap((id) => {
        const row = this.recipientRows.get(id);
        return row?.tenant === key(t) ? [row.value] : [];
      }),
    );
  }

  mandateRecipients(
    t: ProjectContext,
    mandateId: string,
    limit: number,
  ): Promise<RecipientWallet[]> {
    return Promise.resolve(
      this.own(this.recipientRows, t)
        .filter((r) => r.mandateId === mandateId)
        .slice(0, limit),
    );
  }

  createSigningRequest(t: ProjectContext, input: NewSigningRequest): Promise<StoredSigningRequest> {
    if ((input.action === 'create') !== (input.mandateId === null)) {
      return Promise.reject(new Error('check: a create has no mandate'));
    }
    if (input.mandateId !== null && this.mandateRows.get(input.mandateId)?.tenant !== key(t)) {
      return Promise.reject(new Error('foreign key: mandate of another project'));
    }
    const value: StoredSigningRequest = {
      id: randomUUID(),
      projectId: t.projectId,
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
      createdAt: new Date(START),
    };
    this.requests.set(value.id, { tenant: key(t), value });
    return Promise.resolve(value);
  }

  signingRequest(t: ProjectContext, id: string): Promise<StoredSigningRequest | undefined> {
    const row = this.requests.get(id);
    return Promise.resolve(row?.tenant === key(t) ? row.value : undefined);
  }

  markSubmitted(t: ProjectContext, id: string, txHash: string): Promise<boolean> {
    const row = this.requests.get(id);
    if (row?.tenant !== key(t) || row.value.submittedTxHash !== null) {
      return Promise.resolve(false);
    }
    row.value = { ...row.value, submittedTxHash: txHash, submittedAt: new Date(START) };
    return Promise.resolve(true);
  }

  async recordCreated(
    t: ProjectContext,
    requestId: string,
    txHash: string,
    input: NewMandate,
  ): Promise<Mandate> {
    await this.markSubmitted(t, requestId, txHash);
    return this.insert(t, input);
  }
}

/** Sessions that act in the projects a wallet was given, as session_resolve does. */
export class ProjectSignInStore extends MemorySignInStore {
  readonly access = new Map<string, { principalId: string; projectId: string; role: string }>();

  override async resolveSession(
    tokenSha256: Buffer,
    projectId?: string | null,
  ): Promise<ResolvedSession | undefined> {
    const found = await super.resolveSession(tokenSha256);
    if (found === undefined) return undefined;
    const granted =
      projectId === undefined || projectId === null
        ? undefined
        : this.access.get(`${found.walletAddress}|${projectId}`);
    return { ...found, access: granted ?? null };
  }
}

/** Accounts, preparing and sending, in memory; a create lands at MANDATE unless told otherwise. */
export class FakeNetwork implements StellarNetworkPort {
  readonly submitted: (Transaction | FeeBumpTransaction)[] = [];
  readonly answers: Partial<Submitted>[] = [];
  /** What a successful create returns; undefined sends no address. */
  created: xdr.ScVal | undefined = address(MANDATE);
  failWith: Error | undefined;

  account() {
    return Promise.resolve({ exists: true, xlm: '100', usdc: null });
  }
  accountFacts(): Promise<AccountFacts> {
    return Promise.resolve({ exists: true, trustlines: [], memoRequired: false });
  }
  loadAccount(addr: string): Promise<Account> {
    return Promise.resolve(new Account(addr, '100'));
  }
  prepare(tx: Transaction): Promise<Transaction> {
    return Promise.resolve(tx);
  }
  submit(tx: Transaction | FeeBumpTransaction): Promise<Submitted> {
    if (this.failWith !== undefined) return Promise.reject(this.failWith);
    this.submitted.push(tx);
    // Every answer carries the address; the adapter reads it only for a create.
    return Promise.resolve({
      hash: Buffer.from(tx.hash()).toString('hex'),
      status: 'SUCCESS',
      ...(this.created === undefined ? {} : { returnValue: this.created }),
      ...this.answers.shift(),
    });
  }
  friendbot(): Promise<void> {
    return Promise.resolve();
  }
  latestLedger(): Promise<number> {
    return Promise.resolve(4242);
  }
}

/** Signs a prepared envelope as a wallet would. */
export function signEnvelope(xdrText: string, signer = principal): string {
  const tx = TransactionBuilder.fromXdr(xdrText, TESTNET_PASSPHRASE) as Transaction;
  signer.sign(tx);
  return tx.toXdr();
}

export interface Member {
  readonly cookie: string;
  readonly wallet: string;
}

export interface MandateHarness {
  readonly clock: Clock;
  readonly rpc: FakeMandateRpc;
  readonly chain: FakeNetwork;
  readonly adapter: StellarChainAdapter;
  readonly store: MemoryMandateStore;
  readonly signIns: ProjectSignInStore;
  readonly v1: V1App;
  readonly lines: string[];
  /** A bearer key for the project, holding these scopes. */
  apiKey(context: ProjectContext, scopes: readonly ApiScope[]): string;
  /** A principal with one project and an agent key, and its owner signed in. */
  tenant(o?: { wallet?: string; role?: string; withKey?: boolean }): Promise<{
    context: ProjectContext;
    member: Member;
  }>;
  /** Signs another wallet in to an existing project. */
  join(context: ProjectContext, wallet: string, role: string): Promise<Member>;
  call(
    method: string,
    path: string,
    o?: {
      body?: unknown;
      member?: Member;
      project?: string | null;
      origin?: string | null;
      idempotencyKey?: string;
      bearer?: string;
    },
  ): Promise<{ status: number; json: Record<string, unknown> | undefined; headers: Headers }>;
}

/** Pays the fee of every envelope a principal signs, in the sponsored harness. */
export const feeSponsor = testSigner('fee-sponsor');

export function mandateHarness(
  o: {
    relay?: Relay;
    sponsor?: { ledger: FeeLedger; dailyCap: bigint };
    /** Makes the project's agent key on first use, as the key service does. */
    provision?: boolean;
  } = {},
): MandateHarness {
  const clock: Clock = { now: START };
  const rpc = new FakeMandateRpc();
  const chain = new FakeNetwork();
  const adapter = new StellarChainAdapter({
    gateway: rpc,
    chain,
    factory: FACTORY,
    asset: { code: 'USDC', issuer: ISSUER, contract: ASSET },
    now: () => clock.now,
    ...(o.sponsor === undefined ? {} : { feeSponsor }),
  });
  const sponsored =
    o.sponsor === undefined
      ? undefined
      : new SponsoredSubmitter({
          adapter,
          ledger: o.sponsor.ledger,
          settings: { dailyCap: o.sponsor.dailyCap },
          log: () => undefined,
          now: () => clock.now,
        });
  const relay: Relay | undefined =
    o.relay ??
    (sponsored === undefined
      ? undefined
      : (signed, expected, caller, c) => sponsored.submit(caller, signed, expected, c));
  const store = new MemoryMandateStore();
  const signIns = new ProjectSignInStore(clock);
  const lines: string[] = [];
  const log = (line: string) => {
    lines.push(line);
  };
  const now = () => new Date(clock.now);
  const signIn = new SignIn({ store: signIns, verifier, origin: ORIGIN, log, now });
  const service = new MandateService({
    adapter,
    store,
    executor: executor.publicKey,
    unit: { code: 'USDC', scale: 7, contract: ASSET },
    now,
    ...(relay === undefined ? {} : { relay }),
    ...(o.provision === true
      ? {
          agentKeys: {
            provision: async (context: ProjectContext) =>
              (await store.activeAgentKey(context, 'stellar:testnet')) ??
              store.addAgentKey(context, agent.publicKey),
          },
        }
      : {}),
  });
  // Keys in memory: a bearer value names its tenant and scopes.
  const keys = new Map<string, { context: ProjectContext; scopes: readonly ApiScope[] }>();
  const tokens: TokenAuthenticator = {
    authenticate: (credentials) => {
      const found = keys.get((credentials.authorization ?? '').replace(/^Bearer /, ''));
      return Promise.resolve(
        found === undefined
          ? { ok: false, code: 'TOKEN_INVALID' }
          : {
              ok: true,
              tenant: {
                ...found.context,
                tokenId: randomUUID(),
                prefix: 'ujk_test_fake',
                scopes: [...found.scopes],
              },
            },
      );
    },
    forget: () => undefined,
  };
  const authenticate = createAuthenticate({ tokens, session: { signIn, origin: ORIGIN } });
  const v1 = createV1App({
    routes: mandateRoutes({
      authenticate,
      service,
      idempotency: memoryIdempotencyStore(now),
      log,
    }),
    log,
  });

  async function session(wallet: string): Promise<string> {
    const token = newSessionToken();
    const hash = sessionTokenHash(token);
    if (hash === undefined) throw new Error('a new token did not hash');
    await signIns.createSession({
      tokenSha256: hash,
      walletAddress: wallet,
      idleSeconds: 3_600,
      absoluteSeconds: 86_400,
    });
    return token;
  }

  async function join(context: ProjectContext, wallet: string, role: string): Promise<Member> {
    signIns.access.set(`${wallet}|${context.projectId}`, { ...context, role });
    return { cookie: await session(wallet), wallet };
  }

  return {
    clock,
    rpc,
    chain,
    adapter,
    store,
    signIns,
    v1,
    lines,
    apiKey(context, scopes) {
      const value = `ujk_test_${randomUUID()}`;
      keys.set(value, { context, scopes });
      return value;
    },
    async tenant(t = {}) {
      const context = { principalId: randomUUID(), projectId: randomUUID() };
      if (t.withKey !== false) store.addAgentKey(context, agent.publicKey);
      const member = await join(context, t.wallet ?? principal.publicKey, t.role ?? 'owner');
      return { context, member };
    },
    join,
    async call(method, path, c = {}) {
      const headers: Record<string, string> = {};
      if (c.body !== undefined) headers['content-type'] = 'application/json';
      const origin = c.origin === undefined ? ORIGIN : c.origin;
      if (origin !== null) headers['origin'] = origin;
      if (c.member !== undefined) headers['cookie'] = `${SESSION_COOKIE}=${c.member.cookie}`;
      if (c.project !== undefined && c.project !== null) headers['ujira-project'] = c.project;
      if (c.idempotencyKey !== undefined) headers['idempotency-key'] = c.idempotencyKey;
      if (c.bearer !== undefined) headers['authorization'] = `Bearer ${c.bearer}`;
      const res = await v1.app.fetch(
        new Request(`${ORIGIN}${path}`, {
          method,
          headers,
          ...(c.body === undefined
            ? {}
            : {
                body: JSON.stringify(c.body, (_k, v: unknown) =>
                  typeof v === 'bigint' ? v.toString() : v,
                ),
              }),
        }),
        { requestId: randomUUID(), client: '203.0.113.9' },
      );
      const text = await res.text();
      return {
        status: res.status,
        json: text === '' ? undefined : (JSON.parse(text) as Record<string, unknown>),
        headers: res.headers,
      };
    },
  };
}

/** Rules a console owner would type, in minor units, a day ahead. */
export function prepareBody(over: Record<string, unknown> = {}) {
  const token = (amount: string) => ({
    amount,
    asset: 'USDC',
    network: 'stellar:testnet',
    scale: 7,
  });
  return {
    name: 'Weekly payouts',
    approvers: [],
    approvalsRequired: 1,
    limits: {
      totalBudget: token('5000000000'),
      perPaymentCap: token('500000000'),
      perRecipientDailyCap: token('1000000000'),
      approvalThreshold: token('250000000'),
      payoutTtlSeconds: 86_400,
      expiresAt: new Date(START + 30 * 86_400_000).toISOString(),
    },
    recipients: [],
    ...over,
  };
}

export function codeOf(answer: { json: Record<string, unknown> | undefined }): unknown {
  return (answer.json?.['error'] as { code?: unknown } | undefined)?.code;
}

export const chainDown = () => new ChainError('UNAVAILABLE', 'down');
