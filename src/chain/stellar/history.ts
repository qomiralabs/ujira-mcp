// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// A transaction as the network's history keeps it: whether it succeeded,
// which contract functions it called and what it moved. Read from Horizon,
// which keeps every ledger, because RPC forgets a transaction after about a
// week and a receipt has to be checkable for as long as anyone holds it.
//
// Horizon's answer is outside data, so it is parsed with zod and every
// amount goes through integer math. Anything in a shape we do not expect is
// an error, never a guess: a receipt check that quietly read nothing would
// say a real payment was missing.

import { scValToNative, xdr } from '@stellar/stellar-sdk';
import { z } from 'zod';

import { ChainError } from '../adapter.js';

/** One movement of one asset, as the network recorded it. */
export interface RecordedTransfer {
  /** `native`, or CODE:ISSUER. */
  readonly asset: string;
  readonly from: string;
  readonly to: string;
  /** Minor units. */
  readonly amount: bigint;
}

export interface RecordedCall {
  readonly contract: string;
  readonly fn: string;
}

export interface TransactionRecord {
  readonly successful: boolean;
  readonly ledger: number;
  readonly calls: readonly RecordedCall[];
  readonly transfers: readonly RecordedTransfer[];
}

/** Most operations a transaction can hold, so one page of them is all of them. */
export const MAX_OPERATIONS = 100;

const horizonTransaction = z.object({
  successful: z.boolean(),
  ledger: z.int().positive(),
});

const balanceChange = z.object({
  asset_type: z.string(),
  asset_code: z.string().optional(),
  asset_issuer: z.string().optional(),
  type: z.string(),
  from: z.string().optional(),
  to: z.string().optional(),
  amount: z.string(),
});

const operation = z.object({
  type: z.string(),
  parameters: z.array(z.object({ value: z.string(), type: z.string() })).optional(),
  asset_balance_changes: z.array(balanceChange).nullish(),
});

const horizonOperations = z.object({
  _embedded: z.object({ records: z.array(operation).max(MAX_OPERATIONS) }),
});

const shape = (what: string) =>
  new ChainError('UNAVAILABLE', `Horizon answered ${what} in an unexpected shape`, {
    reason: 'horizon_unavailable',
  });

// Horizon writes every Stellar amount with seven decimals.
const AMOUNT = /^(0|[1-9][0-9]{0,30})\.([0-9]{7})$/;

function minorOf(amount: string): bigint {
  const match = AMOUNT.exec(amount);
  if (match?.[1] === undefined || match[2] === undefined) throw shape('an amount');
  return BigInt(match[1]) * 10_000_000n + BigInt(match[2]);
}

function native(base64: string): unknown {
  try {
    return scValToNative(xdr.ScVal.fromXdr(base64, 'base64'));
  } catch {
    throw shape('a contract call');
  }
}

// The first two parameters of a contract call are the contract and the
// function name; the rest are its arguments, which are not needed here.
function callOf(op: z.output<typeof operation>): RecordedCall | null {
  if (op.type !== 'invoke_host_function') return null;
  const [target, fn] = op.parameters ?? [];
  // Creating a contract or uploading code calls nothing.
  if (target?.type !== 'Address' || fn?.type !== 'Sym') return null;
  const contract = native(target.value);
  const name = native(fn.value);
  if (typeof contract !== 'string' || !contract.startsWith('C') || typeof name !== 'string') {
    throw shape('a contract call');
  }
  return { contract, fn: name };
}

function transfersOf(op: z.output<typeof operation>): RecordedTransfer[] {
  return (op.asset_balance_changes ?? []).flatMap((change) => {
    // Mints, burns and clawbacks are not payments out of a mandate.
    if (change.type !== 'transfer') return [];
    if (change.from === undefined || change.to === undefined) throw shape('a transfer');
    const asset =
      change.asset_type === 'native'
        ? 'native'
        : change.asset_code !== undefined && change.asset_issuer !== undefined
          ? `${change.asset_code}:${change.asset_issuer}`
          : null;
    if (asset === null) throw shape('a transfer');
    return [{ asset, from: change.from, to: change.to, amount: minorOf(change.amount) }];
  });
}

/** The record from Horizon's transaction and its operations, as they were answered. */
export function recordFromHorizon(transaction: unknown, operations: unknown): TransactionRecord {
  const tx = horizonTransaction.safeParse(transaction);
  if (!tx.success) throw shape('a transaction');
  const ops = horizonOperations.safeParse(operations);
  if (!ops.success) throw shape('its operations');
  const records = ops.data._embedded.records;
  return {
    successful: tx.data.successful,
    ledger: tx.data.ledger,
    calls: records.flatMap((op) => {
      const call = callOf(op);
      return call === null ? [] : [call];
    }),
    transfers: records.flatMap(transfersOf),
  };
}
