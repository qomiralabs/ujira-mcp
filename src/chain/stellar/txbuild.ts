// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// Builds the unsigned transactions a wallet or a server key signs. Every
// transaction here is one operation with the signer as its source, so the
// signature on the envelope is the only authorization the call needs.

import { createHash, randomBytes } from 'node:crypto';

import {
  Asset,
  Contract,
  Operation,
  TransactionBuilder,
  xdr,
  type Account,
  type Transaction,
} from '@stellar/stellar-sdk';

import type { Hex32 } from '../../ids.js';
import { formatUnits } from '../../money.js';
import type { Limits } from '../types.js';
import { address, bytes32, i128, struct, u64 } from './codec.js';
import { TESTNET_PASSPHRASE } from './gateway.js';

/** Above the base fee so a busy testnet still takes it; the signer pays it. */
export const INCLUSION_FEE = '10000';
/** How long the wallet has to sign before the network refuses the transaction. */
export const SIGN_WINDOW_SECONDS = 300;
/** How long an approved payout stays executable, as the demo mandate uses. */
export const PAYOUT_TTL_SECONDS = 86_400n;
/** The contract takes at most this many allowlist entries in one call. */
export const MAX_ALLOW_ENTRIES = 10;

/** One contract call from `source`, unsigned and not yet simulated. */
export function invokeTx(
  source: Account,
  contract: string,
  method: string,
  args: readonly xdr.ScVal[],
  passphrase: string = TESTNET_PASSPHRASE,
): Transaction {
  return new TransactionBuilder(source, { fee: INCLUSION_FEE, networkPassphrase: passphrase })
    .addOperation(new Contract(contract).call(method, ...args))
    .setTimeout(SIGN_WINDOW_SECONDS)
    .build();
}

export function trustlineTx(
  source: Account,
  usdc: { code: string; issuer: string },
  passphrase: string = TESTNET_PASSPHRASE,
): Transaction {
  return new TransactionBuilder(source, { fee: INCLUSION_FEE, networkPassphrase: passphrase })
    .addOperation(Operation.changeTrust({ asset: new Asset(usdc.code, usdc.issuer) }))
    .setTimeout(SIGN_WINDOW_SECONDS)
    .build();
}

/** A classic payment of an issued asset, in minor units. */
export function paymentTx(
  source: Account,
  p: {
    readonly destination: string;
    readonly asset: { readonly code: string; readonly issuer: string };
    readonly amount: bigint;
    readonly timeoutSeconds: number;
  },
  passphrase: string = TESTNET_PASSPHRASE,
): Transaction {
  return new TransactionBuilder(source, { fee: INCLUSION_FEE, networkPassphrase: passphrase })
    .addOperation(
      Operation.payment({
        destination: p.destination,
        asset: new Asset(p.asset.code, p.asset.issuer),
        amount: formatUnits(p.amount),
      }),
    )
    .setTimeout(p.timeoutSeconds)
    .build();
}

const u32 = (n: number) => xdr.ScVal.scvU32(n);
const addresses = (list: readonly string[]) => xdr.ScVal.scvVec(list.map(address));

/**
 * Groups a principal's mandates for indexers without saying who the
 * principal is beyond what the chain already shows.
 */
export function tenantTagFor(principal: string): Hex32 {
  return createHash('sha256').update(`ujira-console/tenant/v1\n${principal}`).digest('hex');
}

/** The roles and rules of a new mandate, as the factory's MandateConfig takes them. */
export interface FactoryConfig {
  readonly principal: string;
  readonly asset: string;
  readonly agents: readonly string[];
  readonly approvers: readonly string[];
  readonly approvalsRequired: number;
  readonly executors: readonly string[];
  readonly limits: Limits;
  readonly maxFeeBps: number;
}

/**
 * The factory's MandateConfig as an ScVal. Recipients are an allowlist the
 * principal fills after creation; no guardians, recovery or attester.
 */
export function factoryConfig(c: FactoryConfig): xdr.ScVal {
  return struct({
    principal: address(c.principal),
    asset: address(c.asset),
    recipient_mode: u32(1),
    tenant_tag: bytes32(tenantTagFor(c.principal)),
    agents: addresses(c.agents),
    approvers: addresses(c.approvers),
    approvals_required: u32(c.approvalsRequired),
    guardians: addresses([]),
    executors: addresses(c.executors),
    recovery: addresses([]),
    recovery_threshold: u32(0),
    limits: struct({
      total_budget: i128(c.limits.totalBudget),
      per_payment_cap: i128(c.limits.perPaymentCap),
      per_recipient_daily_cap: i128(c.limits.perRecipientDailyCap),
      approval_threshold: i128(c.limits.approvalThreshold),
      payout_ttl_seconds: u64(c.limits.payoutTtlSeconds),
      expires_at: u64(c.limits.expiresAt),
    }),
    attester: xdr.ScVal.scvVoid(),
    country_policy_hash: bytes32('0'.repeat(64)),
    max_fee_bps: u32(c.maxFeeBps),
  });
}

/** The rules a console owner types, in minor units and unix seconds. */
export interface MandateRules {
  readonly budget: bigint;
  readonly perPaymentCap: bigint;
  readonly dailyCap: bigint;
  readonly approvalThreshold: bigint;
  readonly expiresAt: number;
  readonly feeCapBps?: number | undefined;
}

export interface CreateContext {
  readonly principal: string;
  readonly agent: string;
  readonly executor: string;
  readonly asset: string;
  /** Unix seconds, from the server clock. */
  readonly now: number;
  readonly salt?: Hex32;
}

/** The factory's MandateConfig for a console mandate, with the owner approving. */
export function mandateConfig(p: MandateRules, ctx: CreateContext): xdr.ScVal {
  return factoryConfig({
    principal: ctx.principal,
    asset: ctx.asset,
    agents: [ctx.agent],
    // The owner approves their own large payouts; one approval is enough.
    approvers: [ctx.principal],
    approvalsRequired: 1,
    executors: [ctx.executor],
    limits: {
      totalBudget: p.budget,
      perPaymentCap: p.perPaymentCap,
      perRecipientDailyCap: p.dailyCap,
      approvalThreshold: p.approvalThreshold,
      payoutTtlSeconds: PAYOUT_TTL_SECONDS,
      expiresAt: BigInt(p.expiresAt),
    },
    maxFeeBps: p.feeCapBps ?? 0,
  });
}

/** A fresh salt, so the same principal can create any number of mandates. */
export function newSalt(): Hex32 {
  return randomBytes(32).toString('hex');
}

export function createArgs(p: MandateRules, ctx: CreateContext): xdr.ScVal[] {
  return [mandateConfig(p, ctx), bytes32(ctx.salt ?? newSalt())];
}
