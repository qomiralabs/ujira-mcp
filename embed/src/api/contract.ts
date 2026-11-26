// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// What the widget reads from UJIRA, checked before anything uses it. Built
// with the small validator build so the widget stays inside its budget.
//
// Objects are read leniently: a field the API adds later is dropped rather
// than refused, so a widget already on someone's page keeps working. The
// list of methods is read as plain names for the same reason: a method this
// widget does not offer is ignored, not an error.

import * as z from 'zod/mini';

/** The API's name for the one method this widget offers. */
export const WALLET_METHOD = 'stellar_wallet';

const Text = z.string().check(z.minLength(1), z.maxLength(4_096));

/** What the widget needs to know before the first question. */
export const OnboardingSession = z.object({
  recipientId: Text,
  /** The network a wallet destination is on, such as stellar:testnet. */
  network: Text,
  /** The methods this recipient may be paid by. */
  methods: z.array(z.string().check(z.maxLength(64))).check(z.maxLength(10)),
  /** Addresses a payout would burn, such as the USDC issuer. Public data. */
  neverPayable: z.array(Text).check(z.maxLength(100)),
});
export type OnboardingSession = z.infer<typeof OnboardingSession>;

export const SavedMethod = z.object({
  id: Text,
  method: z.literal(WALLET_METHOD),
  status: z.enum(['active', 'disabled']),
});
export type SavedMethod = z.infer<typeof SavedMethod>;

export const WalletChallenge = z.object({
  challengeId: Text,
  /** The exact text for the wallet to sign. */
  message: Text,
  nonce: Text,
  expiresAt: Text,
});
export type WalletChallenge = z.infer<typeof WalletChallenge>;

export const WalletProofAccepted = z.object({
  verificationId: Text,
  level: z.literal('wallet_signature'),
});
export type WalletProofAccepted = z.infer<typeof WalletProofAccepted>;

/**
 * The error envelope every UJIRA route answers with. `code` is what the
 * widget branches on; `reason` narrows a few codes, such as why a wallet
 * cannot receive yet.
 */
export const ErrorEnvelope = z.object({
  error: z.object({
    code: z.string().check(z.maxLength(64)),
    message: z.optional(z.string().check(z.maxLength(1_000))),
    reason: z.optional(z.string().check(z.maxLength(64))),
    requestId: z.optional(z.string().check(z.maxLength(128))),
  }),
});

/** A refusal as the widget reads it: the HTTP status and the envelope's fields. */
export const Problem = z.object({
  status: z.number(),
  code: z.string().check(z.maxLength(64)),
  reason: z.optional(z.string().check(z.maxLength(64))),
  requestId: z.optional(z.string().check(z.maxLength(128))),
});
export type Problem = z.infer<typeof Problem>;

/** The reason sent with DESTINATION_INVALID for an address that needs a text or hash memo. */
export const MEMO_UNSUPPORTED = 'MEMO_UNSUPPORTED';

/** Why a wallet cannot receive yet, sent as the reason of DESTINATION_NOT_RECEIVABLE. */
export const RECEIVABILITY_REASONS = [
  'ACCOUNT_NOT_FOUND',
  'DESTINATION_IS_ISSUER',
  'NO_TRUSTLINE',
  'TRUSTLINE_NOT_AUTHORIZED',
  'TRUSTLINE_LIMIT',
] as const;
export type ReceivabilityReason = (typeof RECEIVABILITY_REASONS)[number];

export function isReceivabilityReason(text: string | undefined): text is ReceivabilityReason {
  return (RECEIVABILITY_REASONS as readonly (string | undefined)[]).includes(text);
}
