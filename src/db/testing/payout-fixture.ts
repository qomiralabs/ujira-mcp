// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// What a payout needs before it can be written: a key, a mandate that names
// it, a recipient on the mandate and a wallet to pay them at. Made through the
// repositories, as the app makes them, so the payout tests rest on the same
// rows production has.

import { createHash, randomUUID } from 'node:crypto';

import { tokenAmount, type TokenAmount } from '../../money/index.js';
import type { Database, ProjectContext } from '../database.js';
import { agentKeys } from '../repositories/agent-keys.js';
import { mandates } from '../repositories/mandates.js';
import type { PayoutJob, PayoutJobQueue } from '../repositories/payout-jobs.js';
import type { NewPayout } from '../repositories/payouts.js';
import { payoutMethods, recipients } from '../repositories/recipients.js';
import { nonce, sealed, testAccount, testAccounts, testContract, testHex32 } from './accounts.js';

export const TESTNET = 'stellar:testnet';

export interface PayoutWorld {
  readonly context: ProjectContext;
  readonly mandateId: string;
  readonly recipientId: string;
  readonly methodId: string;
  readonly destination: string;
  // A second recipient on the same mandate, with a wallet of their own.
  readonly otherRecipientId: string;
  readonly otherMethodId: string;
  // What the chain knows the first recipient by, and the key the mandate names.
  readonly recipientRef: string;
  readonly agentKeyId: string;
}

// For a test that drives the world through a chain fake: the contract, agent
// and first recipient the fake already knows.
export interface PayoutWorldOptions {
  readonly contractAddress?: string;
  readonly agentPublicKey?: string;
  readonly destination?: string;
  readonly recipientRef?: string;
}

export const usdc = (amount: bigint): TokenAmount => tokenAmount(amount, 'USDC', 'stellar');

export async function payoutWorld(
  db: Database,
  context: ProjectContext,
  options: PayoutWorldOptions = {},
): Promise<PayoutWorld> {
  return db.tenant(context).transaction(async (tx) => {
    // A project holds one active key per network, so a second world in the
    // same project shares it.
    const key =
      (await agentKeys.active(tx, TESTNET)) ??
      (await agentKeys.create(
        tx,
        {
          network: TESTNET,
          publicKey: options.agentPublicKey ?? testAccount(),
          secretCiphertext: sealed(1),
          secretNonce: nonce(2),
        },
        testAccounts,
      ));
    const mandate = await mandates.create(
      tx,
      {
        name: 'Payroll',
        network: TESTNET,
        contractAddress: options.contractAddress ?? testContract(),
        asset: 'USDC',
        scale: 7,
        agent: { keyId: key.id },
        principalWallet: testAccount(),
      },
      testAccounts,
    );
    const person = async (
      label: string,
      recipientRef = testHex32(),
      destination = testAccount(),
    ) => {
      const recipient = await recipients.create(tx, {
        mandateId: mandate.id,
        label,
        recipientRef,
      });
      const method = await payoutMethods.addWallet(
        tx,
        {
          recipientId: recipient.id,
          destination,
          destinationCheck: { receivable: true },
          verified: true,
        },
        testAccounts,
      );
      return { recipient, method };
    };
    const ada = await person('Ada', options.recipientRef, options.destination);
    const grace = await person('Grace');
    return {
      context,
      mandateId: mandate.id,
      recipientId: ada.recipient.id,
      methodId: ada.method.id,
      destination: ada.method.destination,
      otherRecipientId: grace.recipient.id,
      otherMethodId: grace.method.id,
      recipientRef: ada.recipient.recipientRef,
      agentKeyId: key.id,
    };
  });
}

// One leg for the whole amount, under a fresh key, task and on chain id.
export function newPayout(world: PayoutWorld, overrides: Partial<NewPayout> = {}): NewPayout {
  const amount = overrides.amount ?? usdc(25_000_000n);
  return {
    idempotencyKey: `key-${randomUUID()}`,
    requestHash: testHex32(),
    mandateId: world.mandateId,
    recipientId: world.recipientId,
    taskId: `task-${randomUUID()}`,
    onchainPayoutId: testHex32(),
    amount,
    legs: [{ payoutMethodId: world.methodId, amount }],
    ...overrides,
  };
}

export interface RecordingJobQueue extends PayoutJobQueue {
  readonly jobs: PayoutJob[];
}

export function recordingJobs(): RecordingJobQueue {
  const jobs: PayoutJob[] = [];
  return {
    jobs,
    enqueue: (_db, job) => {
      jobs.push(job);
      return Promise.resolve();
    },
  };
}

// The key the database derives for a leg, computed the same way here so a
// test can say what it must be.
export function legKeyOf(payoutId: string, index: number): string {
  return createHash('sha256')
    .update(`ujira/leg/v1|${payoutId}|${String(index)}`)
    .digest('hex');
}
