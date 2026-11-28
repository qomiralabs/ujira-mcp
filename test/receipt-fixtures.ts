// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// Receipts held in memory for the receipt tests. The paid one is the
// recorded testnet payout (test/fixtures/horizon/recorded.ts), with the ids
// the console's recorded answers use.

import { tokenAmount } from '../src/money/index.js';
import type { ReceiptView } from '../src/receipts/model.js';
import { RECORDED } from './fixtures/horizon/recorded.js';

export const IDS = {
  principal: '7d0c2f3e-6a51-4c1e-9a7e-0b1f5c0f6a10',
  project: '1f4b2b8e-2a8d-4f0f-8c55-6f0e3e2c9b21',
  mandate: '0b8f6a4c-58c3-4a3b-9f0e-6c1d2e3f4a5b',
  recipient: '5a1e9c2d-7b3f-4e8a-a1c2-3d4e5f6a7b8c',
  payout: '9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c6b',
  receipt: '3c2b1a0f-9e8d-4c7b-8a6f-5e4d3c2b1a0f',
} as const;

export const usdc = (amount: bigint) => tokenAmount(amount, 'USDC', 'stellar');

export const ISSUED = new Date('2026-11-25T12:00:10.000Z');

export function paidReceipt(over: Partial<ReceiptView> = {}): ReceiptView {
  return {
    id: IDS.receipt,
    payoutId: IDS.payout,
    principalId: IDS.principal,
    projectId: IDS.project,
    mandate: { id: IDS.mandate, contractId: RECORDED.mandate },
    recipient: { id: IDS.recipient, label: 'Ada', ref: 'c'.repeat(64) },
    taskId: 'demo-20261113T1101-01',
    network: RECORDED.network,
    amount: usdc(RECORDED.amount),
    fee: usdc(0n),
    outcome: 'paid',
    blockedBy: null,
    txHash: RECORDED.executeTx,
    ref: `ujira:tx:v1:${RECORDED.network}:${RECORDED.executeTx}:0`,
    requestTxHash: RECORDED.requestTx,
    issuedAt: ISSUED,
    settledAt: new Date('2026-11-25T12:00:09.000Z'),
    legs: [
      {
        index: 0,
        destination: RECORDED.destination,
        amount: usdc(RECORDED.amount),
        txHash: RECORDED.executeTx,
      },
    ],
    ...over,
  };
}

export function blockedReceipt(): ReceiptView {
  return paidReceipt({
    outcome: 'blocked',
    blockedBy: 'PER_PAYMENT_CAP_EXCEEDED',
    txHash: null,
    ref: null,
    requestTxHash: null,
    settledAt: null,
    legs: [
      { index: 0, destination: RECORDED.destination, amount: usdc(RECORDED.amount), txHash: null },
    ],
  });
}
