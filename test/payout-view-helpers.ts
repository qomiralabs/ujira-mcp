// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// Payout views held in memory, shaped as the repository returns them, for the
// tests of the read service and its routes.

import { randomUUID } from 'node:crypto';

import type { PayoutLeg, PayoutView, ProjectContext } from '../src/db/index.js';
import { tokenAmount } from '../src/money/index.js';

export const TENANT: ProjectContext = {
  principalId: '7d0c2f3e-6a51-4c1e-9a7e-0b1f5c0f6a10',
  projectId: '1f4b2b8e-2a8d-4f0f-8c55-6f0e3e2c9b21',
};
export const CONTRACT = 'CB4AYBA5NVQPVPNOWUCSZQK6ZIGOF7KSCS6SF6UV6D2OKPDXLHEPD4V7';
export const WALLET = 'GBT7ITQKEX3Z2YWIYLPRQ5W3JLA2TJ3JTABB765ZYNG7VLX5YYUPI3DT';
export const TX = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';
export const CREATED = new Date('2026-11-25T12:00:00.000Z');
export const MOVED = new Date('2026-11-25T12:00:09.000Z');

export const usdc = (amount: bigint) => tokenAmount(amount, 'USDC', 'stellar');

export function legOf(payoutId: string, over: Partial<PayoutLeg> = {}): PayoutLeg {
  return {
    id: randomUUID(),
    payoutId,
    index: 0,
    payoutMethodId: randomUUID(),
    method: 'stellar_wallet',
    destination: WALLET,
    amount: usdc(25_000_000n),
    fee: usdc(0n),
    legKey: 'b'.repeat(64),
    txHash: null,
    status: 'planned',
    createdAt: CREATED,
    updatedAt: CREATED,
    ...over,
  };
}

export interface ViewParts {
  readonly payout?: Partial<PayoutView['payout']>;
  readonly legs?: readonly Partial<PayoutLeg>[];
  readonly mandateId?: string;
  readonly receiptId?: string | null;
}

/** A queued wallet payout of 2.5 USDC to Ada, unless the parts say otherwise. */
export function viewOf(parts: ViewParts = {}): PayoutView {
  const id = parts.payout?.id ?? randomUUID();
  const mandateId = parts.mandateId ?? randomUUID();
  return {
    principalId: TENANT.principalId,
    payout: {
      id,
      projectId: TENANT.projectId,
      mandateId,
      recipientId: '5a1e9c2d-7b3f-4e8a-a1c2-3d4e5f6a7b8c',
      taskId: 'task-42',
      idempotencyKey: 'key-42',
      network: 'stellar:testnet',
      amount: usdc(25_000_000n),
      fee: usdc(0n),
      status: 'queued',
      blockedBy: null,
      onchainPayoutId: 'f'.repeat(64),
      requestTxHash: null,
      metadata: { batch: 'week-48' },
      createdAt: CREATED,
      updatedAt: CREATED,
      settledAt: null,
      ...parts.payout,
    },
    mandate: { id: mandateId, contractAddress: CONTRACT },
    recipient: { id: '5a1e9c2d-7b3f-4e8a-a1c2-3d4e5f6a7b8c', label: 'Ada' },
    legs: (parts.legs ?? [{}]).map((leg, index) => legOf(id, { index, ...leg })),
    receiptId: parts.receiptId ?? null,
  };
}

/** The same payout, paid: requested on chain, its leg settled, its receipt written. */
export function paidView(over: ViewParts = {}): PayoutView {
  return viewOf({
    ...over,
    payout: {
      status: 'paid',
      requestTxHash: TX,
      updatedAt: MOVED,
      settledAt: MOVED,
      ...over.payout,
    },
    legs: over.legs ?? [{ status: 'settled', txHash: TX, updatedAt: MOVED }],
    receiptId: over.receiptId ?? '3c2b1a0f-9e8d-4c7b-8a6f-5e4d3c2b1a0f',
  });
}
