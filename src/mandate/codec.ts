// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// Encodes arguments for the mandate and decodes what it answers. A
// #[contracttype] struct crosses the boundary as a map keyed by its field
// names in sorted order, so the field names here are part of the interface.
// Every answer is checked with a schema before anything trusts it.

import { Address, nativeToScVal, scValToNative, xdr } from '@stellar/stellar-sdk';
import { z } from 'zod';

import { EngineError } from '../errors.js';
import type { Hex32 } from '../ids.js';
import type {
  Leg,
  MandateConfigView,
  MandateStateView,
  PayoutEntry,
  PayoutRequest,
} from './types.js';

export function struct(fields: Readonly<Record<string, xdr.ScVal>>): xdr.ScVal {
  const keys = Object.keys(fields).sort();
  return xdr.ScVal.scvMap(
    keys.map(
      (key) =>
        new xdr.ScMapEntry({
          key: xdr.ScVal.scvSymbol(key),
          val: fields[key] ?? xdr.ScVal.scvVoid(),
        }),
    ),
  );
}

export const i128 = (value: bigint) => nativeToScVal(value, { type: 'i128' });
export const u64 = (value: bigint) => nativeToScVal(value, { type: 'u64' });
export const bytes32 = (hex: Hex32) => xdr.ScVal.scvBytes(Buffer.from(hex, 'hex'));
export const address = (value: string) => Address.fromString(value).toScVal();

function leg(value: Leg): xdr.ScVal {
  return struct({ amount: i128(value.amount), destination: address(value.destination) });
}

export function encodePayoutRequest(req: PayoutRequest): xdr.ScVal {
  return struct({
    attestations: xdr.ScVal.scvVec([]),
    deadline: u64(req.deadline),
    fee: i128(req.fee),
    legs: xdr.ScVal.scvVec(req.legs.map(leg)),
    payout_id: bytes32(req.payoutId),
    recipient_ref: bytes32(req.recipientRef),
    task_ref: bytes32(req.taskRef),
    total: i128(req.total),
  });
}

export function encodeAllowEntries(
  entries: readonly { recipientRef: Hex32; destination: string }[],
): xdr.ScVal {
  return xdr.ScVal.scvVec(
    entries.map((e) =>
      struct({ destination: address(e.destination), recipient_ref: bytes32(e.recipientRef) }),
    ),
  );
}

const hex = z.instanceof(Uint8Array).transform((b) => Buffer.from(b).toString('hex'));
const u32 = z.number().int().nonnegative();

const limitsSchema = z.object({
  total_budget: z.bigint(),
  per_payment_cap: z.bigint(),
  per_recipient_daily_cap: z.bigint(),
  approval_threshold: z.bigint(),
  payout_ttl_seconds: z.bigint(),
  expires_at: z.bigint(),
});

const configSchema = z.object({
  principal: z.string(),
  asset: z.string(),
  recipient_mode: u32,
  agents: z.array(z.string()),
  approvers: z.array(z.string()),
  approvals_required: u32,
  executors: z.array(z.string()),
  limits: limitsSchema,
  max_fee_bps: u32,
  fee_address: z.string(),
});

const stateSchema = z.object({
  spent: z.bigint(),
  pending: z.bigint(),
  committed: z.bigint(),
  balance: z.bigint(),
  free: z.bigint(),
  paused: z.boolean(),
  revoked: z.boolean(),
  expired: z.boolean(),
});

const legSchema = z.object({ destination: z.string(), amount: z.bigint() });

const recordSchema = z.object({
  payout_id: hex,
  agent: z.string(),
  recipient_ref: hex,
  total: z.bigint(),
  fee: z.bigint(),
  legs: z.array(legSchema),
  status: u32,
  created_at: z.bigint(),
  expires_at: z.bigint(),
  approvals: z.array(z.object({ approver: z.string() })),
});

const tombstoneSchema = z.object({ payout_id: hex, status: u32 });

const entrySchema = z.union([
  z.tuple([z.literal('Record'), recordSchema]),
  z.tuple([z.literal('Tombstone'), tombstoneSchema]),
]);

function parse<T>(schema: z.ZodType<T>, value: xdr.ScVal, what: string): T {
  const result = schema.safeParse(scValToNative(value));
  if (!result.success) {
    throw new EngineError('rpc_unavailable', `the mandate's ${what} has an unexpected shape`);
  }
  return result.data;
}

export function decodeConfig(value: xdr.ScVal): MandateConfigView {
  const c = parse(configSchema, value, 'config');
  return {
    principal: c.principal,
    asset: c.asset,
    recipientMode: c.recipient_mode,
    agents: c.agents,
    approvers: c.approvers,
    approvalsRequired: c.approvals_required,
    executors: c.executors,
    maxFeeBps: c.max_fee_bps,
    feeAddress: c.fee_address,
    limits: {
      totalBudget: c.limits.total_budget,
      perPaymentCap: c.limits.per_payment_cap,
      perRecipientDailyCap: c.limits.per_recipient_daily_cap,
      approvalThreshold: c.limits.approval_threshold,
      payoutTtlSeconds: c.limits.payout_ttl_seconds,
      expiresAt: c.limits.expires_at,
    },
  };
}

export function decodeState(value: xdr.ScVal): MandateStateView {
  return parse(stateSchema, value, 'state');
}

export function decodeDailyUsed(value: xdr.ScVal): bigint {
  return parse(z.object({ day: z.bigint(), used: z.bigint() }), value, 'daily usage').used;
}

export function decodeBool(value: xdr.ScVal, what: string): boolean {
  return parse(z.boolean(), value, what);
}

export function decodeU32(value: xdr.ScVal, what: string): number {
  return parse(u32, value, what);
}

export function decodePayoutEntry(value: xdr.ScVal): PayoutEntry | null {
  if (value.type === 'scvVoid') return null;
  const entry = parse(entrySchema, value, 'payout record');
  if (entry[0] === 'Tombstone') {
    return { kind: 'tombstone', payoutId: entry[1].payout_id, status: entry[1].status };
  }
  const r = entry[1];
  return {
    kind: 'record',
    payoutId: r.payout_id,
    agent: r.agent,
    recipientRef: r.recipient_ref,
    total: r.total,
    fee: r.fee,
    legs: r.legs,
    status: r.status,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    approvals: r.approvals.map((a) => a.approver),
  };
}
