// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The payout jobs: request the payout on chain with the mandate's agent key,
// follow it through approval, and execute it with the executor key. Every move
// to a finished status queues the payout's receipt.issue job in the same
// transaction, so a finished payout always gets its receipt. Each step reads the chain before it acts and only does what the
// chain does not show as done, so any step can be killed at any point and run
// again without paying twice:
//
// - A request is sent only while the chain has no payout under its id, and the
//   contract refuses an id twice.
// - An execute is recorded on its leg, with the hash it will land under,
//   before it is sent. A retry looks that hash up first and sends again only
//   once the first send can no longer land, and the contract executes a
//   payout once at most.
//
// Database writes are short transactions between chain calls, each moving the
// payout only from the status it was read in, so a stale run changes nothing.

import {
  ChainError,
  DEFAULT_CALL_TIMEOUT_MS,
  type CallOptions,
  type ChainAdapter,
  type ChainPayoutState,
  type PayoutIntent,
} from '../chain/adapter.js';
import type {
  LegTransition,
  Mandate,
  Payout,
  PayoutJobTask,
  PayoutLeg,
  PayoutTransition,
  ProjectContext,
  Recipient,
} from '../db/index.js';
import { taskRefFor } from '../ids.js';
import { logLine, type Log } from '../log.js';
import { PayoutRetryError } from './errors.js';
import type { LegStatus } from './leg-status.js';
import { AgentKeyUnavailableError, type PayoutSigners } from './signers.js';
import { isTerminal, type PayoutStatus } from './status.js';

/** Everything a step reads about one payout, in one transaction. */
export interface PayoutSnapshot {
  readonly payout: Payout;
  readonly legs: readonly PayoutLeg[];
  readonly mandate: Mandate;
  readonly recipient: Recipient;
  readonly hasReceipt: boolean;
}

export interface LegChange {
  readonly legId: string;
  readonly change: LegTransition;
}

export interface JobRequest {
  readonly task: PayoutJobTask;
  /** Run this many seconds from now rather than at once. */
  readonly afterSeconds?: number;
}

/** One transaction's worth of moves; all of it lands or none of it does. */
export interface PayoutChange {
  /** Applied in order, each from the status the one before it left. */
  readonly path?: readonly PayoutTransition[];
  readonly legs?: readonly LegChange[];
  readonly enqueue?: readonly JobRequest[];
}

/** The database side of the jobs, under the job's tenant only. */
export interface PayoutStore {
  load(payoutId: string): Promise<PayoutSnapshot | undefined>;
  /** False, with nothing written, when the payout or a leg is no longer where the change expects. */
  apply(payoutId: string, change: PayoutChange): Promise<boolean>;
}

export interface PayoutJobContext extends ProjectContext {
  readonly payoutId: string;
  /** Aborts when the worker is stopping. */
  readonly signal: AbortSignal;
}

/** What one run of a step did, for the task's log line and the tests. */
export type StepOutcome =
  | 'missing'
  | 'stale'
  | 'not_ready'
  | 'handed_on'
  | 'finished'
  | 'waiting'
  | 'approved'
  | 'blocked'
  | 'rejected'
  | 'cancelled'
  | 'paid'
  | 'needs_attention'
  | 'drift';

export interface WorkflowOptions {
  readonly chain: ChainAdapter;
  readonly signers: PayoutSigners;
  readonly log: Log;
  readonly now?: () => Date;
  /** How long a request stays acceptable to the mandate once it is built. */
  readonly requestTtlSeconds?: number;
  /** The bound on a chain read. */
  readonly readTimeoutMs?: number;
  /** The bound on a send, which waits for the transaction to land. */
  readonly sendTimeoutMs?: number;
  /**
   * How long after an execute was recorded it may still land. The network
   * drops a transaction once its time bounds pass, which the adapter sets
   * well inside this.
   */
  readonly sendWindowMs?: number;
}

export const DEFAULT_REQUEST_TTL_SECONDS = 300;
export const DEFAULT_SEND_TIMEOUT_MS = 120_000;
export const DEFAULT_SEND_WINDOW_MS = 5 * 60_000;

/** A payout waiting for approvers is looked at again this often, at the least and the most. */
export const APPROVAL_RECHECK_MIN_SECONDS = 15;
export const APPROVAL_RECHECK_MAX_SECONDS = 300;

/**
 * When to look at a pending payout again: a tenth of how long it has waited,
 * within bounds, so a quick approval is seen quickly and a slow one costs few
 * reads.
 */
export function approvalRecheckSeconds(waitedMs: number): number {
  const tenth = Math.floor(Math.max(0, waitedMs) / 10_000);
  return Math.min(APPROVAL_RECHECK_MAX_SECONDS, Math.max(APPROVAL_RECHECK_MIN_SECONDS, tenth));
}

/**
 * The moves the dead letter path makes from each status. A payout a job gave
 * up on ends in needs_attention wherever the status machine has a way there;
 * one waiting on its approvers or already finished stays as it is.
 */
export function deadLetterPath(status: PayoutStatus): readonly PayoutTransition[] {
  switch (status) {
    case 'queued':
      return [
        { from: 'queued', to: 'submitting' },
        { from: 'submitting', to: 'needs_attention' },
      ];
    case 'submitting':
      return [{ from: 'submitting', to: 'needs_attention' }];
    case 'approved':
      return [
        { from: 'approved', to: 'settling' },
        { from: 'settling', to: 'needs_attention' },
      ];
    case 'settling':
      return [{ from: 'settling', to: 'needs_attention' }];
    default:
      return [];
  }
}

const SPEC_ERROR = /^[A-Z][A-Z0-9_]{0,63}$/;

function specErrorOf(error: ChainError): string {
  const name = error.specError;
  return name !== undefined && SPEC_ERROR.test(name) ? name : 'CONTRACT_REFUSED';
}

function legsTo(
  legs: readonly PayoutLeg[],
  from: LegStatus,
  to: LegStatus,
  txHash?: string,
): readonly LegChange[] {
  return legs
    .filter((leg) => leg.status === from)
    .map((leg) => ({
      legId: leg.id,
      change: txHash === undefined ? { from, to } : { from, to, txHash },
    }));
}

/** The hash the legs were sent under, when every leg was recorded as sent. */
function sentHash(legs: readonly PayoutLeg[]): string | undefined {
  const [first] = legs;
  if (first?.status !== 'submitted' || first.txHash === null) return undefined;
  return legs.every((leg) => leg.status === 'submitted' && leg.txHash === first.txHash)
    ? first.txHash
    : undefined;
}

export class PayoutWorkflow {
  private readonly o: WorkflowOptions;
  private readonly now: () => Date;

  constructor(options: WorkflowOptions) {
    this.o = options;
    this.now = options.now ?? (() => new Date());
  }

  private read(job: PayoutJobContext): CallOptions {
    return this.bounded(job, this.o.readTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS);
  }

  private send(job: PayoutJobContext): CallOptions {
    return this.bounded(job, this.o.sendTimeoutMs ?? DEFAULT_SEND_TIMEOUT_MS);
  }

  private bounded(job: PayoutJobContext, ms: number): CallOptions {
    return {
      signal: AbortSignal.any([job.signal, AbortSignal.timeout(ms)]),
      correlationId: job.payoutId,
    };
  }

  private state(job: PayoutJobContext, s: PayoutSnapshot): Promise<ChainPayoutState> {
    return this.o.chain.payoutState(
      s.mandate.contractAddress,
      s.payout.onchainPayoutId,
      this.read(job),
    );
  }

  /** Applies a change, and logs each status move it made. */
  private async move(
    job: PayoutJobContext,
    task: PayoutJobTask,
    store: PayoutStore,
    change: PayoutChange,
    detail: { readonly tx?: string; readonly reason?: string } = {},
  ): Promise<boolean> {
    const moved = await store.apply(job.payoutId, change);
    if (!moved) return false;
    for (const step of change.path ?? []) {
      this.o.log(
        logLine('payout_moved', {
          principalId: job.principalId,
          projectId: job.projectId,
          payoutId: job.payoutId,
          task,
          from: step.from,
          to: step.to,
          blockedBy: step.blockedBy,
          tx: detail.tx,
          reason: detail.reason,
        }),
      );
    }
    return true;
  }

  /** A finished payout whose receipt job was lost gets it queued again. */
  private async ensureReceipt(store: PayoutStore, s: PayoutSnapshot): Promise<StepOutcome> {
    if (!s.hasReceipt) await store.apply(s.payout.id, { enqueue: [{ task: 'receipt.issue' }] });
    return 'finished';
  }

  private intentOf(s: PayoutSnapshot): PayoutIntent {
    const ttl = BigInt(this.o.requestTtlSeconds ?? DEFAULT_REQUEST_TTL_SECONDS);
    return {
      mandate: s.mandate.contractAddress,
      payoutId: s.payout.onchainPayoutId,
      taskRef: taskRefFor(s.payout.taskId),
      recipientRef: s.recipient.recipientRef,
      legs: s.legs.map((leg) => ({ destination: leg.destination, amount: leg.amount.amount })),
      fee: s.payout.fee.amount,
      deadline: BigInt(Math.floor(this.now().getTime() / 1000)) + ttl,
    };
  }

  /** payout.advance: request the payout, then follow it until it is approved or finished. */
  async advance(job: PayoutJobContext, store: PayoutStore): Promise<StepOutcome> {
    const s = await store.load(job.payoutId);
    if (s === undefined) return 'missing';
    const status = s.payout.status;
    if (isTerminal(status)) return this.ensureReceipt(store, s);
    if (status === 'approved' || status === 'settling') {
      await store.apply(job.payoutId, { enqueue: [{ task: 'payout.execute' }] });
      return 'handed_on';
    }
    if (status === 'pending_approval') return this.follow(job, store, s, 'pending_approval');
    if (status === 'queued' || status === 'needs_attention') {
      const path = [{ from: status, to: 'submitting' }] as const;
      if (!(await this.move(job, 'payout.advance', store, { path }))) return 'stale';
    } else if (status !== 'submitting') {
      // Reserved statuses nothing moves into yet.
      return 'not_ready';
    }
    const onChain = await this.state(job, s);
    if (onChain.kind === 'absent') return this.request(job, store, s);
    return this.follow(job, store, s, 'submitting', onChain);
  }

  private async request(
    job: PayoutJobContext,
    store: PayoutStore,
    s: PayoutSnapshot,
  ): Promise<StepOutcome> {
    let agent;
    try {
      agent = await this.o.signers.agentFor(job, s.mandate);
    } catch (error) {
      if (!(error instanceof AgentKeyUnavailableError)) throw error;
      return this.needsAttention(job, 'payout.advance', store, 'submitting', error.code);
    }
    let sent;
    try {
      sent = await this.o.chain.requestPayout(this.intentOf(s), agent, this.send(job));
    } catch (error) {
      if (
        error instanceof ChainError &&
        error.code === 'CONTRACT_REFUSED' &&
        error.reason !== 'payout_id_exists'
      ) {
        return this.block(job, store, s, specErrorOf(error));
      }
      // The send may have landed even though its answer was lost; the chain says.
      const after = await this.state(job, s);
      if (after.kind === 'absent') throw error;
      return this.follow(job, store, s, 'submitting', after, await this.landed(job, error));
    }
    const onChain: ChainPayoutState =
      sent.state === undefined
        ? await this.state(job, s)
        : sent.state === 'pending'
          ? { kind: 'pending', approvals: 0 }
          : { kind: 'approved' };
    if (onChain.kind === 'absent') throw new PayoutRetryError('CHAIN_LAGGING');
    return this.follow(job, store, s, 'submitting', onChain, sent.txHash);
  }

  /** The hash of a send whose answer was lost, once the network confirms it landed. */
  private async landed(job: PayoutJobContext, error: unknown): Promise<string | undefined> {
    if (!(error instanceof ChainError) || error.txHash === undefined) return undefined;
    const tx = await this.o.chain.transaction(error.txHash, this.read(job));
    return tx.status === 'SUCCESS' ? error.txHash : undefined;
  }

  /** Moves the payout to match what the chain says, from `from`. */
  private async follow(
    job: PayoutJobContext,
    store: PayoutStore,
    s: PayoutSnapshot,
    from: 'submitting' | 'pending_approval',
    known?: ChainPayoutState,
    requestTxHash?: string,
  ): Promise<StepOutcome> {
    const onChain = known ?? (await this.state(job, s));
    const recorded =
      requestTxHash !== undefined && s.payout.requestTxHash === null ? { requestTxHash } : {};
    const task = 'payout.advance';
    const detail = requestTxHash === undefined ? {} : { tx: requestTxHash };
    switch (onChain.kind) {
      case 'pending': {
        if (from === 'pending_approval') {
          const waited = this.now().getTime() - s.payout.updatedAt.getTime();
          await store.apply(job.payoutId, {
            enqueue: [{ task, afterSeconds: approvalRecheckSeconds(waited) }],
          });
          return 'waiting';
        }
        const change: PayoutChange = {
          path: [{ from, to: 'pending_approval', ...recorded }],
          enqueue: [{ task, afterSeconds: APPROVAL_RECHECK_MIN_SECONDS }],
        };
        return (await this.move(job, task, store, change, detail)) ? 'waiting' : 'stale';
      }
      case 'approved':
      case 'executed': {
        const change: PayoutChange = {
          path: [{ from, to: 'approved', ...recorded }],
          enqueue: [{ task: 'payout.execute' }],
        };
        return (await this.move(job, task, store, change, detail)) ? 'approved' : 'stale';
      }
      case 'rejected':
      case 'cancelled': {
        const to = onChain.kind;
        const path: PayoutTransition[] =
          from === 'submitting'
            ? [
                { from, to: 'pending_approval', ...recorded },
                { from: 'pending_approval', to },
              ]
            : [{ from, to }];
        const change: PayoutChange = {
          path,
          legs: legsTo(s.legs, 'planned', 'cancelled'),
          enqueue: [{ task: 'receipt.issue' }],
        };
        return (await this.move(job, task, store, change, detail)) ? to : 'stale';
      }
      case 'absent':
        // A payout the chain once held is gone. Reconcile compares it with
        // the chain; guessing here could pay or drop it wrongly.
        this.o.log(
          logLine('payout_drift', {
            principalId: job.principalId,
            projectId: job.projectId,
            payoutId: job.payoutId,
            task,
            status: from,
            chain: onChain.kind,
          }),
        );
        return 'drift';
    }
  }

  private async block(
    job: PayoutJobContext,
    store: PayoutStore,
    s: PayoutSnapshot,
    specError: string,
  ): Promise<StepOutcome> {
    const change: PayoutChange = {
      path: [{ from: 'submitting', to: 'blocked', blockedBy: specError }],
      legs: legsTo(s.legs, 'planned', 'cancelled'),
      enqueue: [{ task: 'receipt.issue' }],
    };
    return (await this.move(job, 'payout.advance', store, change)) ? 'blocked' : 'stale';
  }

  private async needsAttention(
    job: PayoutJobContext,
    task: PayoutJobTask,
    store: PayoutStore,
    from: 'submitting' | 'settling',
    reason: string,
    legs: readonly LegChange[] = [],
  ): Promise<StepOutcome> {
    const change: PayoutChange = { path: [{ from, to: 'needs_attention' }], legs };
    return (await this.move(job, task, store, change, { reason })) ? 'needs_attention' : 'stale';
  }

  /** payout.execute: settle an approved payout through the wallet rail and record it. */
  async execute(job: PayoutJobContext, store: PayoutStore): Promise<StepOutcome> {
    const loaded = await store.load(job.payoutId);
    if (loaded === undefined) return 'missing';
    const status = loaded.payout.status;
    if (isTerminal(status)) return this.ensureReceipt(store, loaded);
    if (status === 'approved' || status === 'needs_attention') {
      // Settling before the send, so a send that keeps failing can end in
      // needs_attention, which approved has no way to.
      const path = [{ from: status, to: 'settling' }] as const;
      if (!(await this.move(job, 'payout.execute', store, { path }))) return 'stale';
    } else if (status !== 'settling') {
      // Still the agent's: advance hands it over once the chain approves it.
      return 'not_ready';
    }
    // The wallet rail is the only method a leg can hold today: the mandate's
    // execute pays every leg to its destination in one transaction, so all
    // legs share one hash. A partner rail settles here as another branch.
    return this.settle(job, store, loaded, true);
  }

  private async settle(
    job: PayoutJobContext,
    store: PayoutStore,
    s: PayoutSnapshot,
    maySend: boolean,
  ): Promise<StepOutcome> {
    const task = 'payout.execute';
    const onChain = await this.state(job, s);
    const hash = sentHash(s.legs);
    const sentAt = s.legs[0]?.updatedAt.getTime() ?? 0;
    const mayStillLand = (): boolean =>
      this.now().getTime() < sentAt + (this.o.sendWindowMs ?? DEFAULT_SEND_WINDOW_MS);
    if (onChain.kind === 'executed') {
      if (hash !== undefined) {
        const tx = await this.o.chain.transaction(hash, this.read(job));
        if (tx.status === 'SUCCESS') return this.paid(job, store, s, hash);
        if (tx.status === 'NOT_FOUND' && mayStillLand())
          throw new PayoutRetryError('CHAIN_LAGGING');
      }
      // Paid by a transaction this payout never recorded, such as one sent
      // before the payout had a row. A person must match it up.
      return this.needsAttention(job, task, store, 'settling', 'EXECUTED_UNRECORDED');
    }
    if (onChain.kind !== 'approved') {
      return this.needsAttention(
        job,
        task,
        store,
        'settling',
        `CHAIN_${onChain.kind.toUpperCase()}`,
      );
    }
    let legs = s.legs;
    if (hash !== undefined) {
      const tx = await this.o.chain.transaction(hash, this.read(job));
      if (tx.status === 'SUCCESS') throw new PayoutRetryError('CHAIN_LAGGING');
      if (tx.status === 'NOT_FOUND' && mayStillLand()) {
        throw new PayoutRetryError('SETTLEMENT_PENDING');
      }
      // That send failed or can no longer land, so the legs go back to be sent again.
      const reset = legsTo(s.legs, 'submitted', 'planned');
      if (!(await store.apply(job.payoutId, { legs: reset }))) return 'stale';
      legs = s.legs.map((leg): PayoutLeg => ({ ...leg, status: 'planned', txHash: null }));
    }
    if (!maySend) return this.needsAttention(job, task, store, 'settling', 'EXECUTE_REFUSED');
    return this.sendExecute(job, store, { ...s, legs });
  }

  private async sendExecute(
    job: PayoutJobContext,
    store: PayoutStore,
    s: PayoutSnapshot,
  ): Promise<StepOutcome> {
    let txHash: string;
    // Set inside the hook, so read through an object rather than a narrowed local.
    const hook = { recorded: false };
    try {
      ({ txHash } = await this.o.chain.executePayout(
        s.mandate.contractAddress,
        s.payout.onchainPayoutId,
        this.o.signers.executor,
        this.send(job),
        {
          beforeSend: async (hash) => {
            hook.recorded = await store.apply(job.payoutId, {
              legs: legsTo(s.legs, 'planned', 'submitted', hash),
            });
            if (!hook.recorded) throw new PayoutRetryError('STALE_PAYOUT');
          },
        },
      ));
    } catch (error) {
      if (!(error instanceof ChainError) || error.code !== 'CONTRACT_REFUSED') throw error;
      // Refused, perhaps because an earlier send executed it. Read everything
      // again and settle from what the chain says, sending nothing more.
      const again = await store.load(job.payoutId);
      if (again?.payout.status !== 'settling') return 'stale';
      const outcome = await this.settle(job, store, again, false);
      if (outcome === 'needs_attention') {
        this.o.log(
          logLine('payout_execute_refused', {
            principalId: job.principalId,
            projectId: job.projectId,
            payoutId: job.payoutId,
            specError: specErrorOf(error),
          }),
        );
      }
      return outcome;
    }
    // Recorded as sent before the send, unless the adapter offers no hook.
    const status: LegStatus = hook.recorded ? 'submitted' : 'planned';
    const sent = s.legs.map((leg): PayoutLeg => ({ ...leg, status, txHash }));
    return this.paid(job, store, { ...s, legs: sent }, txHash);
  }

  private async paid(
    job: PayoutJobContext,
    store: PayoutStore,
    s: PayoutSnapshot,
    txHash: string,
  ): Promise<StepOutcome> {
    const change: PayoutChange = {
      path: [{ from: 'settling', to: 'paid' }],
      legs: [
        ...legsTo(s.legs, 'submitted', 'settled', txHash),
        ...legsTo(s.legs, 'planned', 'settled', txHash),
      ],
      enqueue: [{ task: 'receipt.issue' }],
    };
    return (await this.move(job, 'payout.execute', store, change, { tx: txHash }))
      ? 'paid'
      : 'stale';
  }
}
