// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// What a wallet may ask the console to build, checked strictly, and how each
// action is described to the person before they sign. The server never holds
// the owner's key: it only shapes the call, the network simulates it, and the
// wallet decides whether to sign. The transactions themselves are built in
// src/chain.

import { z } from 'zod';

import { isAccountAddress } from '../chain/stellar/addresses.js';
import { MAX_ALLOW_ENTRIES, type CreateContext } from '../chain/stellar/txbuild.js';
import { accountAddress, contractAddress, hex32 } from '../ids.js';
import { formatUnits, minorUnits } from '../money.js';
import { ApiError } from './errors.js';

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
  .refine((s) => !isAccountAddress(s), 'a label cannot be a Stellar address');

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
