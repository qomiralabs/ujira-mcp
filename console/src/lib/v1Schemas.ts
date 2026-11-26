// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// What the console expects back from /v1, checked at the edge. Objects are
// loose because /v1 only grows: a field the server adds later passes
// through, and a status or role the console has no word for still parses.
// Amounts arrive as strings of integer minor units and leave this file as
// bigint, so nothing past here ever holds an amount in a JavaScript number.

import * as z from 'zod/mini';

const id = z.string().check(z.minLength(1), z.maxLength(128));
const text = z.string();
const timestamp = z.string().check(z.minLength(1));
const nullableText = z.nullable(z.string());
const count = z.int().check(z.nonnegative());

// i128 has at most 39 digits; the bound keeps BigInt off hostile input.
export const MINOR_UNITS = /^(0|[1-9][0-9]{0,38})$/;

/** A token amount as the server sends it: `{ amount: "25000000", asset, network, scale }`. */
export const tokenAmountWireSchema = z.looseObject({
  amount: z.string().check(z.regex(MINOR_UNITS, 'an integer count of minor units')),
  asset: z.string().check(z.minLength(1), z.maxLength(12)),
  network: z.string().check(z.minLength(1)),
  scale: z.int().check(z.minimum(0), z.maximum(18)),
});
export type TokenAmountWire = z.output<typeof tokenAmountWireSchema>;

export interface TokenAmount {
  readonly amount: bigint;
  readonly asset: string;
  readonly network: string;
  readonly scale: number;
}

export const tokenAmountSchema = z.pipe(
  tokenAmountWireSchema,
  z.transform((wire): TokenAmount => ({
    amount: BigInt(wire.amount),
    asset: wire.asset,
    network: wire.network,
    scale: wire.scale,
  })),
);

/** One page of a list route. Pass `nextCursor` back for the next page; null on the last. */
export function pageSchema<T extends z.ZodMiniType>(item: T) {
  return z.looseObject({ items: z.array(item), nextCursor: z.nullable(z.string()) });
}

export interface Page<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
}

/** What the wallet is asked to sign, built by the server. */
export const signingRequestSchema = z.looseObject({
  id,
  network: text,
  xdr: z.string().check(z.minLength(1)),
  signer: text,
  action: text,
  summary: text,
  expiresAt: timestamp,
});
export type SigningRequest = z.output<typeof signingRequestSchema>;
export const signingRequestEnvelope = z.looseObject({ signingRequest: signingRequestSchema });

export const submittedSchema = z.looseObject({
  txHash: z.string().check(z.minLength(1)),
  // Set when the signed transaction created a mandate.
  mandateId: z.optional(z.nullable(id)),
});
export type Submitted = z.output<typeof submittedSchema>;

export const mandateSchema = z.looseObject({
  id,
  contractId: text,
  network: text,
  asset: text,
  status: text,
  depositAddress: text,
  createdAt: timestamp,
  config: z.looseObject({
    principal: text,
    agents: z.array(text),
    approvers: z.array(text),
    approvalsRequired: count,
    executors: z.array(text),
    limits: z.looseObject({
      totalBudget: tokenAmountSchema,
      perPaymentCap: tokenAmountSchema,
      perRecipientDailyCap: tokenAmountSchema,
      approvalThreshold: tokenAmountSchema,
      payoutTtlSeconds: count,
      expiresAt: timestamp,
    }),
  }),
  state: z.looseObject({
    balance: tokenAmountSchema,
    committed: tokenAmountSchema,
    spent: tokenAmountSchema,
    pending: tokenAmountSchema,
    free: tokenAmountSchema,
    paused: z.boolean(),
    revoked: z.boolean(),
    expired: z.boolean(),
  }),
});
export type V1Mandate = z.output<typeof mandateSchema>;
export const mandatePageSchema = pageSchema(mandateSchema);
export const mandateEnvelope = z.looseObject({ mandate: mandateSchema });

export const recipientSchema = z.looseObject({
  id,
  label: text,
  // Null until the recipient adds a wallet; masked by the server.
  address: nullableText,
  status: text,
  createdAt: timestamp,
});
export type V1Recipient = z.output<typeof recipientSchema>;
export const recipientPageSchema = pageSchema(recipientSchema);
export const recipientEnvelope = z.looseObject({ recipient: recipientSchema });
export const createdRecipientSchema = z.looseObject({
  recipient: recipientSchema,
  // The allow_recipients request for the mandate; null when there is no address yet.
  signingRequest: z.nullable(signingRequestSchema),
});

export const payoutLegSchema = z.looseObject({
  index: count,
  method: text,
  destination: text,
  amount: tokenAmountSchema,
  status: text,
  txHash: nullableText,
});
export type PayoutLeg = z.output<typeof payoutLegSchema>;

export const payoutSchema = z.looseObject({
  id,
  principalId: id,
  projectId: id,
  mandate: z.looseObject({ id, contractId: text }),
  recipient: z.looseObject({ id, label: text }),
  taskId: text,
  amount: tokenAmountSchema,
  fee: tokenAmountSchema,
  status: text,
  blockedBy: nullableText,
  legs: z.array(payoutLegSchema).check(z.minLength(1)),
  onChainPayoutId: nullableText,
  requestTxHash: nullableText,
  receiptId: z.nullable(id),
  createdAt: timestamp,
  updatedAt: timestamp,
  settledAt: z.nullable(timestamp),
});
export type PayoutDetail = z.output<typeof payoutSchema>;
export const payoutPageSchema = pageSchema(payoutSchema);
export const payoutEnvelope = z.looseObject({ payout: payoutSchema });

export const receiptSchema = z.looseObject({
  id,
  payoutId: id,
  mandate: z.looseObject({ id, contractId: text }),
  recipient: z.looseObject({ id, label: text }),
  taskId: text,
  amount: tokenAmountSchema,
  fee: tokenAmountSchema,
  outcome: text,
  blockedBy: nullableText,
  txHash: nullableText,
  ref: nullableText,
  issuedAt: timestamp,
});
export type V1Receipt = z.output<typeof receiptSchema>;
export const receiptPageSchema = pageSchema(receiptSchema);
export const receiptEnvelope = z.looseObject({ receipt: receiptSchema });

export const receiptVerificationSchema = z.looseObject({
  matched: z.boolean(),
  // The first field that differs from the chain; null when it matched.
  field: nullableText,
  txHash: nullableText,
});
export type ReceiptVerification = z.output<typeof receiptVerificationSchema>;

export const apiKeySchema = z.looseObject({
  id,
  name: text,
  // The first characters of the key, so a person can tell keys apart.
  prefix: text,
  scopes: z.array(text),
  createdAt: timestamp,
  lastUsedAt: z.nullable(timestamp),
  revokedAt: z.nullable(timestamp),
});
export type ApiKey = z.output<typeof apiKeySchema>;
export const apiKeyPageSchema = pageSchema(apiKeySchema);
export const createdApiKeySchema = z.looseObject({
  apiKey: apiKeySchema,
  secret: z.string().check(z.minLength(1)),
});

export const overviewSchema = z.looseObject({
  period: z.looseObject({ from: timestamp, to: timestamp }),
  paid: z.array(tokenAmountSchema),
  byStatus: z.record(z.string(), count),
  approvalsWaiting: count,
});
export type Overview = z.output<typeof overviewSchema>;
