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

import * as z from 'zod/mini';

import { ApiError } from './api';
import type { FakeAuthApi, FakeTenant } from './fakeAuth';
import { formatAmount } from './money';
import { v1ErrorText, type MandateActionInput, type PrepareMandateInput, type V1Api } from './v1';
import {
  apiKeySchema,
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
  type TokenAmount,
  type TokenAmountWire,
} from './v1Schemas';

export const FAKE_NETWORK = 'stellar:testnet';
export const FAKE_ASSET = 'USDC';
export const FAKE_SCALE = 7;

const SCOPES = [
  'mandates:read',
  'recipients:read',
  'recipients:write',
  'payouts:read',
  'payouts:write',
] as const;
const PAGE_DEFAULT = 50;
const PAGE_MAX = 200;
const SIGNING_MS = 10 * 60 * 1000;
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
}

export interface FakeV1Api extends V1Api {
  /** How many signing requests wait for a signed transaction; for tests. */
  readonly signingRequests: () => number;
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

interface RecipientRow {
  readonly id: string;
  readonly label: string;
  readonly address: string | null;
  readonly createdAt: string;
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
  readonly name: string;
  readonly prefix: string;
  readonly scopes: readonly string[];
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
  readonly idempotency: Map<string, { readonly body: string; readonly payoutId: string }>;
}

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
  const data = new Map<string, ProjectData>();
  const signing = new Map<
    string,
    { readonly projectId: string; readonly expiresAt: number; readonly pending: Pending }
  >();
  let requests = 0;

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

  function project(t: FakeTenant): ProjectData {
    let d = data.get(t.projectId);
    if (d === undefined) {
      d = {
        mandates: new Map(),
        recipients: new Map(),
        payouts: new Map(),
        keys: new Map(),
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

  function recipientWire(r: RecipientRow) {
    return parse(recipientSchema, {
      id: r.id,
      label: r.label,
      address: r.address === null ? null : mask(r.address),
      status: 'active',
      createdAt: r.createdAt,
    });
  }

  function payoutWire(t: { principalId: string; projectId: string }, d: ProjectData, p: PayoutRow) {
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
          status: p.status,
          txHash: p.txHash,
        },
      ],
      onChainPayoutId: p.blockedBy === null ? p.onChainPayoutId : null,
      requestTxHash: p.requestTxHash,
      receiptId: p.receiptId,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
      settledAt: p.settledAt,
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

  function keyWire(k: ApiKeyRow) {
    return parse(apiKeySchema, { ...k, lastUsedAt: null });
  }

  function page<T>(
    items: readonly T[],
    q: { cursor?: string | undefined; limit?: number | undefined } | undefined,
  ): Page<T> {
    const limit = q?.limit ?? PAGE_DEFAULT;
    if (!Number.isInteger(limit) || limit < 1 || limit > PAGE_MAX) {
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
      approvers: [],
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
    const ada: RecipientRow = {
      id: crypto.randomUUID(),
      label: 'Ada',
      address: strkey('G'),
      createdAt: iso(t0),
    };
    const kofi: RecipientRow = {
      id: crypto.randomUUID(),
      label: 'Kofi',
      address: strkey('G'),
      createdAt: iso(t0),
    };
    d.recipients.set(ada.id, ada);
    d.recipients.set(kofi.id, kofi);
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
    signing.set(id, { projectId: t.projectId, expiresAt, pending });
    return parse(signingRequestSchema, {
      id,
      network: FAKE_NETWORK,
      xdr: btoa(`fake ${action} ${id}`),
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

  return {
    mandates: (q) =>
      step((_t, d) => {
        const all = [...d.mandates.values()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
        return page(all.map(mandateWire), q);
      }),
    mandate: (id) => step((_t, d) => mandateWire(mandateOf(d, id))),
    prepareMandate: (input) =>
      step((t, d) => {
        const name = input.name?.trim() ?? '';
        if (input.name !== undefined && (name === '' || name.length > 60)) {
          throw fail('INVALID_REQUEST', 400, 'Name the mandate in up to 60 characters.');
        }
        // Only recipients of this project with a wallet can go on the allow list.
        for (const rid of input.recipients) {
          const r = d.recipients.get(rid);
          if (r === undefined || r.address === null) {
            throw fail('INVALID_REQUEST', 400, 'Every recipient needs a wallet first.');
          }
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
          input,
          principal,
        });
      }),
    importMandate: (contractId) =>
      step((t, d) => {
        if (!STELLAR_CONTRACT.test(contractId)) {
          throw fail('INVALID_REQUEST', 400, 'That is not a Stellar contract address.');
        }
        const found = [...d.mandates.values()].find((m) => m.contractId === contractId);
        if (found !== undefined) return mandateWire(found);
        if (!importable.has(contractId)) throw fail('FORBIDDEN', 403);
        const m: MandateRow = {
          id: crypto.randomUUID(),
          name: null,
          contractId,
          createdAt: iso(),
          principal: t.address,
          approvers: [],
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
        const m = mandateOf(d, id);
        if (m.revoked) throw fail('INVALID_REQUEST', 400, 'This mandate was revoked.');
        if (action.kind === 'withdraw' && action.amount > m.balance - committed(m)) {
          throw fail('INVALID_REQUEST', 400, 'That is more than the mandate holds free.');
        }
        if (action.kind === 'approve' || action.kind === 'reject') {
          const p = d.payouts.get(action.payoutId);
          if (p === undefined || p.mandateId !== m.id) throw fail('NOT_FOUND', 404);
          if (p.status !== 'pending_approval') {
            throw fail('INVALID_REQUEST', 400, 'That payout is not waiting for approval.');
          }
        }
        return newSigningRequest(
          t,
          m.principal,
          action.kind,
          `${action.kind} on ${mask(m.contractId)}`,
          {
            kind: 'action',
            mandateId: m.id,
            action,
          },
        );
      }),
    submitSigned: (signingRequestId, xdr) =>
      step((t, d) => {
        const request = signing.get(signingRequestId);
        // Single use, and only in the project that asked for it.
        if (request?.projectId !== t.projectId) throw fail('NOT_FOUND', 404);
        signing.delete(signingRequestId);
        if (request.expiresAt <= now()) {
          throw fail('INVALID_REQUEST', 400, 'The signing request ran out of time.');
        }
        if (xdr === '') throw fail('INVALID_REQUEST', 400, 'The transaction is not signed.');
        const txHash = hex(32);
        const at = iso();
        const pending = request.pending;
        if (pending.kind === 'create') {
          const l = pending.input.limits;
          const m: MandateRow = {
            id: crypto.randomUUID(),
            name: pending.input.name?.trim() ?? null,
            contractId: strkey('C'),
            createdAt: at,
            principal: pending.principal,
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
        return parse(submittedSchema, { txHash, mandateId: null });
      }),
    recipients: (q) =>
      step((_t, d) =>
        page(
          [...d.recipients.values()]
            .sort((a, b) => a.label.localeCompare(b.label))
            .map(recipientWire),
          q,
        ),
      ),
    recipient: (id) =>
      step((_t, d) => {
        const r = d.recipients.get(id);
        if (r === undefined) throw fail('NOT_FOUND', 404);
        return recipientWire(r);
      }),
    createRecipient: (input) =>
      step((t, d) => {
        const label = input.label.trim();
        if (label === '' || label.length > 80) {
          throw fail('INVALID_REQUEST', 400, 'Enter a name of up to 80 characters.');
        }
        const address = input.address ?? null;
        if (address !== null && !STELLAR_ACCOUNT.test(address)) {
          throw fail('INVALID_REQUEST', 400, 'That is not a Stellar account address.');
        }
        const m = input.mandateId === undefined ? null : mandateOf(d, input.mandateId);
        const r: RecipientRow = { id: crypto.randomUUID(), label, address, createdAt: iso() };
        d.recipients.set(r.id, r);
        const signingRequest =
          m === null || address === null
            ? null
            : newSigningRequest(t, m.principal, 'allow_recipients', `Allow ${label}`, {
                kind: 'action',
                mandateId: m.id,
                action: { kind: 'allow_recipients', recipientIds: [r.id] },
              });
        return { recipient: recipientWire(r), signingRequest };
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
        return payoutWire(t, d, p);
      }),
    approvals: (q) =>
      step((t, d) =>
        page(
          filtered(d, { status: 'pending_approval' }).map((p) => payoutWire(t, d, p)),
          q,
        ),
      ),
    receipts: (q) =>
      step((_t, d) =>
        page(
          filtered(d, q)
            .filter((p) => p.receiptId !== null)
            .map((p) => receiptWire(d, p)),
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
        const rows = filtered(d, q)
          .filter((p) => p.receiptId !== null)
          .map((p) => {
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
    apiKeys: (q) =>
      step((_t, d) =>
        page(
          [...d.keys.values()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)).map(keyWire),
          q,
        ),
      ),
    createApiKey: (input) =>
      step((t, d) => {
        if (t.role !== 'owner' && t.role !== 'admin') throw fail('FORBIDDEN', 403);
        const name = input.name.trim();
        if (name === '' || name.length > 80) {
          throw fail('INVALID_REQUEST', 400, 'Enter a name of up to 80 characters.');
        }
        const known = new Set<string>(SCOPES);
        if (input.scopes.length === 0 || input.scopes.some((s) => !known.has(s))) {
          throw fail('INVALID_REQUEST', 400, 'Choose at least one scope from the list.');
        }
        const secret = `ujk_test_${hex(24)}`;
        const k: ApiKeyRow = {
          id: crypto.randomUUID(),
          name,
          prefix: secret.slice(0, 13),
          scopes: [...new Set(input.scopes)],
          createdAt: iso(),
          revokedAt: null,
        };
        d.keys.set(k.id, k);
        return { apiKey: keyWire(k), secret };
      }),
    revokeApiKey: (id) =>
      step((t, d) => {
        if (t.role !== 'owner' && t.role !== 'admin') throw fail('FORBIDDEN', 403);
        const k = d.keys.get(id);
        if (k === undefined) throw fail('NOT_FOUND', 404);
        k.revokedAt ??= iso();
      }),
    overview: (q) =>
      step((_t, d) => {
        const at = new Date(now());
        const from = q?.from ?? iso(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1));
        const to = q?.to ?? iso();
        const byStatus: Record<string, number> = {};
        let paid = 0n;
        for (const p of d.payouts.values()) {
          if (p.createdAt < from || p.createdAt > to) continue;
          byStatus[p.status] = (byStatus[p.status] ?? 0) + 1;
          if (p.status === 'paid') paid += p.amount;
        }
        return parse(overviewSchema, {
          period: { from, to },
          paid: [usdc(paid)],
          byStatus,
          approvalsWaiting: [...d.payouts.values()].filter((p) => p.status === 'pending_approval')
            .length,
        });
      }),
    signingRequests: () => signing.size,
  };
}
