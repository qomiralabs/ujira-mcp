// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// What the console expects back from the server, checked at the edge so a
// surprise in a response becomes one clear error instead of a broken screen.
// Objects are loose: a field the server adds later passes through untouched.

import * as z from 'zod/mini';

const minor = z.string().check(z.regex(/^-?\d+$/, 'expected minor units'));
const optionalString = z.optional(z.nullable(z.string()));

export const configSchema = z.looseObject({
  network: z.string(),
  networkPassphrase: z.string(),
  explorerTxBase: z.string(),
  factory: z.optional(z.string()),
  asset: z.looseObject({
    code: z.string(),
    issuer: z.string(),
    contract: z.optional(z.string()),
    decimals: z.number(),
  }),
  agent: z.optional(z.string()),
  executor: z.optional(z.string()),
  sdpAvailable: z.boolean(),
  sdpProofUrl: z.optional(z.string()),
  faucet: z.optional(z.looseObject({ amount: minor, enabled: z.boolean() })),
});
export type Config = z.infer<typeof configSchema>;

export const accountSchema = z.looseObject({
  address: z.string(),
  exists: z.boolean(),
  xlm: z.nullable(z.string()),
  usdc: z.nullable(minor),
});
export type Account = z.infer<typeof accountSchema>;

export const okSchema = z.looseObject({ ok: z.optional(z.boolean()) });

export const unsignedTxSchema = z.looseObject({
  xdr: z.string().check(z.minLength(1)),
  description: z.optional(z.string()),
});
export type UnsignedTx = z.infer<typeof unsignedTxSchema>;

export const faucetSchema = z.looseObject({ hash: z.string(), amount: minor });
export const testRecipientSchema = z.looseObject({ address: z.string(), hash: optionalString });

export const submitSchema = z.looseObject({
  hash: z.string(),
  status: z.string(),
  returnValue: optionalString,
  mandate: optionalString,
});
export type SubmitResult = z.infer<typeof submitSchema>;

export const mandateListSchema = z.looseObject({
  mandates: z.array(
    z.looseObject({
      id: z.string(),
      createdAt: optionalString,
      createTx: optionalString,
    }),
  ),
});
export type MandateSummary = z.infer<typeof mandateListSchema>['mandates'][number];

export const mandateSchema = z.looseObject({
  id: z.string(),
  principal: z.string(),
  approver: optionalString,
  agent: optionalString,
  executor: optionalString,
  rules: z.looseObject({
    budget: minor,
    perPaymentCap: minor,
    dailyCap: minor,
    approvalThreshold: minor,
    expiresAt: z.union([z.number(), z.string()]),
    feeCapBps: z.optional(z.nullable(z.union([z.number(), z.string()]))),
  }),
  state: z.looseObject({
    balance: minor,
    spent: minor,
    remaining: minor,
    paused: z.boolean(),
    revoked: z.boolean(),
    expired: z.boolean(),
  }),
  recipients: z.array(
    z.looseObject({ label: z.string(), address: z.string(), recipientRef: optionalString }),
  ),
  mcpUrl: z.string(),
  sdpAvailable: z.optional(z.boolean()),
  explorerContractUrl: optionalString,
});
export type Mandate = z.infer<typeof mandateSchema>;

export const payoutSchema = z.looseObject({
  taskId: z.string(),
  payoutId: optionalString,
  recipient: z.string(),
  recipientLabel: optionalString,
  amount: minor,
  rail: z.string(),
  status: z.string(),
  reason: optionalString,
  requestTx: optionalString,
  paidTx: optionalString,
  at: optionalString,
});
export const payoutListSchema = z.looseObject({ payouts: z.array(payoutSchema) });
export type Payout = z.infer<typeof payoutSchema>;

export const quoteSchema = z.looseObject({
  decision: z.string(),
  reason: optionalString,
  amount: minor,
  asset: z.optional(z.string()),
  rail: z.optional(z.string()),
  destination: optionalString,
  headroom: z.optional(z.record(z.string(), z.string())),
});
export type QuoteResult = z.infer<typeof quoteSchema>;

export const receiptSchema = z.looseObject({
  task_id: z.string(),
  recipient: z.string(),
  destination: optionalString,
  amount: minor,
  asset: z.optional(z.string()),
  rail: z.optional(z.string()),
  outcome: z.string(),
  reason: optionalString,
  payout_id: optionalString,
  tx_hash: optionalString,
  request_tx_hash: optionalString,
  sdp_disbursement_id: optionalString,
  sdp_tx_hash: optionalString,
  created_at: optionalString,
  updated_at: optionalString,
});
export type Receipt = z.infer<typeof receiptSchema>;
export const receiptListSchema = z.looseObject({ receipts: z.array(receiptSchema) });

export const errorBodySchema = z.looseObject({
  error: z.looseObject({ code: z.string(), message: z.string() }),
});
