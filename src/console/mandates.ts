// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// One payout engine per console mandate, built on demand from what the
// registry knows (the mandate and its recipient names) and the same keys,
// rails and receipt log as the demo mandate. Building one costs no network
// call; the rules always come from the chain when the engine asks.

import type { TxSigner } from '../chain/adapter.js';
import { isAccountAddress } from '../chain/stellar/addresses.js';
import type { StellarChainAdapter } from '../chain/stellar/adapter.js';
import { PAYOUT_STATUS, type PayoutEntry } from '../chain/types.js';
import { PayoutEngine } from '../engine/engine.js';
import type { Log } from '../log.js';
import { legacyRailName, type PayoutRail } from '../rails/rail.js';
import { WalletRail } from '../rails/wallet.js';
import type { Receipt, ReceiptLog } from '../receipts/log.js';
import type { ConsoleExtension } from './extension.js';
import type { MandateEntry } from './registry.js';

export interface MandateServices {
  readonly adapter: StellarChainAdapter;
  readonly receipts: ReceiptLog;
  readonly agent: TxSigner;
  readonly executor: TxSigner;
  /** Rails beyond the wallet rail come only from here. */
  readonly extension?: Pick<ConsoleExtension, 'rails'>;
  readonly now?: () => Date;
  /** Where each console mandate's engine writes its payout lines. */
  readonly log?: Log;
}

/** Recipient names to wallets, as the rails resolve them. */
export function namesOf(entry: MandateEntry): Record<string, string> {
  return Object.fromEntries(entry.recipients.map((r) => [r.label, r.address]));
}

export function engineFor(entry: MandateEntry, s: MandateServices): PayoutEngine {
  const mandate = s.adapter.mandate(entry.id);
  const names = namesOf(entry);
  const rails: PayoutRail[] = [
    new WalletRail(mandate, s.executor, names),
    ...(s.extension?.rails(mandate, names) ?? []),
  ];
  return new PayoutEngine({
    mandate,
    agent: s.agent,
    rails,
    receipts: s.receipts,
    assetCode: 'USDC',
    network: 'testnet',
    ...(s.now === undefined ? {} : { now: s.now }),
    ...(s.log === undefined ? {} : { log: s.log }),
  });
}

export type PayoutStatus =
  'pending_approval' | 'approved' | 'paid' | 'rejected' | 'cancelled' | 'expired' | 'blocked';

export interface PayoutView {
  readonly taskId: string;
  readonly payoutId: string | null;
  readonly recipient: string;
  readonly recipientLabel: string | null;
  readonly amount: string;
  /** The rail's old name, which is what the dashboard reads. */
  readonly rail: string;
  readonly status: PayoutStatus;
  readonly reason?: string;
  readonly requestTx?: string;
  readonly paidTx?: string;
  /** Set on the SDP rail: the transaction in which SDP paid the person. */
  readonly sdpTx?: string;
  readonly at: string;
}

/**
 * Where a payout stands. The chain decides wherever it has a record, since
 * an approval or a rejection happens in the owner's wallet, not here.
 */
export function payoutStatus(
  receipt: Receipt,
  entry: PayoutEntry | null,
  nowSeconds: bigint,
): PayoutStatus {
  if (entry === null) {
    if (receipt.outcome === 'paid' || receipt.outcome === 'approved_then_paid') return 'paid';
    return 'blocked';
  }
  const lapsed = entry.kind === 'record' && entry.expiresAt <= nowSeconds;
  switch (entry.status) {
    case PAYOUT_STATUS.pending:
      return lapsed ? 'expired' : 'pending_approval';
    case PAYOUT_STATUS.approved:
      return lapsed ? 'expired' : 'approved';
    case PAYOUT_STATUS.executed:
      return 'paid';
    case PAYOUT_STATUS.rejected:
      return 'rejected';
    case PAYOUT_STATUS.cancelled:
      return 'cancelled';
    default:
      return 'blocked';
  }
}

/** Runs `work` over `items` with at most `limit` in flight, keeping the order. */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array<R>(items.length);
  let next = 0;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      const item = items[i];
      if (i >= items.length || item === undefined) return;
      out[i] = await work(item);
    }
  });
  await Promise.all(lanes);
  return out;
}

export async function payoutsOf(
  entry: MandateEntry,
  s: MandateServices,
  limit = 100,
): Promise<PayoutView[]> {
  const mandate = s.adapter.mandate(entry.id);
  const receipts = await s.receipts.list(entry.id, { limit });
  const now = BigInt(Math.floor((s.now?.() ?? new Date()).getTime() / 1000));
  const labelOf = new Map(entry.recipients.map((r) => [r.address, r.label]));
  const addressOf = new Map(entry.recipients.map((r) => [r.label, r.address]));
  return mapLimit(receipts, 6, async (r) => {
    const onChain = r.payout_id === undefined ? null : await mandate.payout(r.payout_id);
    const status = payoutStatus(r, onChain, now);
    const recipient = isAccountAddress(r.recipient)
      ? r.recipient
      : (addressOf.get(r.recipient) ?? r.destination);
    return {
      taskId: r.task_id,
      payoutId: r.payout_id ?? null,
      recipient,
      recipientLabel: labelOf.get(recipient) ?? null,
      amount: r.amount.toString(),
      rail: legacyRailName(r.rail),
      status,
      ...(r.reason === undefined || status !== 'blocked' ? {} : { reason: r.reason }),
      ...(r.request_tx_hash === undefined ? {} : { requestTx: r.request_tx_hash }),
      ...(r.tx_hash === undefined ? {} : { paidTx: r.tx_hash }),
      ...(r.sdp_tx_hash === undefined ? {} : { sdpTx: r.sdp_tx_hash }),
      at: r.updated_at,
    };
  });
}

export interface MandateView {
  readonly id: string;
  readonly principal: string;
  readonly approver: string | null;
  readonly agent: string | null;
  readonly executor: string | null;
  readonly rules: {
    readonly budget: string;
    readonly perPaymentCap: string;
    readonly dailyCap: string;
    readonly approvalThreshold: string;
    readonly expiresAt: number;
    readonly feeCapBps: number;
  };
  readonly state: {
    readonly balance: string;
    readonly spent: string;
    readonly remaining: string;
    readonly paused: boolean;
    readonly revoked: boolean;
    readonly expired: boolean;
  };
  readonly recipients: readonly { label: string; address: string; recipientRef: string }[];
}

export async function mandateView(
  entry: MandateEntry,
  adapter: StellarChainAdapter,
): Promise<MandateView> {
  const mandate = adapter.mandate(entry.id);
  const [config, state] = await Promise.all([mandate.config(), mandate.state()]);
  const used = state.spent + state.pending + state.committed;
  const remaining = config.limits.totalBudget - used;
  return {
    id: entry.id,
    principal: config.principal,
    approver: config.approvers[0] ?? null,
    agent: config.agents[0] ?? null,
    executor: config.executors[0] ?? null,
    rules: {
      budget: config.limits.totalBudget.toString(),
      perPaymentCap: config.limits.perPaymentCap.toString(),
      dailyCap: config.limits.perRecipientDailyCap.toString(),
      approvalThreshold: config.limits.approvalThreshold.toString(),
      expiresAt: Number(config.limits.expiresAt),
      feeCapBps: config.maxFeeBps,
    },
    state: {
      balance: state.balance.toString(),
      spent: state.spent.toString(),
      remaining: (remaining < 0n ? 0n : remaining).toString(),
      paused: state.paused,
      revoked: state.revoked,
      expired: state.expired,
    },
    recipients: entry.recipients.map((r) => ({
      label: r.label,
      address: r.address,
      recipientRef: r.recipientRef,
    })),
  };
}
