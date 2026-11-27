// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The mandate routes and the signed submit, for a signed in member acting in
// one project. Every write comes from the app origin; the submit, which can
// move money, also takes an Idempotency-Key, so a retry after a dropped
// answer gets the first answer back instead of a second relay.
//
// Messages are fixed strings. A chain failure is answered by its code alone:
// what the RPC said stays in the server, and only the spec error name of a
// contract refusal goes back, as a detail.

import { z } from 'zod';

import { ChainError } from '../../chain/adapter.js';
import {
  MandateServiceError,
  type MandateCaller,
  type MandateService,
} from '../../payouts/mandates.js';
import type { Authenticate } from '../authenticate.js';
import type { V1Context } from '../context.js';
import { decodeCursor, encodeCursor } from '../cursor.js';
import { ApiError, type ApiErrorCode } from '../errors.js';
import type { IdempotencyStore } from '../idempotency.js';
import { defineIdempotentRoute, defineRoute, type Route } from '../route.js';

export interface MandateRouteOptions {
  /** Reads take a session or a key with mandates:read; writes take a session. */
  readonly authenticate: Authenticate;
  readonly service: MandateService;
  readonly idempotency: IdempotencyStore;
  readonly log: (line: string) => void;
}

/** Long enough for an RPC to come back from a blip. */
const CHAIN_RETRY_AFTER_SECONDS = '5';

const PAGE_DEFAULT = 20;
const PAGE_MAX = 50;
const NAME_MAX = 60;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const uuid = z.string().regex(UUID, 'a lower case uuid');
// i128 has at most 39 digits; the bound keeps BigInt off hostile input.
const MINOR = /^(0|[1-9][0-9]{0,38})$/;
const minorUnits = z
  .string()
  .regex(MINOR, 'an integer count of minor units')
  .transform((s) => BigInt(s));
const address = z.string().min(1).max(128);
const name = z
  .string()
  .trim()
  .min(1)
  .max(NAME_MAX)
  // Control characters would make a name that looks like another.
  .regex(/^[^\p{Cc}]*$/u, 'no control characters');

function tokenAmountIn(service: MandateService) {
  const unit = service.unit;
  return z
    .object({
      amount: z.string().regex(MINOR, 'an integer count of minor units'),
      asset: z.string().min(1).max(12),
      network: z.string().min(1).max(64),
      scale: z.number().int().min(0).max(18),
    })
    .strict()
    .refine(
      (t) => t.asset === unit.code && t.network === service.network && t.scale === unit.scale,
      { message: 'unsupported_asset' },
    )
    .transform((t) => BigInt(t.amount));
}

const tokenView = z
  .object({ amount: z.string(), asset: z.string(), network: z.string(), scale: z.number().int() })
  .strict();

const mandateFields = {
  id: z.string(),
  name: z.string(),
  contractId: z.string(),
  network: z.string(),
  asset: z.string(),
  status: z.enum(['active', 'paused', 'revoked', 'expired']),
  depositAddress: z.string(),
  createdAt: z.string(),
  config: z
    .object({
      principal: z.string(),
      agents: z.array(z.string()),
      approvers: z.array(z.string()),
      approvalsRequired: z.number().int(),
      executors: z.array(z.string()),
      recipientMode: z.enum(['allowlist', 'attested', 'both', 'unknown']),
      limits: z
        .object({
          totalBudget: tokenView,
          perPaymentCap: tokenView,
          perRecipientDailyCap: tokenView,
          approvalThreshold: tokenView,
          payoutTtlSeconds: z.number().int(),
          expiresAt: z.string(),
        })
        .strict(),
    })
    .strict(),
  state: z
    .object({
      balance: tokenView,
      committed: tokenView,
      spent: tokenView,
      pending: tokenView,
      free: tokenView,
      paused: z.boolean(),
      revoked: z.boolean(),
      expired: z.boolean(),
    })
    .strict(),
};

const mandateSummary = z.object(mandateFields).strict();
const mandateDetail = z
  .object({
    ...mandateFields,
    recipients: z.array(
      z
        .object({
          id: z.string(),
          label: z.string(),
          address: z.string().nullable(),
          status: z.string(),
        })
        .strict(),
    ),
  })
  .strict();

const signingRequestView = z
  .object({
    id: z.string(),
    network: z.string(),
    xdr: z.string(),
    signer: z.string(),
    action: z.string(),
    summary: z.string(),
    expiresAt: z.string(),
  })
  .strict();
const signingRequestEnvelope = z.object({ signingRequest: signingRequestView }).strict();

const actionBody = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('fund'), amount: minorUnits }).strict(),
  z.object({ kind: z.literal('withdraw'), amount: minorUnits }).strict(),
  z
    .object({
      kind: z.literal('allow_recipients'),
      recipientIds: z.array(uuid).min(1).max(10),
    })
    .strict(),
  z.object({ kind: z.literal('pause') }).strict(),
  z.object({ kind: z.literal('resume') }).strict(),
  z.object({ kind: z.literal('revoke') }).strict(),
  // The /v1 payout id; the server knows which on chain id it is.
  z.object({ kind: z.literal('approve'), payoutId: uuid }).strict(),
  z.object({ kind: z.literal('reject'), payoutId: uuid }).strict(),
]);

const submitBody = z
  .object({
    signingRequestId: uuid,
    // A signed envelope is a few kilobytes; the bound keeps parsing cheap.
    xdr: z.string().min(1).max(60_000),
  })
  .strict();
const submitAnswer = z
  .object({
    txHash: z.string(),
    mandateId: z.string().nullable(),
  })
  .strict();

const cursorValue = z.object({ after: uuid }).strict();

const CHAIN_MESSAGES: Readonly<Record<ChainError['code'], [ApiErrorCode, string]>> = {
  SIGNING_REQUEST_MISMATCH: [
    'SIGNING_REQUEST_MISMATCH',
    'The signed transaction is not the one that was prepared',
  ],
  SIGNATURE_INVALID: [
    'SIGNATURE_INVALID',
    'The transaction is not signed by the wallet the request names',
  ],
  CONTRACT_REFUSED: ['CONTRACT_REFUSED', 'The mandate contract refused this'],
  TX_FAILED: ['TX_FAILED', 'The transaction failed on chain'],
  TIMEOUT: ['CHAIN_UNAVAILABLE', 'The Stellar network did not answer in time; try again'],
  UNAVAILABLE: ['CHAIN_UNAVAILABLE', 'The Stellar network is not answering; try again shortly'],
  INVALID_ADDRESS: ['INVALID_REQUEST', 'The request is not valid'],
};

/** Service and chain refusals as the one error envelope. */
export function mandateApiError(error: unknown, log: (line: string) => void, requestId: string) {
  if (error instanceof MandateServiceError) {
    return new ApiError(error.code, error.message, { details: error.details });
  }
  if (error instanceof ChainError) {
    const [code, message] = CHAIN_MESSAGES[error.code];
    log(
      `event=v1_chain_error requestId=${requestId} code=${error.code} reason=${error.reason ?? 'none'}`,
    );
    if (code === 'CHAIN_UNAVAILABLE') {
      return new ApiError(code, message, {
        headers: { 'retry-after': CHAIN_RETRY_AFTER_SECONDS },
      });
    }
    if (code === 'CONTRACT_REFUSED') {
      return new ApiError(code, message, {
        details: [{ path: 'chain', issue: error.specError ?? 'UNKNOWN' }],
      });
    }
    if (code === 'INVALID_REQUEST') {
      return new ApiError(code, message, {
        details: [{ path: 'wallet', issue: error.reason ?? 'invalid_address' }],
      });
    }
    return new ApiError(code, message);
  }
  // The adapter refuses out of range inputs it cannot encode before any call.
  if (error instanceof RangeError) {
    return new ApiError('INVALID_REQUEST', 'The request is not valid', {
      details: [{ path: 'body', issue: 'out_of_range' }],
    });
  }
  return error;
}

export function mandateRoutes(o: MandateRouteOptions): Route[] {
  const { service } = o;
  const requestIdOf = (c: V1Context) => c.get('requestId');
  // Membership, role or key scope are checked here, on every request; the
  // wallet checks that follow are the service's. Only the tenant and the
  // wallet go on.
  const caller = async (c: V1Context, write: boolean): Promise<MandateCaller> => {
    const who = await o.authenticate({ scope: write ? 'mandates:write' : 'mandates:read' })(c);
    if (who.kind === 'key') {
      // Everything written here is signed by a wallet, which a key does not have.
      if (write) throw new ApiError('FORBIDDEN', 'This takes a dashboard session, not an API key');
      return { principalId: who.principalId, projectId: who.projectId, wallet: null };
    }
    return {
      principalId: who.principalId,
      projectId: who.projectId,
      wallet: who.session.walletAddress,
    };
  };
  const run = async <T>(c: V1Context, work: () => Promise<T>): Promise<T> => {
    try {
      return await work();
    } catch (error) {
      throw mandateApiError(error, o.log, requestIdOf(c));
    }
  };

  const token = tokenAmountIn(service);
  const prepareBody = z
    .object({
      name: name.optional(),
      approvers: z.array(address).max(10).default([]),
      approvalsRequired: z.number().int().min(1).max(10).default(1),
      limits: z
        .object({
          totalBudget: token,
          perPaymentCap: token,
          perRecipientDailyCap: token,
          approvalThreshold: token,
          // An approval may wait from a minute to thirty days.
          payoutTtlSeconds: z.number().int().min(60).max(2_592_000).default(86_400),
          expiresAt: z.iso.datetime({ offset: true }).transform((s) => new Date(s)),
        })
        .strict(),
      // Recipients are added once the mandate exists, each to it alone. An
      // empty list is taken so a client that always sends the field still works.
      recipients: z.array(uuid).max(0).optional(),
      recipientMode: z.enum(['allowlist', 'attested', 'both']).default('allowlist'),
    })
    .strict();

  const writeErrors: ApiErrorCode[] = [
    'SESSION_INVALID',
    'ORIGIN_NOT_ALLOWED',
    'FORBIDDEN',
    'CHAIN_UNAVAILABLE',
    'DB_UNAVAILABLE',
  ];

  const prepare = defineRoute({
    method: 'post',
    path: '/v1/mandates/prepare',
    operationId: 'prepareMandate',
    summary: "Build a new mandate for the member's wallet to sign",
    description:
      "The factory call names the project's agent key and the UJIRA executor. Sign it, then send it to POST /v1/signing/submit. A recipient belongs to one mandate: add each with POST /v1/recipients and the new mandateId once it exists, which returns the allow_recipients request to sign.",
    tags: ['mandates'],
    body: prepareBody,
    status: 201,
    response: signingRequestEnvelope,
    errors: [...writeErrors, 'AGENT_KEY_MISSING', 'RECIPIENT_MODE_UNSUPPORTED', 'CONTRACT_REFUSED'],
    handler: async ({ body }, c) => {
      const who = await caller(c, true);
      const signingRequest = await run(c, () =>
        service.prepare(
          who,
          {
            name: body.name ?? null,
            approvers: body.approvers,
            approvalsRequired: body.approvalsRequired,
            limits: body.limits,
            recipientMode: body.recipientMode,
          },
          requestIdOf(c),
        ),
      );
      return { signingRequest };
    },
  });

  const importMandate = defineRoute({
    method: 'post',
    path: '/v1/mandates/import',
    operationId: 'importMandate',
    summary: 'Attach a mandate the member already owns',
    description:
      "Accepted only if the chain names the member's wallet as principal and the project's key as agent. Attaching one already in the project returns it.",
    tags: ['mandates'],
    body: z.object({ contractId: address, name: name.optional() }).strict(),
    response: z.object({ mandate: mandateDetail }).strict(),
    errors: [
      ...writeErrors,
      'AGENT_KEY_MISSING',
      'MANDATE_PRINCIPAL_MISMATCH',
      'MANDATE_AGENT_MISMATCH',
      'MANDATE_TAKEN',
      'RECIPIENT_MODE_UNSUPPORTED',
    ],
    handler: async ({ body }, c) => {
      const who = await caller(c, true);
      const { mandate } = await run(c, () =>
        service.importMandate(
          who,
          { contractId: body.contractId, name: body.name ?? null },
          requestIdOf(c),
        ),
      );
      return { mandate };
    },
  });

  const list = defineRoute({
    method: 'get',
    path: '/v1/mandates',
    operationId: 'listMandates',
    summary: "The project's mandates, with their rules and money as the chain has them",
    tags: ['mandates'],
    query: z
      .object({
        limit: z.coerce.number().int().min(1).max(PAGE_MAX).default(PAGE_DEFAULT),
        cursor: z.string().max(512).optional(),
      })
      .strict(),
    response: z
      .object({ items: z.array(mandateSummary), nextCursor: z.string().nullable() })
      .strict(),
    errors: [
      'SESSION_INVALID',
      'TOKEN_MALFORMED',
      'TOKEN_INVALID',
      'FORBIDDEN',
      'CHAIN_UNAVAILABLE',
      'DB_UNAVAILABLE',
    ],
    handler: async ({ query }, c) => {
      const who = await caller(c, false);
      const after =
        query.cursor === undefined ? undefined : decodeCursor(query.cursor, cursorValue).after;
      const page = await run(c, () =>
        service.list(
          who,
          { limit: query.limit, ...(after === undefined ? {} : { after }) },
          requestIdOf(c),
        ),
      );
      return {
        items: page.items,
        nextCursor: page.next === null ? null : encodeCursor({ after: page.next }),
      };
    },
  });

  const detail = defineRoute({
    method: 'get',
    path: '/v1/mandates/{id}',
    operationId: 'getMandate',
    summary: 'One mandate: its rules, balance, committed and free, and its recipients',
    tags: ['mandates'],
    params: z.object({ id: uuid }).strict(),
    response: z.object({ mandate: mandateDetail }).strict(),
    errors: [
      'SESSION_INVALID',
      'TOKEN_MALFORMED',
      'TOKEN_INVALID',
      'FORBIDDEN',
      'NOT_FOUND',
      'CHAIN_UNAVAILABLE',
      'DB_UNAVAILABLE',
    ],
    handler: async ({ params }, c) => {
      const who = await caller(c, false);
      const mandate = await run(c, () => service.detail(who, params.id, requestIdOf(c)));
      return { mandate };
    },
  });

  const action = defineRoute({
    method: 'post',
    path: '/v1/mandates/{id}/actions',
    operationId: 'prepareMandateAction',
    summary: 'Turn a mandate action into a transaction for the right wallet to sign',
    description:
      "Pause, resume, revoke, allow recipients, fund and withdraw are signed by the mandate's owner; approve and reject by the approver signed in.",
    tags: ['mandates'],
    params: z.object({ id: uuid }).strict(),
    body: actionBody,
    status: 201,
    response: signingRequestEnvelope,
    errors: [...writeErrors, 'NOT_FOUND', 'CONTRACT_REFUSED'],
    handler: async ({ params, body }, c) => {
      const who = await caller(c, true);
      const signingRequest = await run(c, () =>
        service.action(who, params.id, body, requestIdOf(c)),
      );
      return { signingRequest };
    },
  });

  const submit = defineIdempotentRoute({
    method: 'post',
    path: '/v1/signing/submit',
    operationId: 'submitSigned',
    summary: 'Send what the wallet signed; answers once Stellar has it',
    description:
      'The envelope must be exactly the one prepared, signed by the wallet the request names. A request is used up by the first transaction the chain takes for it. A create answers with the new mandateId.',
    tags: ['mandates'],
    body: submitBody,
    response: submitAnswer,
    errors: [
      ...writeErrors,
      'NOT_FOUND',
      'SIGNING_REQUEST_MISMATCH',
      'SIGNATURE_INVALID',
      'SIGNING_REQUEST_USED',
      'SIGNING_REQUEST_EXPIRED',
      'CONTRACT_REFUSED',
      'TX_FAILED',
      'MANDATE_TAKEN',
    ],
    idempotency: {
      store: o.idempotency,
      authenticate: (c) => caller(c, true),
      log: o.log,
    },
    handler: async ({ body, idempotent }, c) => {
      const answer = await run(c, () => service.submit(idempotent.caller, body, requestIdOf(c)));
      return {
        txHash: answer.txHash,
        mandateId: answer.mandateId,
      };
    },
  });

  return [prepare, importMandate, list, detail, action, submit];
}
