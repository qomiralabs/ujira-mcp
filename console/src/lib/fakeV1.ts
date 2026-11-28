// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// An in-memory stand in for the /v1 data routes, for mock mode and the tests,
// next to the fake sign in it builds on. Every route runs the fake sign in's
// tenant check first, so data stays inside the project the header names, and
// a lapsed session answers SESSION_INVALID like the server. Every answer is
// written as wire JSON and read back through the real client's schemas, so
// the fake can never hand a screen something the server could not send.
//
// It keeps the server's money rules: idempotency keys replay or refuse,
// a task pays once per mandate, a payout the mandate refuses is a blocked
// record with the rule's name, and approvals and receipts follow from status.
// And its mandate rules: writes take a session, never an API key; a new
// mandate takes no recipients, which are added once it exists; and a signed
// submit is checked and answered in the server's order.

import * as z from 'zod/mini';

import { ApiError } from './api';
import {
  API_SCOPES,
  EXPIRY_DEFAULT_DAYS,
  EXPIRY_MAX_DAYS,
  KEY_LIMIT,
  KEY_NAME_MAX,
} from './apiKeys';
import type { FakeAuthApi, FakeTenant } from './fakeAuth';
import { formatAmount } from './money';
import { v1ErrorText, type MandateActionInput, type PrepareMandateInput, type V1Api } from './v1';
import {
  apiKeySchema,
  embedSessionSchema,
  mandateSchema,
  overviewSchema,
  payoutSchema,
  receiptSchema,
  receiptVerificationSchema,
  recipientSchema,
  signingRequestSchema,
  submittedSchema,
  type Page,
  type SigningRequest,
  type Submitted,
  type TokenAmount,
  type TokenAmountWire,
} from './v1Schemas';

export const FAKE_NETWORK = 'stellar:testnet';
export const FAKE_ASSET = 'USDC';
export const FAKE_SCALE = 7;

const PAGE_DEFAULT = 50;
const DAY_MS = 86_400_000;
const PAGE_MAX = 200;
// The recipient, embed session and API key routes take at most 100 a page.
const SMALL_PAGE_MAX = 100;
const SIGNING_MS = 10 * 60 * 1000;
const OVERVIEW_DAYS = 7;
const OVERVIEW_MANDATES = 50;
const LABEL_MAX = 100;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const INVITE_MIN_S = 5 * 60;
const INVITE_MAX_S = 7 * 24 * 60 * 60;
const STELLAR_ACCOUNT = /^G[A-Z2-7]{55}$/;
const STELLAR_CONTRACT = /^C[A-Z2-7]{55}$/;
// The same set the server takes in the Idempotency-Key header.
const IDEMPOTENCY_KEY = /^[A-Za-z0-9_.:-]{1,255}$/;

export interface FakeV1Options {
  readonly delayMs?: number;
  readonly now?: () => number;
  /** Every project starts with a funded mandate, two recipients and some payouts. */
  readonly demo?: boolean;
  /** Contracts the fake chain names this member's wallet on, so import accepts them. */
  readonly importable?: readonly string[];
  /** What the fake chain says about a wallet; every other wallet can receive. */
  readonly destinations?: Readonly<Record<string, FakeDestination>>;
  /** Contracts this wallet owns that name another agent key, so import refuses them. */
  readonly otherAgent?: readonly string[];
}

/** A wallet as the chain sees it: `down` stands for the network not answering. */
export type FakeDestination = 'receivable' | 'no_account' | 'no_trustline' | 'needs_memo' | 'down';

export interface FakeV1Api extends V1Api {
  /** How many signing requests wait for a signed transaction; for tests. */
  readonly signingRequests: () => number;
  /** Changes what the fake chain says about a wallet, as its owner fixing it would. */
  readonly setDestination: (address: string, state: FakeDestination) => void;
  /** Puts payouts to a recipient on hold, as support would. */
  readonly suspendRecipient: (id: string) => void;
  /** Calls the routes as an API key would instead of a session; for tests. */
  readonly useApiKey: (on: boolean) => void;
  /**
   * The next submit reaches the chain but its answer is lost, as when the
   * server cannot read a new mandate back: a 503, not kept for a replay.
   */
  readonly loseNextAnswer: () => void;
  /** Makes the fake chain miss, or answer again, the overview's read of one mandate. */
  readonly setUnread: (mandateId: string, unanswered: boolean) => void;
}

interface MandateRow {
  readonly id: string;
  readonly name: string | null;
  readonly contractId: string;
  readonly createdAt: string;
  readonly principal: string;
  readonly approvers: readonly string[];
  readonly approvalsRequired: number;
  readonly limits: {
    readonly totalBudget: bigint;
    readonly perPaymentCap: bigint;
    readonly perRecipientDailyCap: bigint;
    readonly approvalThreshold: bigint;
    readonly payoutTtlSeconds: number;
    readonly expiresAt: string;
  };
  balance: bigint;
  spent: bigint;
  pending: bigint;
  paused: boolean;
  revoked: boolean;
}

type StoredCheck = 'receivable' | 'no_account' | 'no_trustline' | 'unchecked';

interface RecipientRow {
  readonly id: string;
  readonly mandateId: string;
  readonly label: string;
  readonly address: string | null;
  readonly email: string | null;
  readonly createdAt: string;
  // What the chain said the last time anyone looked.
  check: StoredCheck;
  suspended: boolean;
}

interface InviteRow {
  readonly id: string;
  readonly recipientId: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  revokedAt: string | null;
}

interface PayoutRow {
  readonly id: string;
  readonly mandateId: string;
  readonly recipientId: string;
  readonly taskId: string;
  readonly amount: bigint;
  readonly onChainPayoutId: string;
  readonly createdAt: string;
  status: string;
  blockedBy: string | null;
  requestTxHash: string | null;
  txHash: string | null;
  receiptId: string | null;
  updatedAt: string;
  settledAt: string | null;
}

interface ApiKeyRow {
  readonly id: string;
  readonly name: string | null;
  readonly prefix: string;
  readonly scopes: readonly string[];
  readonly expiresAt: string;
  readonly createdAt: string;
  revokedAt: string | null;
}

type Pending =
  | { readonly kind: 'create'; readonly input: PrepareMandateInput; readonly principal: string }
  | { readonly kind: 'action'; readonly mandateId: string; readonly action: MandateActionInput };

interface ProjectData {
  readonly mandates: Map<string, MandateRow>;
  readonly recipients: Map<string, RecipientRow>;
  readonly payouts: Map<string, PayoutRow>;
  readonly keys: Map<string, ApiKeyRow>;
  readonly invites: Map<string, InviteRow>;
  readonly idempotency: Map<string, { readonly body: string; readonly payoutId: string }>;
}

interface SigningRow {
  readonly projectId: string;
  readonly expiresAt: number;
  readonly signer: string;
  readonly xdr: string;
  readonly pending: Pending;
  submitted: boolean;
}

/** What a submit answered, kept under its Idempotency-Key as the server keeps it. */
type SubmitOutcome =
  | { readonly xdr: string; readonly answer: Submitted }
  | { readonly xdr: string; readonly error: ApiError };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function hex(bytes: number): string {
  return [...crypto.getRandomValues(new Uint8Array(bytes))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function strkey(prefix: 'C' | 'G'): string {
  const bytes = crypto.getRandomValues(new Uint8Array(55));
  return prefix + [...bytes].map((b) => BASE32.charAt(b % 32)).join('');
}

/** Lower case base32, the alphabet of an API key. */
function base32(length: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return [...bytes].map((b) => BASE32.charAt(b % 32).toLowerCase()).join('');
}

function mask(address: string): string {
  return `${address.slice(0, 4)}...${address.slice(-4)}`;
}

function usdc(minor: bigint): TokenAmountWire {
  return { amount: minor.toString(), asset: FAKE_ASSET, network: FAKE_NETWORK, scale: FAKE_SCALE };
}

const UNIT = 10n ** BigInt(FAKE_SCALE);

function parse<S extends z.ZodMiniType>(schema: S, wire: unknown): z.output<S> {
  return schema.parse(wire);
}

function bodyKey(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v));
}

// Labels go into a spreadsheet, so a cell that starts like a formula is quoted.
function csvCell(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function createFakeV1Api(auth: FakeAuthApi, options: FakeV1Options = {}): FakeV1Api {
  const delayMs = options.delayMs ?? 350;
  const now = options.now ?? (() => Date.now());
  const demo = options.demo ?? true;
  const importable = new Set(options.importable ?? []);
  const otherAgent = new Set(options.otherAgent ?? []);
  // One chain for every project, as on Stellar.
  const chain = new Map<string, FakeDestination>(Object.entries(options.destinations ?? {}));
  const chainSays = (address: string): FakeDestination => chain.get(address) ?? 'receivable';
  const data = new Map<string, ProjectData>();
  const signing = new Map<string, SigningRow>();
  const submits = new Map<string, SubmitOutcome>();
  let apiKey = false;
  let loseAnswer = false;
  let requests = 0;
  // Mandates whose chain read the overview misses, for tests.
  const unread = new Set<string>();

  const iso = (ms = now()) => new Date(ms).toISOString();

  function fail(code: string, status: number, message = ''): ApiError {
    requests += 1;
    return new ApiError(
      code,
      v1ErrorText(code, message),
      status,
      undefined,
      `fake-${String(requests)}`,
    );
  }

  // Everything a mandate write does is signed by a wallet, which a key does not have.
  function writer(): void {
    if (apiKey) throw fail('FORBIDDEN', 403, 'This takes a dashboard session, not an API key');
  }

  function project(t: FakeTenant): ProjectData {
    let d = data.get(t.projectId);
    if (d === undefined) {
      d = {
        mandates: new Map(),
        recipients: new Map(),
        payouts: new Map(),
        keys: new Map(),
        invites: new Map(),
        idempotency: new Map(),
      };
      data.set(t.projectId, d);
      if (demo) seed(d, t.address);
    }
    return d;
  }

  async function step<T>(fn: (t: FakeTenant, d: ProjectData) => T): Promise<T> {
    if (delayMs > 0) await sleep(delayMs);
    const t = auth.tenant();
    return fn(t, project(t));
  }

  function committed(m: MandateRow): bigint {
    return m.pending;
  }

  function mandateWire(m: MandateRow) {
    const expired = Date.parse(m.limits.expiresAt) <= now();
    const status = m.revoked ? 'revoked' : expired ? 'expired' : m.paused ? 'paused' : 'active';
    const free = m.balance - committed(m);
    return parse(mandateSchema, {
      id: m.id,
      name: m.name,
      contractId: m.contractId,
      network: FAKE_NETWORK,
      asset: FAKE_ASSET,
      status,
      depositAddress: m.contractId,
      createdAt: m.createdAt,
      config: {
        principal: m.principal,
        agents: ['GAGENTKEYFORTHISPROJECTXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX'],
        approvers: m.approvers,
        approvalsRequired: m.approvalsRequired,
        executors: ['GEXECUTORKEYOFUJIRAXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX'],
        limits: {
          totalBudget: usdc(m.limits.totalBudget),
          perPaymentCap: usdc(m.limits.perPaymentCap),
          perRecipientDailyCap: usdc(m.limits.perRecipientDailyCap),
          approvalThreshold: usdc(m.limits.approvalThreshold),
          payoutTtlSeconds: m.limits.payoutTtlSeconds,
          expiresAt: m.limits.expiresAt,
        },
      },
      state: {
        balance: usdc(m.balance),
        committed: usdc(committed(m)),
        spent: usdc(m.spent),
        pending: usdc(m.pending),
        free: usdc(free > 0n ? free : 0n),
        paused: m.paused,
        revoked: m.revoked,
        expired,
      },
    });
  }

  /** The server's status words: why a recipient cannot be paid, or active. */
  function payStatus(r: RecipientRow): string {
    if (r.suspended) return 'suspended';
    if (r.address === null) return 'needs_wallet';
    return r.check === 'receivable' ? 'active' : r.check;
  }

  function recipientWire(r: RecipientRow, detail = false) {
    const status = payStatus(r);
    return parse(recipientSchema, {
      id: r.id,
      mandateId: r.mandateId,
      label: r.label,
      address: r.address === null ? null : mask(r.address),
      status,
      payable: status === 'active',
      ...(detail ? { email: r.email } : {}),
      createdAt: r.createdAt,
    });
  }

  function inviteWire(i: InviteRow) {
    return parse(embedSessionSchema, i);
  }

  /** A wallet still waiting on its owner is asked about again, as the server does. */
  function recheck(r: RecipientRow): void {
    if (r.address === null || r.check === 'receivable') return;
    const said = chainSays(r.address);
    if (said === 'down' || said === 'needs_memo') return;
    r.check = said;
  }

  /** The words the server gives the one leg, from where its payout has got to. */
  function legStatus(p: PayoutRow): string {
    switch (p.status) {
      case 'paid':
        return 'settled';
      case 'submitting':
      case 'settling':
        return 'submitted';
      case 'failed':
        return 'failed';
      case 'blocked':
      case 'rejected':
      case 'cancelled':
      case 'expired':
        return 'cancelled';
      default:
        return 'planned';
    }
  }

  /** The steps a payout took, as the server lists them on its own page. */
  function timelineOf(p: PayoutRow) {
    const leg = legStatus(p);
    return [
      { event: 'created', at: p.createdAt, legIndex: null, txHash: null },
      ...(p.requestTxHash === null
        ? []
        : [{ event: 'requested', at: null, legIndex: null, txHash: p.requestTxHash }]),
      ...(leg === 'planned'
        ? []
        : [{ event: `leg_${leg}`, at: p.updatedAt, legIndex: 0, txHash: p.txHash }]),
      ...(p.status === 'queued'
        ? []
        : [{ event: p.status, at: p.settledAt ?? p.updatedAt, legIndex: null, txHash: null }]),
    ];
  }

  /** What the budget still allows with every waiting payout set aside, this one included. */
  function budgetLeft(m: MandateRow | undefined): TokenAmountWire | null {
    if (m === undefined) return null;
    const left = m.limits.totalBudget - m.spent - m.pending;
    return usdc(left > 0n ? left : 0n);
  }

  function payoutWire(
    t: { principalId: string; projectId: string },
    d: ProjectData,
    p: PayoutRow,
    extra: 'timeline' | 'budgetLeft' | null = null,
  ) {
    const m = d.mandates.get(p.mandateId);
    const r = d.recipients.get(p.recipientId);
    return parse(payoutSchema, {
      id: p.id,
      principalId: t.principalId,
      projectId: t.projectId,
      mandate: { id: p.mandateId, contractId: m?.contractId ?? '' },
      recipient: { id: p.recipientId, label: r?.label ?? '' },
      taskId: p.taskId,
      amount: usdc(p.amount),
      fee: usdc(0n),
      status: p.status,
      blockedBy: p.blockedBy,
      legs: [
        {
          index: 0,
          method: 'stellar.wallet',
          destination: r?.address === null || r === undefined ? '' : mask(r.address),
          amount: usdc(p.amount),
          status: legStatus(p),
          txHash: p.txHash,
        },
      ],
      onChainPayoutId: p.blockedBy === null ? p.onChainPayoutId : null,
      requestTxHash: p.requestTxHash,
      receiptId: p.receiptId,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
      settledAt: p.settledAt,
      ...(extra === 'timeline' ? { timeline: timelineOf(p) } : {}),
      ...(extra === 'budgetLeft' ? { budgetLeft: budgetLeft(m) } : {}),
    });
  }

  function receiptWire(d: ProjectData, p: PayoutRow) {
    const m = d.mandates.get(p.mandateId);
    const r = d.recipients.get(p.recipientId);
    return parse(receiptSchema, {
      id: p.receiptId ?? '',
      payoutId: p.id,
      mandate: { id: p.mandateId, contractId: m?.contractId ?? '' },
      recipient: { id: p.recipientId, label: r?.label ?? '' },
      taskId: p.taskId,
      amount: usdc(p.amount),
      fee: usdc(0n),
      outcome: p.status,
      blockedBy: p.blockedBy,
      txHash: p.txHash,
      ref: p.txHash === null ? null : `ujira:tx:v1:${FAKE_NETWORK}:${p.txHash}:0`,
      issuedAt: p.settledAt ?? p.updatedAt,
    });
  }

  function keyWire(t: { principalId: string; projectId: string }, k: ApiKeyRow) {
    return parse(apiKeySchema, {
      principalId: t.principalId,
      projectId: t.projectId,
      id: k.id,
      name: k.name,
      prefix: k.prefix,
      scopes: [...k.scopes],
      expiresAt: k.expiresAt,
      revokedAt: k.revokedAt,
      lastUsedAt: null,
      createdAt: k.createdAt,
    });
  }

  // Only owners and admins reach the key routes, listing included.
  function keyManager(t: FakeTenant): void {
    if (t.role !== 'owner' && t.role !== 'admin') throw fail('FORBIDDEN', 403);
  }

  function page<T>(
    items: readonly T[],
    q: { cursor?: string | undefined; limit?: number | undefined } | undefined,
    max = PAGE_MAX,
  ): Page<T> {
    const limit = q?.limit ?? PAGE_DEFAULT;
    if (!Number.isInteger(limit) || limit < 1 || limit > max) {
      throw fail('INVALID_REQUEST', 400, 'The page size is out of range.');
    }
    let offset = 0;
    if (q?.cursor !== undefined) {
      const match = /^o(\d{1,9})$/.exec(q.cursor);
      if (match === null)
        throw fail('INVALID_REQUEST', 400, 'The cursor is not one this API issued');
      offset = Number.parseInt(match[1] ?? '0', 10);
    }
    const slice = items.slice(offset, offset + limit);
    const next = offset + limit;
    return { items: slice, nextCursor: next < items.length ? `o${String(next)}` : null };
  }

  function mandateOf(d: ProjectData, id: string): MandateRow {
    const m = d.mandates.get(id);
    if (m === undefined) throw fail('NOT_FOUND', 404);
    return m;
  }

  function terminal(p: PayoutRow, status: string, at: string, txHash: string | null = null) {
    p.status = status;
    p.updatedAt = at;
    p.settledAt = at;
    p.txHash = txHash;
    p.receiptId = crypto.randomUUID();
  }

  /** What the mandate says about a payout, as the contract would decide it. */
  function decide(m: MandateRow, r: RecipientRow, amount: bigint): string | null {
    if (m.revoked) return 'MANDATE_REVOKED';
    if (Date.parse(m.limits.expiresAt) <= now()) return 'MANDATE_EXPIRED';
    if (m.paused) return 'MANDATE_PAUSED';
    if (r.address === null) return 'RECIPIENT_HAS_NO_METHOD';
    if (payStatus(r) !== 'active') return 'DESTINATION_NOT_RECEIVABLE';
    if (amount > m.limits.perPaymentCap) return 'PAYMENT_CAP_EXCEEDED';
    if (m.spent + m.pending + amount > m.limits.totalBudget) return 'BUDGET_EXCEEDED';
    if (amount > m.balance - committed(m)) return 'INSUFFICIENT_FUNDS';
    return null;
  }

  function addPayout(
    d: ProjectData,
    m: MandateRow,
    r: RecipientRow,
    taskId: string,
    amount: bigint,
    at: string,
  ): PayoutRow {
    const p: PayoutRow = {
      id: crypto.randomUUID(),
      mandateId: m.id,
      recipientId: r.id,
      taskId,
      amount,
      onChainPayoutId: hex(32),
      createdAt: at,
      status: 'queued',
      blockedBy: null,
      requestTxHash: null,
      txHash: null,
      receiptId: null,
      updatedAt: at,
      settledAt: null,
    };
    d.payouts.set(p.id, p);
    const refused = decide(m, r, amount);
    if (refused !== null) {
      p.blockedBy = refused;
      terminal(p, 'blocked', at);
    } else if (m.limits.approvalThreshold > 0n && amount >= m.limits.approvalThreshold) {
      p.status = 'pending_approval';
      p.requestTxHash = hex(32);
      m.pending += amount;
    } else {
      p.requestTxHash = hex(32);
      m.balance -= amount;
      m.spent += amount;
      terminal(p, 'paid', at, hex(32));
    }
    return p;
  }

  function seed(d: ProjectData, principal: string) {
    const day = 86_400_000;
    const t0 = now() - 3 * day;
    const m: MandateRow = {
      id: crypto.randomUUID(),
      name: 'Weekly payouts',
      contractId: strkey('C'),
      createdAt: iso(t0),
      principal,
      approvers: [principal],
      approvalsRequired: 1,
      limits: {
        totalBudget: 5_000n * UNIT,
        perPaymentCap: 500n * UNIT,
        perRecipientDailyCap: 1_000n * UNIT,
        approvalThreshold: 250n * UNIT,
        payoutTtlSeconds: 86_400,
        expiresAt: iso(now() + 90 * day),
      },
      balance: 2_000n * UNIT,
      spent: 0n,
      pending: 0n,
      paused: false,
      revoked: false,
    };
    d.mandates.set(m.id, m);
    const person = (label: string, address: string | null, check: StoredCheck = 'receivable') => {
      const r: RecipientRow = {
        id: crypto.randomUUID(),
        mandateId: m.id,
        label,
        address,
        email: null,
        createdAt: iso(t0),
        check,
        suspended: false,
      };
      d.recipients.set(r.id, r);
      return r;
    };
    const ada = person('Ada', strkey('G'));
    const kofi = person('Kofi', strkey('G'));
    // One who still has to add USDC to their wallet, and one with no wallet yet.
    const musa = strkey('G');
    chain.set(musa, 'no_trustline');
    person('Musa', musa, 'no_trustline');
    person('Zainab', null);
    addPayout(d, m, ada, 'task-101', 120n * UNIT, iso(t0 + day));
    addPayout(d, m, kofi, 'task-102', 300n * UNIT, iso(t0 + 2 * day));
    addPayout(d, m, kofi, 'task-103', 900n * UNIT, iso(t0 + 2 * day + 3_600_000));
  }

  function newSigningRequest(
    t: FakeTenant,
    signer: string,
    action: string,
    summary: string,
    pending: Pending,
  ): SigningRequest {
    const id = crypto.randomUUID();
    const expiresAt = now() + SIGNING_MS;
    const xdr = btoa(`fake ${action} ${id}`);
    signing.set(id, { projectId: t.projectId, expiresAt, signer, xdr, pending, submitted: false });
    return parse(signingRequestSchema, {
      id,
      network: FAKE_NETWORK,
      xdr,
      signer,
      action,
      summary,
      expiresAt: iso(expiresAt),
    });
  }

  function amountIn(a: TokenAmount): bigint {
    if (a.asset !== FAKE_ASSET || a.network !== FAKE_NETWORK || a.scale !== FAKE_SCALE) {
      throw fail('INVALID_REQUEST', 400, 'That asset is not paid on this network.');
    }
    if (a.amount <= 0n) throw fail('INVALID_REQUEST', 400, 'The amount must be more than zero.');
    return a.amount;
  }

  function sorted(d: ProjectData): PayoutRow[] {
    return [...d.payouts.values()].sort((a, b) =>
      a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : a.id < b.id ? 1 : -1,
    );
  }

  function filtered(
    d: ProjectData,
    q:
      | {
          status?: string | undefined;
          mandateId?: string | undefined;
          recipientId?: string | undefined;
          createdFrom?: string | undefined;
          createdTo?: string | undefined;
        }
      | undefined,
  ): PayoutRow[] {
    const statuses = q?.status === undefined ? null : new Set(q.status.split(','));
    return sorted(d).filter(
      (p) =>
        (statuses === null || statuses.has(p.status)) &&
        (q?.mandateId === undefined || p.mandateId === q.mandateId) &&
        (q?.recipientId === undefined || p.recipientId === q.recipientId) &&
        (q?.createdFrom === undefined || p.createdAt >= q.createdFrom) &&
        (q?.createdTo === undefined || p.createdAt < q.createdTo),
    );
  }

  /**
   * The payouts that have a receipt, as the receipt routes filter them: the
   * status is the outcome, the days are the issue date, newest issued first.
   */
  function withReceipts(d: ProjectData, q: Parameters<typeof filtered>[1]): PayoutRow[] {
    const issued = (p: PayoutRow) => p.settledAt ?? p.updatedAt;
    return filtered(d, { ...q, createdFrom: undefined, createdTo: undefined })
      .filter(
        (p) =>
          p.receiptId !== null &&
          (q?.createdFrom === undefined || issued(p) >= q.createdFrom) &&
          (q?.createdTo === undefined || issued(p) < q.createdTo),
      )
      .sort((a, b) => (issued(a) < issued(b) ? 1 : issued(a) > issued(b) ? -1 : 0));
  }

  /**
   * The server's checks on a signed transaction, in its order. The fake
   * wallet signs as the member signed in, so a request that names another
   * wallet fails its signature check.
   */
  function relay(t: FakeTenant, d: ProjectData, id: string, xdr: string): Submitted {
    const request = signing.get(id);
    // Only in the project that asked for it.
    if (request?.projectId !== t.projectId) throw fail('NOT_FOUND', 404);
    if (request.submitted) throw fail('SIGNING_REQUEST_USED', 409);
    if (request.expiresAt <= now()) throw fail('SIGNING_REQUEST_EXPIRED', 410);
    if (xdr !== request.xdr) throw fail('SIGNING_REQUEST_MISMATCH', 422);
    if (request.signer !== t.address) throw fail('SIGNATURE_INVALID', 422);
    const answer = apply(d, request.pending);
    request.submitted = true;
    if (loseAnswer) {
      loseAnswer = false;
      throw fail('CHAIN_UNAVAILABLE', 503);
    }
    return answer;
  }

  /** What the chain does with a transaction it takes. */
  function apply(d: ProjectData, pending: Pending): Submitted {
    const txHash = hex(32);
    const at = iso();
    if (pending.kind === 'create') {
      const l = pending.input.limits;
      const m: MandateRow = {
        id: crypto.randomUUID(),
        name: pending.input.name?.trim() ?? null,
        contractId: strkey('C'),
        createdAt: at,
        principal: pending.principal,
        // Prepare already named the owner when no approver was given.
        approvers: pending.input.approvers,
        approvalsRequired: pending.input.approvalsRequired,
        limits: {
          totalBudget: l.totalBudget.amount,
          perPaymentCap: l.perPaymentCap.amount,
          perRecipientDailyCap: l.perRecipientDailyCap.amount,
          approvalThreshold: l.approvalThreshold.amount,
          payoutTtlSeconds: l.payoutTtlSeconds,
          expiresAt: l.expiresAt,
        },
        balance: 0n,
        spent: 0n,
        pending: 0n,
        paused: false,
        revoked: false,
      };
      d.mandates.set(m.id, m);
      return parse(submittedSchema, { txHash, mandateId: m.id });
    }
    const m = mandateOf(d, pending.mandateId);
    const a = pending.action;
    switch (a.kind) {
      case 'fund':
        m.balance += a.amount;
        break;
      case 'withdraw':
        m.balance -= a.amount;
        break;
      case 'pause':
        m.paused = true;
        break;
      case 'resume':
        m.paused = false;
        break;
      case 'revoke':
        // What is not promised to a waiting payout goes back to the wallet.
        m.revoked = true;
        m.balance = committed(m);
        break;
      case 'allow_recipients':
        break;
      case 'approve':
      case 'reject': {
        const p = d.payouts.get(a.payoutId);
        if (p?.status === 'pending_approval') {
          m.pending -= p.amount;
          if (a.kind === 'approve') {
            m.balance -= p.amount;
            m.spent += p.amount;
            terminal(p, 'paid', at, hex(32));
          } else {
            terminal(p, 'rejected', at);
          }
        }
        break;
      }
    }
    // Like the server, an action answers with the mandate it was for.
    return parse(submittedSchema, { txHash, mandateId: m.id });
  }

  return {
    mandates: (q) =>
      step((_t, d) => {
        const all = [...d.mandates.values()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
        return page(all.map(mandateWire), q);
      }),
    mandate: (id) => step((_t, d) => mandateWire(mandateOf(d, id))),
    prepareMandate: (input) =>
      step((t) => {
        writer();
        const name = input.name?.trim() ?? '';
        if (input.name !== undefined && (name === '' || name.length > 60)) {
          throw fail('INVALID_REQUEST', 400, 'Name the mandate in up to 60 characters.');
        }
        // A recipient belongs to one mandate, so none can be named before it exists.
        if ((input.recipients ?? []).length > 0) {
          throw fail('INVALID_REQUEST', 400, 'The request is not valid');
        }
        if ((input.recipientMode ?? 'allowlist') !== 'allowlist') {
          throw fail('RECIPIENT_MODE_UNSUPPORTED', 422);
        }
        // With no approvers named, the owner's wallet is the one approver.
        const approvers = input.approvers.length === 0 ? [t.address] : input.approvers;
        if (
          approvers.some((a) => !STELLAR_ACCOUNT.test(a)) ||
          new Set(approvers).size !== approvers.length ||
          input.approvalsRequired < 1 ||
          input.approvalsRequired > approvers.length
        ) {
          throw fail('INVALID_REQUEST', 400, 'The request is not valid');
        }
        const l = input.limits;
        for (const a of [l.totalBudget, l.perPaymentCap, l.perRecipientDailyCap]) amountIn(a);
        if (l.approvalThreshold.amount < 0n) throw fail('INVALID_REQUEST', 400);
        if (Number.isNaN(Date.parse(l.expiresAt)) || Date.parse(l.expiresAt) <= now()) {
          throw fail('INVALID_REQUEST', 400, 'The end date must be in the future.');
        }
        const principal = t.address;
        return newSigningRequest(t, principal, 'create', 'Create a mandate with these rules', {
          kind: 'create',
          input: { ...input, approvers },
          principal,
        });
      }),
    importMandate: (contractId) =>
      step((t, d) => {
        writer();
        if (!STELLAR_CONTRACT.test(contractId)) {
          throw fail('INVALID_REQUEST', 400, 'That is not a Stellar contract address.');
        }
        const found = [...d.mandates.values()].find((m) => m.contractId === contractId);
        if (found !== undefined) return mandateWire(found);
        // The chain is read first: whose wallet owns it, then which agent it names.
        const elsewhere = [...data.values()].some((other) =>
          [...other.mandates.values()].some((m) => m.contractId === contractId),
        );
        if (!importable.has(contractId) && !otherAgent.has(contractId) && !elsewhere) {
          throw fail('MANDATE_PRINCIPAL_MISMATCH', 403);
        }
        if (otherAgent.has(contractId)) throw fail('MANDATE_AGENT_MISMATCH', 422);
        if (elsewhere) throw fail('MANDATE_TAKEN', 409);
        const m: MandateRow = {
          id: crypto.randomUUID(),
          name: null,
          contractId,
          createdAt: iso(),
          principal: t.address,
          approvers: [t.address],
          approvalsRequired: 1,
          limits: {
            totalBudget: 1_000n * UNIT,
            perPaymentCap: 100n * UNIT,
            perRecipientDailyCap: 200n * UNIT,
            approvalThreshold: 0n,
            payoutTtlSeconds: 86_400,
            expiresAt: iso(now() + 30 * 86_400_000),
          },
          balance: 0n,
          spent: 0n,
          pending: 0n,
          paused: false,
          revoked: false,
        };
        d.mandates.set(m.id, m);
        return mandateWire(m);
      }),
    mandateAction: (id, action) =>
      step((t, d) => {
        writer();
        const m = mandateOf(d, id);
        if (m.revoked) throw fail('INVALID_REQUEST', 400, 'This mandate was revoked.');
        if (action.kind === 'withdraw' && action.amount > m.balance - committed(m)) {
          throw fail('INVALID_REQUEST', 400, 'That is more than the mandate holds free.');
        }
        const decides = action.kind === 'approve' || action.kind === 'reject';
        if (decides) {
          const p = d.payouts.get(action.payoutId);
          if (p === undefined || p.mandateId !== m.id) throw fail('NOT_FOUND', 404);
          if (p.status !== 'pending_approval') {
            throw fail('INVALID_REQUEST', 400, 'That payout is not waiting for approval.');
          }
          // The contract takes a decision only from a wallet it names as an approver.
          if (!m.approvers.includes(t.address)) throw fail('FORBIDDEN', 403);
        }
        return newSigningRequest(
          t,
          // A decision is signed by the approver who makes it; the rest by the owner.
          decides ? t.address : m.principal,
          action.kind,
          `${action.kind} on ${mask(m.contractId)}`,
          {
            kind: 'action',
            mandateId: m.id,
            action,
          },
        );
      }),
    // The console keys each submit by its request, so a retry replays the first
    // answer, a refusal included, and never relays twice. A 5xx or a 429 is
    // not kept, since the server keeps only final answers.
    submitSigned: (signingRequestId, xdr) =>
      step((t, d) => {
        writer();
        if (xdr === '') throw fail('INVALID_REQUEST', 400, 'The request is not valid');
        const key = `${t.projectId}:submit:${signingRequestId}`;
        const seen = submits.get(key);
        if (seen !== undefined) {
          if (seen.xdr !== xdr) throw fail('IDEMPOTENCY_KEY_REUSED', 422);
          if ('error' in seen) throw seen.error;
          return seen.answer;
        }
        try {
          const answer = relay(t, d, signingRequestId, xdr);
          submits.set(key, { xdr, answer });
          return answer;
        } catch (error) {
          if (error instanceof ApiError && error.status < 500 && error.status !== 429) {
            submits.set(key, { xdr, error });
          }
          throw error;
        }
      }),
    recipients: (q) =>
      step((_t, d) => {
        if (q?.mandateId !== undefined && !UUID.test(q.mandateId)) {
          throw fail('INVALID_REQUEST', 400, 'The mandate ID is not valid.');
        }
        return page(
          [...d.recipients.values()]
            .filter((r) => q?.mandateId === undefined || r.mandateId === q.mandateId)
            .sort((a, b) => a.label.localeCompare(b.label))
            .map((r) => recipientWire(r)),
          q,
          SMALL_PAGE_MAX,
        );
      }),
    recipient: (id) =>
      step((_t, d) => {
        const r = d.recipients.get(id);
        if (r === undefined) throw fail('NOT_FOUND', 404);
        recheck(r);
        return recipientWire(r, true);
      }),
    createRecipient: (input) =>
      step((t, d) => {
        const label = input.label.trim();
        if (label === '' || label.length > LABEL_MAX || CONTROL.test(label)) {
          throw fail('INVALID_REQUEST', 400, 'Enter a name of up to 100 characters.');
        }
        const email = input.email ?? null;
        if (email !== null && (email.length > 254 || !EMAIL.test(email))) {
          throw fail('INVALID_REQUEST', 400, 'That is not an email address.');
        }
        const address = input.address ?? null;
        if (address !== null && !STELLAR_ACCOUNT.test(address)) {
          throw fail('INVALID_REQUEST', 400, 'The address is not an account address');
        }
        const m = mandateOf(d, input.mandateId);
        const lower = label.toLowerCase();
        if (
          [...d.recipients.values()].some(
            (r) => r.mandateId === m.id && r.label.toLowerCase() === lower,
          )
        ) {
          throw fail('RECIPIENT_LABEL_TAKEN', 409);
        }
        let check: StoredCheck = 'receivable';
        if (address !== null) {
          const said = chainSays(address);
          if (said === 'down') throw fail('CHAIN_UNAVAILABLE', 503);
          if (said === 'needs_memo') {
            throw fail(
              'INVALID_REQUEST',
              400,
              'That address needs a memo, which a wallet payout does not send',
            );
          }
          check = said;
        }
        const r: RecipientRow = {
          id: crypto.randomUUID(),
          mandateId: m.id,
          label,
          address,
          email,
          createdAt: iso(),
          check,
          suspended: false,
        };
        d.recipients.set(r.id, r);
        const signingRequest =
          address === null
            ? null
            : newSigningRequest(t, m.principal, 'allow_recipients', `Allow ${label}`, {
                kind: 'action',
                mandateId: m.id,
                action: { kind: 'allow_recipients', recipientIds: [r.id] },
              });
        return { recipient: recipientWire(r), signingRequest };
      }),
    embedSessions: (q) =>
      step((_t, d) => {
        if (!d.recipients.has(q.recipientId)) throw fail('NOT_FOUND', 404);
        return page(
          [...d.invites.values()]
            .filter((i) => i.recipientId === q.recipientId)
            .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
            .map(inviteWire),
          q,
          SMALL_PAGE_MAX,
        );
      }),
    createEmbedSession: (input) =>
      step((_t, d) => {
        const r = d.recipients.get(input.recipientId);
        if (r === undefined) throw fail('NOT_FOUND', 404);
        const s = input.expiresInSeconds;
        if (!Number.isInteger(s) || s < INVITE_MIN_S || s > INVITE_MAX_S) {
          throw fail('INVALID_REQUEST', 400, 'An invite lasts from 5 minutes to 7 days.');
        }
        if (r.suspended) throw fail('FORBIDDEN', 403);
        const at = now();
        const i: InviteRow = {
          id: crypto.randomUUID(),
          recipientId: r.id,
          createdAt: iso(at),
          expiresAt: iso(at + s * 1000),
          revokedAt: null,
        };
        d.invites.set(i.id, i);
        // Like the server, only the session is kept; the token leaves once.
        return { session: inviteWire(i), token: `ujes_test_${hex(24)}` };
      }),
    revokeEmbedSession: (id) =>
      step((_t, d) => {
        const i = d.invites.get(id);
        if (i === undefined) throw fail('NOT_FOUND', 404);
        i.revokedAt ??= iso();
      }),
    createPayout: (input, idempotencyKey) =>
      step((t, d) => {
        if (!IDEMPOTENCY_KEY.test(idempotencyKey)) {
          throw fail('IDEMPOTENCY_KEY_INVALID', 400, 'The Idempotency-Key header is not valid.');
        }
        const body = bodyKey(input);
        const seen = d.idempotency.get(idempotencyKey);
        if (seen !== undefined) {
          if (seen.body !== body) throw fail('IDEMPOTENCY_KEY_REUSED', 422);
          const replay = d.payouts.get(seen.payoutId);
          if (replay !== undefined) return payoutWire(t, d, replay);
        }
        const m = mandateOf(d, input.mandateId);
        const r = d.recipients.get(input.recipientId);
        if (r === undefined) throw fail('NOT_FOUND', 404);
        const amount = amountIn(input.amount);
        if (input.taskId.trim() === '' || input.taskId.length > 128) {
          throw fail('INVALID_REQUEST', 400, 'Give the payout a task ID of up to 128 characters.');
        }
        if (
          [...d.payouts.values()].some((p) => p.mandateId === m.id && p.taskId === input.taskId)
        ) {
          throw fail('TASK_ID_REUSED', 409);
        }
        const p = addPayout(d, m, r, input.taskId, amount, iso());
        d.idempotency.set(idempotencyKey, { body, payoutId: p.id });
        return payoutWire(t, d, p);
      }),
    payouts: (q) =>
      step((t, d) =>
        page(
          filtered(d, q).map((p) => payoutWire(t, d, p)),
          q,
        ),
      ),
    payout: (id) =>
      step((t, d) => {
        const p = d.payouts.get(id);
        if (p === undefined) throw fail('NOT_FOUND', 404);
        return payoutWire(t, d, p, 'timeline');
      }),
    // Oldest first: the payout that has waited longest is decided first.
    approvals: (q) =>
      step((t, d) =>
        page(
          filtered(d, { status: 'pending_approval' })
            .reverse()
            .map((p) => payoutWire(t, d, p, 'budgetLeft')),
          q,
        ),
      ),
    receipts: (q) =>
      step((_t, d) =>
        page(
          withReceipts(d, q).map((p) => receiptWire(d, p)),
          q,
        ),
      ),
    receipt: (id) =>
      step((_t, d) => {
        const p = [...d.payouts.values()].find((x) => x.receiptId === id);
        if (p === undefined) throw fail('NOT_FOUND', 404);
        return receiptWire(d, p);
      }),
    receiptsCsv: (q) =>
      step((_t, d) => {
        const rows = withReceipts(d, q).map((p) => {
          const r = receiptWire(d, p);
          return [
            r.id,
            r.payoutId,
            r.taskId,
            r.recipient.label,
            formatAmount(r.amount.amount, { decimals: r.amount.scale, grouping: false }),
            r.amount.asset,
            r.outcome,
            r.blockedBy ?? '',
            r.txHash ?? '',
            r.issuedAt,
          ]
            .map(csvCell)
            .join(',');
        });
        const header =
          'receipt_id,payout_id,task_id,recipient,amount,asset,outcome,blocked_by,tx_hash,issued_at';
        return [header, ...rows].join('\n') + '\n';
      }),
    verifyReceipt: (id) =>
      step((_t, d) => {
        const p = [...d.payouts.values()].find((x) => x.receiptId === id);
        if (p === undefined) throw fail('NOT_FOUND', 404);
        return parse(
          receiptVerificationSchema,
          p.txHash === null
            ? { matched: false, field: 'txHash', txHash: null }
            : { matched: true, field: null, txHash: p.txHash },
        );
      }),
    // The server lists keys by id, revoked and expired ones too, 100 a page at most.
    apiKeys: (q) =>
      step((t, d) => {
        const rows = [...d.keys.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
        const listed = page(rows, q, SMALL_PAGE_MAX);
        keyManager(t);
        return { items: listed.items.map((k) => keyWire(t, k)), nextCursor: listed.nextCursor };
      }),
    createApiKey: (input) =>
      step((t, d) => {
        // The body is checked before the role, as the server's schema runs first.
        const name = input.name.trim();
        if (name === '' || name.length > KEY_NAME_MAX || /\p{Cc}/u.test(name)) {
          throw fail('INVALID_REQUEST', 400, 'Name the key in up to 100 characters.');
        }
        const known = new Set<string>(API_SCOPES);
        if (
          input.scopes.length === 0 ||
          input.scopes.some((s) => !known.has(s)) ||
          new Set(input.scopes).size !== input.scopes.length
        ) {
          throw fail('INVALID_REQUEST', 400, 'Choose each scope at most once, from the list.');
        }
        const days = input.expiresInDays ?? EXPIRY_DEFAULT_DAYS;
        if (!Number.isInteger(days) || days < 1 || days > EXPIRY_MAX_DAYS) {
          throw fail('INVALID_REQUEST', 400, 'A key lasts from 1 to 730 days.');
        }
        keyManager(t);
        const at = now();
        const active = [...d.keys.values()].filter(
          (k) => k.revokedAt === null && Date.parse(k.expiresAt) > at,
        ).length;
        if (active >= KEY_LIMIT) throw fail('API_KEY_LIMIT_REACHED', 409);
        const prefix = `ujk_test_${base32(16)}`;
        // The whole key leaves in this answer only; the fake keeps the prefix, as the server does.
        const secret = `${prefix}_${base32(52)}${base32(7)}`;
        const k: ApiKeyRow = {
          id: crypto.randomUUID(),
          name,
          prefix,
          scopes: [...input.scopes],
          expiresAt: iso(at + days * DAY_MS),
          createdAt: iso(at),
          revokedAt: null,
        };
        d.keys.set(k.id, k);
        return { apiKey: keyWire(t, k), secret };
      }),
    revokeApiKey: (id) =>
      step((t, d) => {
        if (!UUID.test(id)) throw fail('INVALID_REQUEST', 400);
        keyManager(t);
        const k = d.keys.get(id);
        // Another project's key reads exactly like one that never existed.
        if (k === undefined) throw fail('NOT_FOUND', 404);
        k.revokedAt ??= iso();
        return keyWire(t, k);
      }),
    // Like the server: the last 7 days of the principal's zone (UTC here), today
    // included, from inclusive and to exclusive; balances for the first 50 mandates.
    overview: (q) =>
      step((_t, d) => {
        const parsed = (raw: string | undefined) => {
          if (raw === undefined) return undefined;
          const ms = Date.parse(raw);
          if (Number.isNaN(ms)) throw fail('INVALID_REQUEST', 400, 'That is not a time.');
          return ms;
        };
        const today = new Date(now());
        const tonight = Date.UTC(
          today.getUTCFullYear(),
          today.getUTCMonth(),
          today.getUTCDate() + 1,
        );
        const to = parsed(q?.to) ?? tonight;
        const from = parsed(q?.from) ?? to - OVERVIEW_DAYS * DAY_MS;
        if (from >= to) throw fail('INVALID_REQUEST', 400, 'The period must start before it ends.');
        const byStatus: Record<string, number> = {};
        const blockedByRule: Record<string, number> = {};
        let paid = 0n;
        for (const p of d.payouts.values()) {
          const at = Date.parse(p.createdAt);
          if (at < from || at >= to) continue;
          byStatus[p.status] = (byStatus[p.status] ?? 0) + 1;
          if (p.status === 'paid') paid += p.amount;
          if (p.status === 'blocked' && p.blockedBy !== null) {
            blockedByRule[p.blockedBy] = (blockedByRule[p.blockedBy] ?? 0) + 1;
          }
        }
        const all = [...d.mandates.values()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
        const read = all.slice(0, OVERVIEW_MANDATES).map((m) => {
          const w = mandateWire(m);
          return {
            id: m.id,
            contractId: m.contractId,
            name: m.name ?? '',
            state: unread.has(m.id)
              ? null
              : {
                  balance: usdc(w.state.balance.amount),
                  committed: usdc(w.state.committed.amount),
                  free: usdc(w.state.free.amount),
                },
          };
        });
        return parse(overviewSchema, {
          period: { from: iso(from), to: iso(to), timeZone: 'UTC' },
          // One total per token the project's mandates hold, zero included.
          paid: all.length === 0 ? [] : [usdc(paid)],
          byStatus,
          blockedByRule,
          approvalsWaiting: [...d.payouts.values()].filter((p) => p.status === 'pending_approval')
            .length,
          mandates: read,
          moreMandates: all.length > OVERVIEW_MANDATES,
        });
      }),
    setUnread: (mandateId, unanswered) => {
      if (unanswered) unread.add(mandateId);
      else unread.delete(mandateId);
    },
    signingRequests: () => [...signing.values()].filter((r) => !r.submitted).length,
    setDestination: (address, state) => {
      chain.set(address, state);
    },
    suspendRecipient: (id) => {
      for (const d of data.values()) {
        const r = d.recipients.get(id);
        if (r !== undefined) r.suspended = true;
      }
    },
    useApiKey: (on) => {
      apiKey = on;
    },
    loseNextAnswer: () => {
      loseAnswer = true;
    },
  };
}
