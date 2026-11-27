// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// One payout in memory behind the PayoutStore port, with the same rules the
// database keeps: moves only from the status a change expects, by the status
// machines, all or nothing, a request hash recorded once, and sent or settled
// legs carrying their hash. A test can make a write fail, as a worker killed
// at that point would, and the store keeps everything before it.

import { randomUUID } from 'node:crypto';

import type { Mandate, Payout, PayoutLeg, Recipient } from '../src/db/index.js';
import { tokenAmount } from '../src/money/index.js';
import { assertLegTransition } from '../src/payouts/leg-status.js';
import { assertTransition, type PayoutStatus } from '../src/payouts/status.js';
import type {
  JobRequest,
  PayoutChange,
  PayoutSnapshot,
  PayoutStore,
} from '../src/payouts/workflow.js';
import { MANDATE, agent } from './fake-rpc.js';

export const PRINCIPAL = '0b8f4a52-6f2e-4d4b-9f39-2f6f5b1c7a10';
export const PROJECT = '5a1e7c3d-1b2a-4c5d-8e9f-0a1b2c3d4e5f';
export const PROJECT_AGENT_ROW = '7f6e5d4c-3b2a-4190-8a7b-6c5d4e3f2a1b';

export interface MemoryPayout {
  readonly amount: bigint;
  readonly destination: string;
  readonly recipientRef: string;
  readonly onchainPayoutId: string;
  readonly legs?: readonly bigint[];
  readonly agentKeyId?: string | null;
  /** The fake mandate and its agent unless a testnet run names real ones. */
  readonly contractAddress?: string;
  readonly agentAddress?: string;
}

export class KilledError extends Error {
  override readonly name = 'KilledError';
  readonly code = 'KILLED';
}

export class MemoryPayoutStore implements PayoutStore {
  payout: Payout;
  legs: PayoutLeg[];
  readonly mandate: Mandate;
  readonly recipient: Recipient;
  hasReceipt = false;
  /** Every status the payout has been in, in order. */
  readonly history: PayoutStatus[];
  /** The jobs each successful write queued, in order. */
  readonly jobs: JobRequest[] = [];
  /** The writes that landed, each with the jobs it queued. */
  readonly writes: PayoutChange[] = [];
  /** A write this returns true for throws, as a killed worker's would. */
  killWhen: ((change: PayoutChange) => boolean) | undefined;
  now: () => Date;

  constructor(p: MemoryPayout, now: () => Date) {
    this.now = now;
    const at = now();
    const usdc = (n: bigint) => tokenAmount(n, 'USDC', 'stellar');
    const id = randomUUID();
    this.payout = {
      id,
      projectId: PROJECT,
      mandateId: randomUUID(),
      recipientId: randomUUID(),
      taskId: `task-${id}`,
      idempotencyKey: `key-${id}`,
      network: 'stellar:testnet',
      amount: usdc(p.amount),
      fee: usdc(0n),
      status: 'queued',
      blockedBy: null,
      onchainPayoutId: p.onchainPayoutId,
      requestTxHash: null,
      metadata: {},
      createdAt: at,
      updatedAt: at,
      settledAt: null,
    };
    this.legs = (p.legs ?? [p.amount]).map((amount, index) => ({
      id: randomUUID(),
      payoutId: id,
      index,
      payoutMethodId: randomUUID(),
      method: 'stellar_wallet',
      destination: p.destination,
      amount: usdc(amount),
      fee: usdc(0n),
      legKey: String(index).padStart(64, '0'),
      txHash: null,
      status: 'planned',
      createdAt: at,
      updatedAt: at,
    }));
    this.mandate = {
      id: this.payout.mandateId,
      projectId: PROJECT,
      name: 'Payroll',
      network: 'stellar:testnet',
      contractAddress: p.contractAddress ?? MANDATE,
      asset: 'USDC',
      scale: 7,
      agentKeyId: p.agentKeyId === undefined ? PROJECT_AGENT_ROW : p.agentKeyId,
      agentAddress: p.agentAddress ?? agent.publicKey,
      principalWallet: p.agentAddress ?? agent.publicKey,
      createdTxHash: null,
      createdAt: at,
    };
    this.recipient = {
      id: this.payout.recipientId,
      projectId: PROJECT,
      mandateId: this.payout.mandateId,
      label: 'Ada',
      recipientRef: p.recipientRef,
      status: 'active',
      createdAt: at,
    };
    this.history = ['queued'];
  }

  load(payoutId: string): Promise<PayoutSnapshot | undefined> {
    if (payoutId !== this.payout.id) return Promise.resolve(undefined);
    return Promise.resolve({
      payout: { ...this.payout },
      legs: this.legs.map((leg) => ({ ...leg })),
      mandate: this.mandate,
      recipient: this.recipient,
      hasReceipt: this.hasReceipt,
    });
  }

  apply(payoutId: string, change: PayoutChange): Promise<boolean> {
    if (this.killWhen?.(change) === true) return Promise.reject(new KilledError('killed'));
    if (payoutId !== this.payout.id) return Promise.resolve(false);
    const at = this.now();
    let payout = { ...this.payout };
    const seen: PayoutStatus[] = [];
    for (const step of change.path ?? []) {
      if (payout.status !== step.from) return Promise.resolve(false);
      assertTransition(step.from, step.to);
      if ((step.to === 'blocked') !== (step.blockedBy !== undefined)) {
        throw new Error('blockedBy goes with blocked, and only with it');
      }
      if (
        step.requestTxHash !== undefined &&
        payout.requestTxHash !== null &&
        payout.requestTxHash !== step.requestTxHash
      ) {
        throw new Error('the request hash is recorded once');
      }
      payout = {
        ...payout,
        status: step.to,
        blockedBy: step.blockedBy ?? null,
        requestTxHash: step.requestTxHash ?? payout.requestTxHash,
        updatedAt: at,
        settledAt: step.to === 'paid' ? at : payout.settledAt,
      };
      seen.push(step.to);
    }
    const legs = this.legs.map((leg) => ({ ...leg }));
    for (const { legId, change: move } of change.legs ?? []) {
      const index = legs.findIndex((leg) => leg.id === legId);
      const leg = legs[index];
      if (leg === undefined || leg.status !== move.from) return Promise.resolve(false);
      assertLegTransition(move.from, move.to);
      const txHash = move.txHash ?? leg.txHash;
      if ((move.to === 'submitted' || move.to === 'settled') && txHash === null) {
        throw new Error('a sent or settled leg carries its hash');
      }
      legs[index] = { ...leg, status: move.to, txHash, updatedAt: at };
    }
    this.payout = payout;
    this.legs = legs;
    this.history.push(...seen);
    this.jobs.push(...(change.enqueue ?? []));
    this.writes.push(change);
    return Promise.resolve(true);
  }

  /** The tasks queued so far, by name. */
  queued(): string[] {
    return this.jobs.map((job) =>
      job.afterSeconds === undefined ? job.task : `${job.task}+${String(job.afterSeconds)}s`,
    );
  }
}
