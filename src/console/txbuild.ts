// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// Builds the unsigned transactions a wallet signs in the console. The server
// never holds the owner's key: it only shapes the call, the network
// simulates it, and the wallet decides whether to sign.
//
// Every action is one contract call (or one changeTrust), with the wallet as
// the transaction source, so the wallet's signature on the envelope is the
// only authorization any of them needs.

import { createHash, randomBytes } from 'node:crypto';

import {
  Asset,
  Contract,
  Operation,
  StrKey,
  TransactionBuilder,
  xdr,
  type Account,
  type Transaction,
} from '@stellar/stellar-sdk';
import { z } from 'zod';

import { accountAddress, contractAddress, hex32, type Hex32 } from '../ids.js';
import { address, bytes32, i128, struct, u64 } from '../mandate/codec.js';
import { formatUnits, minorUnits } from '../money.js';
import { TESTNET_PASSPHRASE } from '../stellar/gateway.js';
import { ApiError } from './errors.js';

/** Above the base fee so a busy testnet still takes it; the wallet pays it. */
export const INCLUSION_FEE = '10000';
/** How long the wallet has to sign before the network refuses the transaction. */
export const SIGN_WINDOW_SECONDS = 300;
/** How long an approved payout stays executable, as the demo mandate uses. */
export const PAYOUT_TTL_SECONDS = 86_400n;
/** The contract takes at most this many allowlist entries in one call. */
export const MAX_ALLOW_ENTRIES = 10;

export const BUILD_ACTIONS = [
  'create_mandate',
  'allow_recipients',
  'fund_mandate',
  'pause',
  'resume',
  'revoke',
  'sweep',
  'approve',
  'reject',
  'withdraw',
] as const;
export type BuildAction = (typeof BUILD_ACTIONS)[number];

/** Zero or more minor units; an approval threshold of 0 sends every payout to a person. */
const nonNegativeUnits = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,37})$/, 'a whole number of minor units, as a string')
  .transform((s) => BigInt(s));

const unixSeconds = z
  .union([
    z.number(),
    z
      .string()
      .regex(/^\d{1,12}$/)
      .transform(Number),
  ])
  .pipe(z.number().int().positive());

/**
 * A name for a recipient. Never a Stellar address, so a name and an address
 * can never mean two different wallets.
 */
export const recipientLabel = z
  .string()
  .min(1)
  .max(40)
  .regex(/^[A-Za-z0-9][A-Za-z0-9 ._@#-]*$/, 'letters, digits, spaces and . _ @ # - only')
  .refine((s) => !StrKey.isValidEd25519PublicKey(s), 'a label cannot be a Stellar address');

const mandateOnly = z.object({ mandate: contractAddress }).strict();

const createParams = z
  .object({
    budget: minorUnits,
    perPaymentCap: minorUnits,
    dailyCap: minorUnits,
    approvalThreshold: nonNegativeUnits,
    expiresAt: unixSeconds,
    feeCapBps: z.number().int().min(0).max(100).optional(),
  })
  .strict();

const recipientsParams = z
  .object({
    mandate: contractAddress,
    recipients: z
      .array(z.object({ label: recipientLabel, address: accountAddress }).strict())
      .min(1)
      .max(MAX_ALLOW_ENTRIES),
  })
  .strict();

const amountParams = z.object({ mandate: contractAddress, amount: minorUnits }).strict();
const payoutParams = z.object({ mandate: contractAddress, payoutId: hex32 }).strict();

const request = <A extends BuildAction, P extends z.ZodType>(action: A, params: P) =>
  z.object({ action: z.literal(action), source: accountAddress, params }).strict();

const buildRequest = z.discriminatedUnion('action', [
  request('create_mandate', createParams),
  request('allow_recipients', recipientsParams),
  request('fund_mandate', amountParams),
  request('pause', mandateOnly),
  request('resume', mandateOnly),
  request('revoke', mandateOnly),
  request('sweep', mandateOnly),
  request('approve', payoutParams),
  request('reject', payoutParams),
  request('withdraw', amountParams),
]);

export type BuildRequest = z.output<typeof buildRequest>;
export type CreateParams = z.output<typeof createParams>;

/** Field names and what was wrong with them, never the values. */
export function issues(error: z.ZodError): string {
  return error.issues
    .map((i) => {
      const where = i.path.join('.');
      return i.code === 'unrecognized_keys'
        ? `unknown field(s): ${i.keys.join(', ')}`
        : `${where === '' ? 'input' : where}: ${i.message}`;
    })
    .join('; ');
}

export function parseBuildRequest(raw: unknown): BuildRequest {
  const action = (raw as { action?: unknown } | null)?.action;
  if (typeof raw !== 'object' || raw === null || typeof action !== 'string') {
    throw new ApiError(400, 'invalid_request', 'The request needs an action, a source and params');
  }
  if (!(BUILD_ACTIONS as readonly string[]).includes(action)) {
    throw new ApiError(
      400,
      'unknown_action',
      `Unknown action; use one of ${BUILD_ACTIONS.join(', ')}`,
    );
  }
  const parsed = buildRequest.safeParse(raw);
  if (!parsed.success) {
    throw new ApiError(400, 'invalid_request', `The request was refused: ${issues(parsed.error)}`);
  }
  return parsed.data;
}

/** One contract call from `source`, unsigned and not yet simulated. */
export function invokeTx(
  source: Account,
  contract: string,
  method: string,
  args: readonly xdr.ScVal[],
): Transaction {
  return new TransactionBuilder(source, {
    fee: INCLUSION_FEE,
    networkPassphrase: TESTNET_PASSPHRASE,
  })
    .addOperation(new Contract(contract).call(method, ...args))
    .setTimeout(SIGN_WINDOW_SECONDS)
    .build();
}

export function trustlineTx(source: Account, usdc: { code: string; issuer: string }): Transaction {
  return new TransactionBuilder(source, {
    fee: INCLUSION_FEE,
    networkPassphrase: TESTNET_PASSPHRASE,
  })
    .addOperation(Operation.changeTrust({ asset: new Asset(usdc.code, usdc.issuer) }))
    .setTimeout(SIGN_WINDOW_SECONDS)
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

export interface CreateContext {
  readonly principal: string;
  readonly agent: string;
  readonly executor: string;
  readonly asset: string;
  /** Unix seconds, from the server clock. */
  readonly now: number;
  readonly salt?: Hex32;
}

/** The checks the contract would refuse with a bare config_invalid, said in words first. */
export function checkCreateParams(p: CreateParams, ctx: CreateContext): void {
  const refuse = (message: string) => new ApiError(400, 'invalid_rules', message);
  if (p.perPaymentCap > p.budget) {
    throw refuse('The most per payment cannot be more than the total budget');
  }
  if (p.expiresAt < ctx.now + 3_600) {
    throw refuse('The expiry must be at least an hour from now');
  }
  if (p.expiresAt > ctx.now + 366 * 86_400) {
    throw refuse('The expiry must be within a year');
  }
  if (ctx.principal === ctx.agent || ctx.principal === ctx.executor) {
    throw new ApiError(
      400,
      'role_conflict',
      "The owner wallet cannot be the server's agent or executor key",
    );
  }
}

/** The factory's MandateConfig for a console mandate, as an ScVal. */
export function mandateConfig(p: CreateParams, ctx: CreateContext): xdr.ScVal {
  return struct({
    principal: address(ctx.principal),
    asset: address(ctx.asset),
    recipient_mode: u32(1),
    tenant_tag: bytes32(tenantTagFor(ctx.principal)),
    agents: addresses([ctx.agent]),
    // The owner approves their own large payouts; one approval is enough.
    approvers: addresses([ctx.principal]),
    approvals_required: u32(1),
    guardians: addresses([]),
    executors: addresses([ctx.executor]),
    recovery: addresses([]),
    recovery_threshold: u32(0),
    limits: struct({
      total_budget: i128(p.budget),
      per_payment_cap: i128(p.perPaymentCap),
      per_recipient_daily_cap: i128(p.dailyCap),
      approval_threshold: i128(p.approvalThreshold),
      payout_ttl_seconds: u64(PAYOUT_TTL_SECONDS),
      expires_at: u64(BigInt(p.expiresAt)),
    }),
    attester: xdr.ScVal.scvVoid(),
    country_policy_hash: bytes32('0'.repeat(64)),
    max_fee_bps: u32(p.feeCapBps ?? 0),
  });
}

export function createArgs(p: CreateParams, ctx: CreateContext): xdr.ScVal[] {
  const salt = ctx.salt ?? randomBytes(32).toString('hex');
  return [mandateConfig(p, ctx), bytes32(salt)];
}

const usdc = (amount: bigint) => `${formatUnits(amount)} USDC`;

export function describeCreate(p: CreateParams, agent: string): string {
  const expires = new Date(p.expiresAt * 1000).toISOString().slice(0, 10);
  const approval =
    p.approvalThreshold > p.perPaymentCap
      ? 'no payment needs your approval'
      : `payments from ${usdc(p.approvalThreshold)} wait for your approval`;
  return (
    `Create a mandate you own: total budget ${usdc(p.budget)}, at most ${usdc(p.perPaymentCap)} per payment ` +
    `and ${usdc(p.dailyCap)} per recipient per day, ${approval}, valid until ${expires}. ` +
    `The UJIRA agent key ${agent} may request payouts only within these rules.`
  );
}

export function describe(req: BuildRequest): string {
  switch (req.action) {
    case 'create_mandate':
      return 'Create a mandate';
    case 'allow_recipients':
      return `Allow ${req.params.recipients.map((r) => r.label).join(', ')} to be paid from mandate ${req.params.mandate}`;
    case 'fund_mandate':
      return `Send ${usdc(req.params.amount)} from your wallet to mandate ${req.params.mandate}`;
    case 'pause':
      return `Pause mandate ${req.params.mandate}: no payout can be requested or paid until you resume it`;
    case 'resume':
      return `Resume mandate ${req.params.mandate} so payouts within its rules can go out again`;
    case 'revoke':
      return `Revoke mandate ${req.params.mandate} for good. Its balance can then be swept back to you`;
    case 'sweep':
      return `Return the whole balance of mandate ${req.params.mandate} to your wallet`;
    case 'approve':
      return `Approve payout ${req.params.payoutId} on mandate ${req.params.mandate}`;
    case 'reject':
      return `Reject payout ${req.params.payoutId} on mandate ${req.params.mandate}`;
    case 'withdraw':
      return `Withdraw ${usdc(req.params.amount)} from mandate ${req.params.mandate} to your wallet`;
  }
}
