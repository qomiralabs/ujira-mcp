// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// Quoting and creating payouts. Every payout is asked about on the chain
// before it is stored: the mandate's own simulation says whether it would
// take the request, and the mandate's threshold says whether a person must
// approve it. A payout the mandate refuses is still written, as blocked with
// the spec error, so the caller has a record and later a receipt of why.
//
// The chain is asked outside any database transaction, so a slow RPC never
// holds a connection. When it does not answer at all the payout is written
// queued anyway and the worker asks again before it requests anything: an
// outage delays payouts, it does not refuse them.
//
// Retries are safe at two levels. The HTTP layer replays an answer for the
// same Idempotency-Key, and the payout row is unique on the key and on the
// task, so a retry that slips past the first finds the payout it made.

import { createHash, randomUUID } from 'node:crypto';

import { callOptions, ChainError, type ChainAdapter, type PayoutIntent } from '../chain/adapter.js';
import type {
  CreatedPayout,
  Mandate,
  NewPayout,
  PayoutMethod,
  ProjectContext,
  Recipient,
  StorableCheck,
} from '../db/index.js';
import { payoutIdFor, taskRefFor } from '../ids.js';
import { logLine, type Log } from '../log.js';
import { MoneyError, SETTLEMENT_TOKENS, tokenAmount, type TokenAmount } from '../money/index.js';
import { allocateLegs } from './legs.js';

export type QuoteDecision = 'allowed' | 'approval_required' | 'blocked';

/**
 * Refusals UJIRA finds before the chain is asked. The mandate's own refusals
 * keep the names the mandate spec gives them, such as INSUFFICIENT_FUNDS.
 */
export const LOCAL_BLOCKS = {
  recipientSuspended: 'RECIPIENT_SUSPENDED',
  noMethod: 'RECIPIENT_HAS_NO_METHOD',
  // One code whatever the reason, the one the console shows. The recipient
  // itself says which: no account, no trustline, or a memo it would need.
  notReceivable: 'DESTINATION_NOT_RECEIVABLE',
} as const;

// What a check that the chain never answered returns.
const NO_ANSWER = Symbol('no answer');

// The chain already holds a request under this payout id. That is not a
// refusal of this payout: the worker reads the chain first and resumes it.
const ALREADY_ON_CHAIN = 'PAYOUT_ID_EXISTS';

export type PayoutServiceErrorCode =
  | 'MANDATE_NOT_FOUND'
  | 'RECIPIENT_NOT_FOUND'
  | 'AMOUNT_MISMATCH'
  | 'RECIPIENT_HAS_NO_METHOD'
  | 'MANDATE_NOT_SERVED'
  | 'CHAIN_UNAVAILABLE';

export type AmountField = 'amount' | 'asset' | 'network' | 'scale';

export class PayoutServiceError extends Error {
  override readonly name = 'PayoutServiceError';
  // Set with AMOUNT_MISMATCH: which part of the amount is wrong for the mandate.
  readonly field: AmountField | undefined;

  constructor(
    readonly code: PayoutServiceErrorCode,
    message: string,
    options: { field?: AmountField } = {},
  ) {
    super(message);
    this.field = options.field;
  }
}

/** An amount as the wire carries it: minor units as a decimal string, with its unit. */
export interface WireAmount {
  readonly amount: string;
  readonly asset: string;
  readonly network: string;
  readonly scale: number;
}

export interface QuoteInput {
  readonly mandateId: string;
  readonly recipientId: string;
  readonly amount: WireAmount;
  // With a task the quote also says whether the chain already holds it.
  readonly taskId?: string | undefined;
}

export interface CreatePayoutInput {
  readonly mandateId: string;
  readonly recipientId: string;
  readonly amount: WireAmount;
  readonly taskId: string;
  readonly metadata?: Readonly<Record<string, string>> | undefined;
  readonly idempotencyKey: string;
}

export interface PayoutQuote {
  readonly decision: QuoteDecision;
  // The spec error name when blocked, null otherwise.
  readonly blockedBy: string | null;
  readonly amount: TokenAmount;
  readonly network: string;
}

/** What a payout's wire shape needs beside the payout itself. */
export interface PayoutRecord extends CreatedPayout {
  readonly principalId: string;
  readonly mandate: Mandate;
  readonly recipient: Recipient;
}

export interface PayoutTarget {
  readonly mandate: Mandate | undefined;
  // Undefined also when the recipient is on another mandate.
  readonly recipient: Recipient | undefined;
  // The oldest wallet on file, the one a payout goes to.
  readonly method: PayoutMethod | null;
}

/** The database side, one short tenant transaction per call. */
export interface PayoutStore {
  target(context: ProjectContext, mandateId: string, recipientId: string): Promise<PayoutTarget>;
  hasTask(context: ProjectContext, mandateId: string, taskId: string): Promise<boolean>;
  recordCheck(context: ProjectContext, methodId: string, check: StorableCheck): Promise<void>;
  // Writes the payout, its legs and its first job together, or finds the retry.
  create(context: ProjectContext, input: NewPayout): Promise<CreatedPayout>;
}

export interface PayoutService {
  quote(context: ProjectContext, input: QuoteInput, correlationId: string): Promise<PayoutQuote>;
  create(
    context: ProjectContext,
    input: CreatePayoutInput,
    correlationId: string,
  ): Promise<PayoutRecord>;
}

export interface PayoutServiceOptions {
  readonly store: PayoutStore;
  readonly chain: ChainAdapter;
  // The asset a mandate pays, as the adapter's destination check takes it.
  readonly destinationAsset: (mandate: Mandate) => string;
  // Bounds each chain call; the adapter's default when absent.
  readonly chainTimeoutMs?: number;
  // How long the simulated request stays acceptable, as the engine sends it.
  readonly requestTtlSeconds?: number;
  readonly now?: () => Date;
  readonly log?: Log;
}

const DEFAULT_REQUEST_TTL_SECONDS = 300;

/**
 * The mandate's verdict as a quote. A refusal names the spec error; an
 * accepted request at or above the approval threshold waits for a person,
 * as the contract decides it.
 */
export function decide(
  check: Awaited<ReturnType<ChainAdapter['checkPayout']>>,
  charge: bigint,
  approvalThreshold: bigint,
): { readonly decision: QuoteDecision; readonly blockedBy: string | null } {
  if (!check.ok) return { decision: 'blocked', blockedBy: check.specError };
  return {
    decision: charge >= approvalThreshold ? 'approval_required' : 'allowed',
    blockedBy: null,
  };
}

/**
 * The fingerprint a payout row keeps, so the same key sent with another
 * payout is told apart from a retry. Metadata keys are sorted, since their
 * order carries no meaning.
 */
export function payoutRequestHash(input: CreatePayoutInput): string {
  // Keys of one object are distinct, so no two compare equal.
  const metadata = Object.entries(input.metadata ?? {}).sort(([a], [b]) => (a < b ? -1 : 1));
  const canonical = JSON.stringify([
    'ujira/payout-request/v1',
    input.mandateId.toLowerCase(),
    input.recipientId.toLowerCase(),
    input.amount.amount,
    input.amount.asset,
    input.amount.network,
    input.amount.scale,
    input.taskId,
    metadata,
  ]);
  return createHash('sha256').update(canonical).digest('hex');
}

// The amount in the mandate's own unit, or the field that differs.
function amountFor(mandate: Mandate, wire: WireAmount): TokenAmount {
  const mismatch = (field: AmountField) =>
    new PayoutServiceError('AMOUNT_MISMATCH', `the amount ${field} is not the mandate's`, {
      field,
    });
  if (wire.asset !== mandate.asset) throw mismatch('asset');
  if (wire.network !== mandate.network) throw mismatch('network');
  if (wire.scale !== mandate.scale) throw mismatch('scale');
  // The token table, not the mandate row, says what a unit is, so a row
  // written wrong cannot make the money module accept another unit.
  const [chain] = mandate.network.split(':');
  const token = SETTLEMENT_TOKENS.find((t) => t.asset === wire.asset && t.chain === chain);
  if (token === undefined) {
    throw mismatch(SETTLEMENT_TOKENS.some((t) => t.asset === wire.asset) ? 'network' : 'asset');
  }
  if (token.tokenScale !== wire.scale) throw mismatch('scale');
  try {
    return tokenAmount(wire.amount, token.asset, token.chain);
  } catch (error) {
    // Past what the chain's i128 holds.
    if (error instanceof MoneyError) throw mismatch('amount');
    throw error;
  }
}

type Assessment =
  | { readonly kind: 'blocked'; readonly blockedBy: string }
  | {
      readonly kind: 'decided';
      readonly decision: QuoteDecision;
      readonly blockedBy: string | null;
    }
  // The chain did not answer in time.
  | { readonly kind: 'unknown' };

interface Resolved {
  readonly mandate: Mandate;
  readonly recipient: Recipient;
  readonly method: PayoutMethod | null;
  readonly amount: TokenAmount;
}

type DestinationAnswer = Awaited<ReturnType<ChainAdapter['checkDestination']>>;

function destinationBlock(answer: DestinationAnswer): string | null {
  return answer.receivable ? null : LOCAL_BLOCKS.notReceivable;
}

function isUnavailable(error: unknown): error is ChainError {
  return error instanceof ChainError && (error.code === 'TIMEOUT' || error.code === 'UNAVAILABLE');
}

export function createPayoutService(o: PayoutServiceOptions): PayoutService {
  const log = o.log ?? (() => undefined);
  const now = o.now ?? (() => new Date());
  const ttl = BigInt(o.requestTtlSeconds ?? DEFAULT_REQUEST_TTL_SECONDS);
  const call = (correlationId: string) => callOptions(correlationId, o.chainTimeoutMs);

  async function resolve(
    context: ProjectContext,
    input: { mandateId: string; recipientId: string; amount: WireAmount },
  ): Promise<Resolved> {
    const target = await o.store.target(context, input.mandateId, input.recipientId);
    if (target.mandate === undefined) {
      throw new PayoutServiceError('MANDATE_NOT_FOUND', 'no such mandate in this project');
    }
    if (target.recipient?.mandateId !== target.mandate.id) {
      throw new PayoutServiceError('RECIPIENT_NOT_FOUND', 'no such recipient on this mandate');
    }
    const amount = amountFor(target.mandate, input.amount);
    if (target.mandate.network !== o.chain.network) {
      throw new PayoutServiceError(
        'MANDATE_NOT_SERVED',
        'the mandate is on a network not served here',
      );
    }
    return { mandate: target.mandate, recipient: target.recipient, method: target.method, amount };
  }

  // A destination that could not receive when it was last read is read
  // again, so a wallet fixed since then is paid without anyone re-entering it.
  async function destination(
    context: ProjectContext,
    r: Resolved,
    method: PayoutMethod,
    correlationId: string,
  ): Promise<string | null | typeof NO_ANSWER> {
    if (method.destinationStatus === 'receivable') return null;
    let check: DestinationAnswer;
    try {
      check = await o.chain.checkDestination(
        method.destination,
        o.destinationAsset(r.mandate),
        call(correlationId),
      );
    } catch (error) {
      if (isUnavailable(error)) return NO_ANSWER;
      throw error;
    }
    // A destination that wants a memo is never stored as payable or otherwise.
    const storable: StorableCheck | null = check.receivable
      ? { receivable: true }
      : check.reason === 'NEEDS_MEMO'
        ? null
        : { receivable: false, reason: check.reason };
    if (storable !== null) await o.store.recordCheck(context, method.id, storable);
    return destinationBlock(check);
  }

  async function assess(
    context: ProjectContext,
    r: Resolved,
    taskId: string,
    correlationId: string,
  ): Promise<Assessment> {
    if (r.recipient.status === 'suspended') {
      return { kind: 'blocked', blockedBy: LOCAL_BLOCKS.recipientSuspended };
    }
    const method = r.method;
    if (method === null) return { kind: 'blocked', blockedBy: LOCAL_BLOCKS.noMethod };
    const destinationBlocked = await destination(context, r, method, correlationId);
    if (destinationBlocked === NO_ANSWER) return { kind: 'unknown' };
    if (destinationBlocked !== null) return { kind: 'blocked', blockedBy: destinationBlocked };

    const legs = allocateLegs(r.amount, [1n]);
    const intent: PayoutIntent = {
      mandate: r.mandate.contractAddress,
      payoutId: payoutIdFor(r.mandate.contractAddress, taskId),
      taskRef: taskRefFor(taskId),
      recipientRef: r.recipient.recipientRef,
      legs: legs.map((leg) => ({ destination: method.destination, amount: leg.amount.amount })),
      fee: 0n,
      deadline: BigInt(Math.floor(now().getTime() / 1000)) + ttl,
    };
    try {
      const [mandate, check] = await Promise.all([
        o.chain.readMandate(r.mandate.contractAddress, call(correlationId)),
        o.chain.checkPayout(intent, r.mandate.agentAddress, call(correlationId)),
      ]);
      return {
        kind: 'decided',
        ...decide(check, r.amount.amount + intent.fee, mandate.config.limits.approvalThreshold),
      };
    } catch (error) {
      if (isUnavailable(error)) return { kind: 'unknown' };
      throw error;
    }
  }

  function unavailableLog(correlationId: string): void {
    log(logLine('payout_quote_chain_unavailable', { requestId: correlationId }));
  }

  return {
    async quote(context, input, correlationId) {
      const r = await resolve(context, input);
      // Without a task the simulation uses one nobody has, so it judges the
      // payout itself and not an earlier one.
      const taskId = input.taskId ?? `quote:${randomUUID()}`;
      const outcome = await assess(context, r, taskId, correlationId);
      if (outcome.kind === 'unknown') {
        unavailableLog(correlationId);
        throw new PayoutServiceError('CHAIN_UNAVAILABLE', 'the chain did not answer in time');
      }
      return {
        decision: outcome.kind === 'blocked' ? 'blocked' : outcome.decision,
        blockedBy: outcome.blockedBy,
        amount: r.amount,
        network: r.mandate.network,
      };
    },

    async create(context, input, correlationId) {
      const r = await resolve(context, input);
      const method = r.method;
      // A payout row needs a leg, and a leg needs somewhere to pay.
      if (method === null) {
        throw new PayoutServiceError(
          'RECIPIENT_HAS_NO_METHOD',
          'the recipient has no wallet to pay yet',
        );
      }
      // A retry, or the same task under another key, is settled by the
      // unique keys alone; the chain has nothing to add.
      const retry = await o.store.hasTask(context, r.mandate.id, input.taskId);
      let blockedBy: string | undefined;
      if (!retry) {
        const outcome = await assess(context, r, input.taskId, correlationId);
        if (outcome.kind === 'unknown') unavailableLog(correlationId);
        else if (outcome.blockedBy !== null && outcome.blockedBy !== ALREADY_ON_CHAIN) {
          blockedBy = outcome.blockedBy;
        }
      }
      const created = await o.store.create(context, {
        idempotencyKey: input.idempotencyKey,
        requestHash: payoutRequestHash(input),
        mandateId: r.mandate.id,
        recipientId: r.recipient.id,
        taskId: input.taskId,
        onchainPayoutId: payoutIdFor(r.mandate.contractAddress, input.taskId),
        amount: r.amount,
        ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
        legs: allocateLegs(r.amount, [1n]).map((leg) => ({
          payoutMethodId: method.id,
          amount: leg.amount,
        })),
        ...(blockedBy === undefined ? {} : { blockedBy }),
      });
      log(
        logLine(created.created ? 'payout_created' : 'payout_create_retried', {
          requestId: correlationId,
          payoutId: created.payout.id,
          principalId: context.principalId,
          projectId: context.projectId,
          status: created.payout.status,
          blockedBy: created.payout.blockedBy,
        }),
      );
      return {
        ...created,
        principalId: context.principalId,
        mandate: r.mandate,
        recipient: r.recipient,
      };
    },
  };
}
