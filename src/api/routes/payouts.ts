// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// POST /v1/payouts and POST /v1/payouts/quote.
//
// A platform creates payouts with an API key holding payouts:write; the
// dashboard does the same with a session. Creation takes an Idempotency-Key,
// and the tenant the credential resolves to is the only one anything here
// reads or writes, so another project's mandate reads as not found.
//
// A payout the mandate refuses is not an error: it is answered 202 like any
// other, with status blocked and the spec error in blockedBy.

import { z } from 'zod';

import { DatabaseUnavailableError, PayoutConflictError } from '../../db/index.js';
import type { Payout, PayoutLeg } from '../../db/index.js';
import { taskId } from '../../ids.js';
import type { TokenAmount } from '../../money/index.js';
import { PayoutServiceError, type PayoutService } from '../../payouts/payout-service.js';
import { maskAddress } from '../../payouts/recipients.js';
import type { Authenticate } from '../authenticate.js';
import { ApiError } from '../errors.js';
import type { IdempotencyStore } from '../idempotency.js';
import { defineIdempotentRoute, defineRoute, type Route } from '../route.js';

export interface PayoutRouteOptions {
  readonly service: PayoutService;
  readonly authenticate: Authenticate;
  readonly idempotency: {
    readonly store: IdempotencyStore;
    readonly log: (line: string) => void;
  };
}

const MAX_METADATA_KEYS = 16;
const MAX_METADATA_LENGTH = 256;

// i128 has at most 39 digits. Zero is no payout, so it is refused here.
const minorUnits = z.string().regex(/^[1-9][0-9]{0,38}$/);

export const tokenAmountWireSchema = z
  .object({
    amount: minorUnits,
    asset: z.string().min(1).max(12),
    network: z.string().min(1).max(64),
    scale: z.int().min(0).max(18),
  })
  .strict();

const lowerUuid = z.uuid().transform((value) => value.toLowerCase());

// JSON.parse keeps a __proto__ key as an own property, but a record schema
// builds its output by assignment and would drop it without a word, so it is
// refused on the raw object first. Nothing downstream then has to wonder.
const metadataSchema = z
  .unknown()
  .refine((raw) => typeof raw !== 'object' || raw === null || !Object.hasOwn(raw, '__proto__'), {
    message: 'reserved key',
  })
  .pipe(
    z
      .record(z.string().min(1).max(MAX_METADATA_LENGTH), z.string().max(MAX_METADATA_LENGTH))
      .refine((value) => Object.keys(value).length <= MAX_METADATA_KEYS, {
        message: `at most ${String(MAX_METADATA_KEYS)} keys`,
      }),
  );

export const createPayoutBody = z
  .object({
    mandateId: lowerUuid,
    recipientId: lowerUuid,
    amount: tokenAmountWireSchema,
    taskId,
    metadata: metadataSchema.optional(),
  })
  .strict();

export const quotePayoutBody = z
  .object({
    mandateId: lowerUuid,
    recipientId: lowerUuid,
    amount: tokenAmountWireSchema,
    taskId: taskId.optional(),
  })
  .strict();

export const amountOut = z
  .object({
    amount: z.string(),
    asset: z.string(),
    network: z.string(),
    scale: z.int(),
  })
  .strict();

const legSchema = z
  .object({
    index: z.int(),
    // The rail id, such as stellar.wallet.
    method: z.string(),
    // Masked.
    destination: z.string(),
    amount: amountOut,
    status: z.string(),
    txHash: z.string().nullable(),
  })
  .strict();

export const payoutDetailSchema = z
  .object({
    id: z.uuid(),
    principalId: z.uuid(),
    projectId: z.uuid(),
    mandate: z.object({ id: z.uuid(), contractId: z.string() }).strict(),
    recipient: z.object({ id: z.uuid(), label: z.string() }).strict(),
    taskId: z.string(),
    amount: amountOut,
    fee: amountOut,
    status: z.string(),
    blockedBy: z.string().nullable(),
    legs: z.array(legSchema).min(1),
    onChainPayoutId: z.string().nullable(),
    requestTxHash: z.string().nullable(),
    receiptId: z.uuid().nullable(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    settledAt: z.iso.datetime().nullable(),
  })
  .strict();

const quoteSchema = z
  .object({
    decision: z.enum(['allowed', 'approval_required', 'blocked']),
    blockedBy: z.string().nullable(),
    amount: amountOut,
  })
  .strict();

// The rail ids the API names methods by; the database keeps its own names.
const RAIL_OF_METHOD: Readonly<Record<PayoutLeg['method'], string>> = {
  stellar_wallet: 'stellar.wallet',
};

export function amountWire(amount: TokenAmount, network: string): z.input<typeof amountOut> {
  return {
    amount: amount.amount.toString(),
    asset: amount.asset,
    network,
    scale: amount.scale,
  };
}

/**
 * What a payout's wire form is drawn from. A created payout and a payout read
 * back for a list both carry it, so the two answers cannot drift apart.
 */
export interface PayoutWireSource {
  readonly principalId: string;
  readonly payout: Payout;
  readonly legs: readonly PayoutLeg[];
  readonly mandate: { readonly id: string; readonly contractAddress: string };
  readonly recipient: { readonly id: string; readonly label: string };
}

export function payoutWire(
  record: PayoutWireSource,
  receiptId: string | null = null,
): z.input<typeof payoutDetailSchema> {
  const { payout, legs, mandate, recipient } = record;
  return {
    id: payout.id,
    principalId: record.principalId,
    projectId: payout.projectId,
    mandate: { id: mandate.id, contractId: mandate.contractAddress },
    recipient: { id: recipient.id, label: recipient.label },
    taskId: payout.taskId,
    amount: amountWire(payout.amount, payout.network),
    fee: amountWire(payout.fee, payout.network),
    status: payout.status,
    blockedBy: payout.blockedBy,
    legs: legs.map((leg) => ({
      index: leg.index,
      method: RAIL_OF_METHOD[leg.method],
      destination: maskAddress(leg.destination),
      amount: amountWire(leg.amount, payout.network),
      status: leg.status,
      txHash: leg.txHash,
    })),
    onChainPayoutId: payout.onchainPayoutId,
    requestTxHash: payout.requestTxHash,
    receiptId,
    createdAt: payout.createdAt.toISOString(),
    updatedAt: payout.updatedAt.toISOString(),
    settledAt: payout.settledAt === null ? null : payout.settledAt.toISOString(),
  };
}

// Refusals as the one error envelope. Messages are fixed here, so nothing the
// caller sent or the chain said is echoed back.
export function payoutApiError(error: unknown): unknown {
  if (error instanceof DatabaseUnavailableError) {
    return new ApiError('DB_UNAVAILABLE', 'The database is unavailable; try again shortly', {
      headers: { 'retry-after': '5' },
      cause: error,
    });
  }
  if (error instanceof PayoutConflictError) {
    switch (error.code) {
      case 'IDEMPOTENCY_KEY_REUSED':
        return new ApiError(
          'IDEMPOTENCY_KEY_REUSED',
          'This Idempotency-Key was already used for a different payout',
          { cause: error },
        );
      // The on chain id is derived from the mandate and the task, so a clash
      // there is the same task again.
      case 'TASK_ID_REUSED':
      case 'ONCHAIN_PAYOUT_ID_REUSED':
        return new ApiError(
          'TASK_ID_REUSED',
          'This task already has a payout on this mandate, under another key',
          { details: [{ path: 'body.taskId', issue: 'reused' }], cause: error },
        );
    }
  }
  if (!(error instanceof PayoutServiceError)) return error;
  switch (error.code) {
    case 'MANDATE_NOT_FOUND':
      return new ApiError('NOT_FOUND', 'No such mandate', { cause: error });
    case 'RECIPIENT_NOT_FOUND':
      return new ApiError('NOT_FOUND', 'No such recipient on this mandate', { cause: error });
    case 'AMOUNT_MISMATCH':
      return new ApiError('INVALID_REQUEST', "The amount is not in the mandate's unit", {
        details: [
          {
            path: `body.amount.${error.field ?? 'amount'}`,
            issue: error.field === 'amount' ? 'too_big' : 'mismatch',
          },
        ],
        cause: error,
      });
    case 'RECIPIENT_HAS_NO_METHOD':
      return new ApiError('INVALID_REQUEST', 'The recipient has no wallet to pay yet', {
        details: [{ path: 'body.recipientId', issue: 'recipient_has_no_method' }],
        cause: error,
      });
    case 'MANDATE_NOT_SERVED':
      return new ApiError(
        'MANDATE_REFUSED',
        'The mandate is on a network this server does not serve',
        {
          details: [{ path: 'mandate', issue: 'network_not_served' }],
          cause: error,
        },
      );
    case 'CHAIN_UNAVAILABLE':
      return new ApiError('CHAIN_UNAVAILABLE', 'The chain did not answer in time; try again', {
        cause: error,
      });
  }
}

async function answering<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw payoutApiError(error);
  }
}

const AUTH_ERRORS = [
  'TOKEN_MALFORMED',
  'TOKEN_INVALID',
  'TOKEN_ENVIRONMENT_MISMATCH',
  'SESSION_INVALID',
  'FORBIDDEN',
  'ORIGIN_NOT_ALLOWED',
] as const;

export function payoutRoutes(o: PayoutRouteOptions): Route[] {
  const create = defineIdempotentRoute({
    method: 'post',
    path: '/v1/payouts',
    operationId: 'createPayout',
    summary: 'Create a payout',
    description:
      'Quotes the payout against the mandate, then writes it with its leg and its first job in one transaction. A payout the mandate refuses is written as blocked with the spec error in blockedBy, and gets a receipt later. The same Idempotency-Key and body answer the first payout again; the same task on the mandate under another key is TASK_ID_REUSED.',
    tags: ['payouts'],
    body: createPayoutBody,
    status: 202,
    response: z.object({ payout: payoutDetailSchema }).strict(),
    responseDescription: 'The payout, accepted',
    errors: [...AUTH_ERRORS, 'NOT_FOUND', 'TASK_ID_REUSED', 'MANDATE_REFUSED', 'DB_UNAVAILABLE'],
    idempotency: {
      store: o.idempotency.store,
      log: o.idempotency.log,
      authenticate: o.authenticate({ scope: 'payouts:write' }),
    },
    handler: async ({ body, idempotent }, c) => {
      const record = await answering(() =>
        o.service.create(
          idempotent.caller,
          {
            mandateId: body.mandateId,
            recipientId: body.recipientId,
            amount: body.amount,
            taskId: body.taskId,
            metadata: body.metadata,
            idempotencyKey: idempotent.key,
          },
          c.get('requestId'),
        ),
      );
      return { payout: payoutWire(record) };
    },
  });

  const authenticateQuote = o.authenticate({ scope: 'payouts:read' });
  const quote = defineRoute({
    method: 'post',
    path: '/v1/payouts/quote',
    operationId: 'quotePayout',
    summary: 'Quote a payout',
    description:
      'What the mandate would do with this payout now: allowed, approval_required, or blocked with the spec error. Nothing is written.',
    tags: ['payouts'],
    body: quotePayoutBody,
    response: z.object({ quote: quoteSchema }).strict(),
    errors: [...AUTH_ERRORS, 'NOT_FOUND', 'MANDATE_REFUSED', 'CHAIN_UNAVAILABLE', 'DB_UNAVAILABLE'],
    handler: async ({ body }, c) => {
      const caller = await authenticateQuote(c);
      const answer = await answering(() => o.service.quote(caller, body, c.get('requestId')));
      return {
        quote: {
          decision: answer.decision,
          blockedBy: answer.blockedBy,
          amount: amountWire(answer.amount, answer.network),
        },
      };
    },
  });

  return [quote, create];
}
