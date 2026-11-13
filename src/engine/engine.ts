// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The payout engine: quote, request, status and receipts, for one mandate and
// one agent key. Every request is checked against the mandate before money
// moves, and the mandate itself is asked again by simulation and by the
// transaction, so a wrong prediction can block a payout but never pay one.
//
// Idempotency: the payout ID is derived from the mandate and the task ID, and
// the mandate never accepts an ID twice. Calling request_payout again for the
// same task resumes it from what the chain says (pending, approved, paid,
// rejected or cancelled) instead of paying again.

import { z } from 'zod';

import { ContractRefusedError, EngineError } from '../errors.js';
import { defaultRecipientRef, payoutIdFor, taskId, taskRefFor, type Hex32 } from '../ids.js';
import type { MandateClient } from '../mandate/client.js';
import {
  PAYOUT_STATUS,
  statusName,
  type PayoutEntry,
  type PayoutRequest,
} from '../mandate/types.js';
import { minorUnits } from '../money.js';
import { RAIL_NAMES, type PayoutRail, type RailName } from '../rails/rail.js';
import {
  OUTCOMES,
  receiptToJson,
  type Outcome,
  type Receipt,
  type ReceiptLog,
} from '../receipts/log.js';
import type { TxSigner } from '../stellar/gateway.js';
import { quote, type Quote, type QuoteFacts } from './quote.js';

export const quoteInput = z.object({
  task_id: taskId.optional(),
  recipient: z.string().min(1).max(256),
  amount: minorUnits,
  rail: z.enum(RAIL_NAMES).default('usdc'),
});

export const payoutInput = quoteInput.extend({ task_id: taskId });

export const statusInput = z.object({ task_id: taskId });

export const listInput = z.object({
  task_id: taskId.optional(),
  outcome: z.enum(OUTCOMES).optional(),
  limit: z.number().int().min(1).max(500).default(50),
  verify: z.boolean().default(false),
});

export interface EngineOptions {
  readonly mandate: MandateClient;
  readonly agent: TxSigner;
  readonly rails: readonly PayoutRail[];
  readonly receipts: ReceiptLog;
  /** The asset code receipts name, such as USDC. */
  readonly assetCode: string;
  readonly network: string;
  /** Recipient references the principal allowlisted, by destination. */
  readonly recipientRefs?: ReadonlyMap<string, Hex32>;
  readonly now?: () => Date;
  /** How long a request stays acceptable to the mandate after it is built. */
  readonly requestTtlSeconds?: number;
}

export interface QuoteResult {
  readonly decision: Quote['decision'];
  readonly reason?: string;
  readonly amount: string;
  readonly asset: string;
  readonly rail: RailName;
  readonly destination: string;
  readonly headroom: Readonly<Record<keyof Quote['headroom'], string>>;
}

export interface Verification {
  readonly task_id: string;
  readonly ok: boolean;
  readonly onchain_status: string;
  readonly checks: readonly {
    readonly check: string;
    readonly ok: boolean;
    readonly detail: string;
  }[];
}

export interface StatusResult {
  readonly task_id: string;
  readonly payout_id: Hex32;
  readonly onchain_status: string;
  readonly approvals?: number;
  readonly receipt: Record<string, unknown> | null;
}

/** Turns zod failures into an input error that names fields, never values. */
export function parseInput<T extends z.ZodType>(schema: T, raw: unknown): z.output<T> {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const fields = parsed.error.issues
      .map((i) => `${i.path.join('.') || 'input'}: ${i.message}`)
      .join('; ');
    throw new EngineError('input_invalid', `invalid input (${fields})`);
  }
  return parsed.data;
}

interface Target {
  readonly taskId: string;
  readonly recipient: string;
  readonly amount: bigint;
  readonly rail: PayoutRail;
  readonly destination: string;
  readonly recipientRef: Hex32;
  readonly payoutId: Hex32;
}

const DEFAULT_TTL_SECONDS = 300;

export class PayoutEngine {
  private readonly o: EngineOptions;
  private readonly now: () => Date;

  constructor(options: EngineOptions) {
    this.o = options;
    this.now = options.now ?? (() => new Date());
  }

  get mandateId(): string {
    return this.o.mandate.contractId;
  }

  get agentKey(): string {
    return this.o.agent.publicKey;
  }

  private rail(name: RailName): PayoutRail {
    const rail = this.o.rails.find((r) => r.name === name);
    if (rail === undefined) {
      throw new EngineError('rail_unavailable', `the ${name} rail is not configured here`);
    }
    return rail;
  }

  /** The recipient reference the allowlist binds this destination under. */
  recipientRefFor(destination: string): Hex32 {
    return this.o.recipientRefs?.get(destination) ?? defaultRecipientRef(destination);
  }

  private target(input: {
    task_id: string;
    recipient: string;
    amount: bigint;
    rail: RailName;
  }): Target {
    const rail = this.rail(input.rail);
    const destination = rail.destinationFor(input.recipient);
    return {
      taskId: input.task_id,
      recipient: input.recipient,
      amount: input.amount,
      rail,
      destination,
      recipientRef: this.recipientRefFor(destination),
      payoutId: payoutIdFor(this.mandateId, input.task_id),
    };
  }

  private async facts(t: Omit<Target, 'payoutId' | 'taskId'>): Promise<QuoteFacts> {
    const m = this.o.mandate;
    const [config, state, dailyUsed, allowed] = await Promise.all([
      m.config(),
      m.state(),
      m.dailyUsed(t.recipientRef),
      m.isAllowed(t.recipientRef, t.destination),
    ]);
    return {
      config,
      state,
      dailyUsed,
      allowed,
      agent: this.agentKey,
      destination: t.destination,
      amount: t.amount,
      fee: 0n,
      now: BigInt(Math.floor(this.now().getTime() / 1000)),
    };
  }

  async quotePayout(raw: unknown): Promise<QuoteResult> {
    const input = parseInput(quoteInput, raw);
    const rail = this.rail(input.rail);
    const destination = rail.destinationFor(input.recipient);
    const q = quote(
      await this.facts({
        recipient: input.recipient,
        amount: input.amount,
        rail,
        destination,
        recipientRef: this.recipientRefFor(destination),
      }),
    );
    return {
      decision: q.decision,
      ...(q.reason === undefined ? {} : { reason: q.reason }),
      amount: q.amount.toString(),
      asset: this.o.assetCode,
      rail: rail.name,
      destination,
      headroom: {
        perPaymentCap: q.headroom.perPaymentCap.toString(),
        approvalThreshold: q.headroom.approvalThreshold.toString(),
        budgetLeft: q.headroom.budgetLeft.toString(),
        dailyLeft: q.headroom.dailyLeft.toString(),
        free: q.headroom.free.toString(),
      },
    };
  }

  private buildRequest(t: Target): PayoutRequest {
    const ttl = BigInt(this.o.requestTtlSeconds ?? DEFAULT_TTL_SECONDS);
    return {
      payoutId: t.payoutId,
      recipientRef: t.recipientRef,
      total: t.amount,
      fee: 0n,
      legs: [{ destination: t.destination, amount: t.amount }],
      deadline: BigInt(Math.floor(this.now().getTime() / 1000)) + ttl,
      taskRef: taskRefFor(t.taskId),
    };
  }

  private async record(
    t: Target,
    principal: string,
    prior: Receipt | undefined,
    fields: Partial<Receipt> & { outcome: Outcome },
  ): Promise<Receipt> {
    const at = this.now().toISOString();
    const base: Receipt = {
      task_id: t.taskId,
      mandate: this.mandateId,
      principal,
      agent: this.agentKey,
      network: this.o.network,
      recipient: t.recipient,
      destination: t.destination,
      amount: t.amount,
      asset: this.o.assetCode,
      rail: t.rail.name,
      outcome: fields.outcome,
      payout_id: t.payoutId,
      created_at: prior?.created_at ?? at,
      updated_at: at,
    };
    // A request hash from an earlier step stays with the receipt as it moves on.
    const carried =
      prior?.request_tx_hash === undefined ? {} : { request_tx_hash: prior.request_tx_hash };
    return this.o.receipts.upsert({ ...base, ...carried, ...fields });
  }

  /**
   * Requests a payout for a task and carries it as far as the mandate lets
   * it go now: paid, waiting for approval, or blocked with a reason.
   */
  async requestPayout(raw: unknown): Promise<Receipt> {
    const t = this.target(parseInput(payoutInput, raw));
    const prior = await this.o.receipts.find(this.mandateId, t.taskId);
    const existing = await this.o.mandate.payout(t.payoutId);
    if (existing !== null) return this.resume(t, existing, prior);

    const facts = await this.facts(t);
    const principal = facts.config.principal;
    const q = quote(facts);
    const req = this.buildRequest(t);

    if (q.decision === 'blocked') {
      // Ask the contract too, so a block on the record is the contract's own
      // answer wherever it agrees.
      const sim = await this.o.mandate.simulateRequest(this.agentKey, req);
      if (!sim.ok) return this.blocked(t, principal, prior, sim.error);
      return this.record(t, principal, prior, {
        outcome: 'blocked',
        reason: q.reason ?? 'blocked',
        blocked_by: 'quote',
      });
    }

    let sent;
    try {
      sent = await this.o.mandate.requestPayout(this.o.agent, req);
    } catch (error) {
      const landed = await this.afterFailedSend(t, error);
      if (landed !== null) return this.resume(t, landed, prior);
      if (error instanceof ContractRefusedError) return this.blocked(t, principal, prior, error);
      throw error;
    }

    if (sent.status === PAYOUT_STATUS.pending) {
      return this.record(t, principal, prior, {
        outcome: 'approval_required',
        request_tx_hash: sent.txHash,
      });
    }
    return this.settle(t, principal, prior, 'paid', sent.txHash);
  }

  /** After a send failed, whether the request landed anyway, as a retry would find it. */
  private async afterFailedSend(t: Target, error: unknown): Promise<PayoutEntry | null> {
    const lost = error instanceof EngineError && error.code === 'submission_unknown';
    const exists = error instanceof ContractRefusedError && error.reason === 'payout_id_exists';
    if (!lost && !exists) return null;
    return this.o.mandate.payout(t.payoutId);
  }

  private blocked(
    t: Target,
    principal: string,
    prior: Receipt | undefined,
    error: ContractRefusedError,
  ): Promise<Receipt> {
    return this.record(t, principal, prior, {
      outcome: 'blocked',
      reason: error.reason,
      blocked_by: 'contract',
      contract_error: error.contractCode,
      ...(error.txHash === undefined ? {} : { request_tx_hash: error.txHash }),
    });
  }

  private async settle(
    t: Target,
    principal: string,
    prior: Receipt | undefined,
    outcome: 'paid' | 'approved_then_paid',
    requestTxHash?: string,
  ): Promise<Receipt> {
    const request = requestTxHash === undefined ? {} : { request_tx_hash: requestTxHash };
    let settlement;
    try {
      settlement = await t.rail.settle({
        taskId: t.taskId,
        payoutId: t.payoutId,
        recipient: t.recipient,
        destination: t.destination,
        amount: t.amount,
        asset: this.o.assetCode,
      });
    } catch (error) {
      // The payout stays approved on chain; requesting the task again retries
      // the settlement, and the mandate pays it at most once.
      if (error instanceof ContractRefusedError) {
        return this.record(t, principal, prior, {
          ...request,
          outcome: 'blocked',
          reason: error.reason,
          blocked_by: 'contract',
          contract_error: error.contractCode,
        });
      }
      throw error;
    }
    return this.record(t, principal, prior, {
      ...request,
      outcome,
      tx_hash: settlement.txHash,
      ...(settlement.sdpDisbursementId === undefined
        ? {}
        : { sdp_disbursement_id: settlement.sdpDisbursementId }),
    });
  }

  private async resume(
    t: Target,
    entry: PayoutEntry,
    prior: Receipt | undefined,
  ): Promise<Receipt> {
    if (entry.kind === 'record') {
      const leg = entry.legs[0];
      if (entry.total !== t.amount || leg?.destination !== t.destination) {
        throw new EngineError(
          'task_conflict',
          'this task ID already has a payout with another amount or recipient',
        );
      }
    }
    const principal = prior?.principal ?? (await this.o.mandate.config()).principal;
    const status = entry.status;
    if (status === PAYOUT_STATUS.pending) {
      return this.record(t, principal, prior, { outcome: 'approval_required' });
    }
    if (status === PAYOUT_STATUS.approved) {
      const approved =
        prior?.outcome === 'approval_required' ||
        (entry.kind === 'record' && entry.approvals.length > 0);
      return this.settle(t, principal, prior, approved ? 'approved_then_paid' : 'paid');
    }
    if (status === PAYOUT_STATUS.executed) {
      if (
        prior !== undefined &&
        (prior.outcome === 'paid' || prior.outcome === 'approved_then_paid')
      ) {
        return prior;
      }
      return this.record(t, principal, prior, {
        outcome: prior?.outcome === 'approval_required' ? 'approved_then_paid' : 'paid',
      });
    }
    return this.record(t, principal, prior, {
      outcome: 'blocked',
      reason: status === PAYOUT_STATUS.rejected ? 'rejected_by_approver' : 'cancelled',
      blocked_by: 'contract',
    });
  }

  async payoutStatus(raw: unknown): Promise<StatusResult> {
    const input = parseInput(statusInput, raw);
    const receipt = await this.o.receipts.find(this.mandateId, input.task_id);
    const payoutId = receipt?.payout_id ?? payoutIdFor(this.mandateId, input.task_id);
    const entry = await this.o.mandate.payout(payoutId);
    return {
      task_id: input.task_id,
      payout_id: payoutId,
      onchain_status: entry === null ? 'not_found' : statusName(entry.status),
      ...(entry?.kind === 'record' ? { approvals: entry.approvals.length } : {}),
      receipt: receipt === undefined ? null : receiptToJson(receipt),
    };
  }

  async listReceipts(raw: unknown): Promise<{
    receipts: Record<string, unknown>[];
    verification?: Verification[];
  }> {
    const input = parseInput(listInput, raw);
    const receipts = await this.o.receipts.list(this.mandateId, {
      ...(input.task_id === undefined ? {} : { taskId: input.task_id }),
      ...(input.outcome === undefined ? {} : { outcome: input.outcome }),
      limit: input.limit,
    });
    const out = { receipts: receipts.map(receiptToJson) };
    if (!input.verify) return out;
    const verification = [];
    for (const r of receipts) verification.push(await this.verifyReceipt(r));
    return { ...out, verification };
  }

  /** Cross-checks a receipt against the mandate's payout record and the ledger. */
  async verifyReceipt(r: Receipt): Promise<Verification> {
    const checks: { check: string; ok: boolean; detail: string }[] = [];
    const entry = r.payout_id === undefined ? null : await this.o.mandate.payout(r.payout_id);
    const onchain = entry === null ? 'not_found' : statusName(entry.status);
    const expected: Record<Outcome, readonly string[]> = {
      paid: ['executed'],
      approved_then_paid: ['executed'],
      approval_required: ['pending', 'approved'],
      blocked: ['not_found', 'rejected', 'cancelled', 'approved'],
    };
    checks.push({
      check: 'payout_record',
      ok: expected[r.outcome].includes(onchain),
      detail: `receipt says ${r.outcome}, the mandate says ${onchain}`,
    });
    if (entry?.kind === 'record') {
      checks.push({
        check: 'amount',
        ok: entry.total === r.amount,
        detail: `receipt ${r.amount.toString()}, mandate ${entry.total.toString()}`,
      });
    }
    for (const [name, hash] of [
      ['request_tx', r.request_tx_hash],
      ['payment_tx', r.tx_hash],
    ] as const) {
      if (hash === undefined) continue;
      const tx = await this.o.mandate.transaction(hash);
      checks.push({ check: name, ok: tx.status === 'SUCCESS', detail: `${hash} ${tx.status}` });
    }
    return {
      task_id: r.task_id,
      ok: checks.every((c) => c.ok),
      onchain_status: onchain,
      checks,
    };
  }
}
