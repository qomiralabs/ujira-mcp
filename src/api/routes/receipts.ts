// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// GET /v1/receipts, /v1/receipts/export.csv, /v1/receipts/{id} and
// /v1/receipts/{id}/verify, with an API key holding payouts:read or a
// session. The tenant the credential resolves to is the only one anything
// here reads, so another project's receipt is not found.
//
// Lists are newest issued first. The filters are the payout list's: status
// as a comma list of final statuses, mandate, recipient, and createdFrom
// (inclusive) to createdTo (exclusive), both read as when the receipt was
// issued.

import { z } from 'zod';

import { ChainError } from '../../chain/adapter.js';
import {
  DatabaseUnavailableError,
  PageRequestError,
  type ProjectContext,
  type ReceiptFilter,
} from '../../db/index.js';
import { ReceiptError } from '../../receipts/errors.js';
import { RECEIPT_PAGE_MAX, type ReceiptService } from '../../receipts/service.js';
import { VERIFY_FIELDS } from '../../receipts/verify.js';
import { receiptWire } from '../../receipts/views.js';
import { TERMINAL_STATUSES, type PayoutStatus } from '../../payouts/status.js';
import type { Authenticate } from '../authenticate.js';
import type { V1Context } from '../context.js';
import { decodeCursor, encodeCursor } from '../cursor.js';
import { ApiError } from '../errors.js';
import { defineRoute, defineTextRoute, type Route } from '../route.js';

export interface ReceiptRouteOptions {
  readonly service: ReceiptService;
  readonly authenticate: Authenticate;
}

export const DEFAULT_RECEIPT_PAGE = 50;
// The console asks for 200 at a time; a page holds at most what the
// repository reads at once, and nextCursor carries on from there.
export const MAX_RECEIPT_LIMIT = 200;

const TERMINAL: ReadonlySet<string> = new Set(TERMINAL_STATUSES);

const statusList = z
  .string()
  .max(200)
  .transform((raw, ctx): PayoutStatus[] => {
    const parts = [...new Set(raw.split(',').map((part) => part.trim()))];
    if (parts.length === 0 || parts.some((part) => !TERMINAL.has(part))) {
      ctx.addIssue({ code: 'custom', message: 'a comma list of final payout statuses' });
      return z.NEVER;
    }
    return parts as PayoutStatus[];
  });

const instant = z.iso.datetime({ offset: true }).transform((text) => new Date(text));

const filterShape = {
  status: statusList.optional(),
  mandateId: z.uuid().optional(),
  recipientId: z.uuid().optional(),
  createdFrom: instant.optional(),
  createdTo: instant.optional(),
};

const exportQuery = z.object(filterShape).strict();

const listQuery = z
  .object({
    ...filterShape,
    cursor: z.string().min(1).max(512).optional(),
    limit: z
      .string()
      .regex(/^[1-9][0-9]{0,2}$/)
      .transform((text) => Number.parseInt(text, 10))
      .refine((value) => value <= MAX_RECEIPT_LIMIT, { message: 'at most 200' })
      .optional(),
  })
  .strict();

const idParams = z.object({ id: z.uuid() }).strict();
const cursorSchema = z.object({ after: z.string().min(1).max(256) }).strict();

const amountOut = z
  .object({ amount: z.string(), asset: z.string(), network: z.string(), scale: z.int() })
  .strict();

export const receiptSchema = z
  .object({
    id: z.uuid(),
    payoutId: z.uuid(),
    mandate: z.object({ id: z.uuid(), contractId: z.string() }).strict(),
    recipient: z.object({ id: z.uuid(), label: z.string(), ref: z.string().nullable() }).strict(),
    taskId: z.string(),
    network: z.string(),
    amount: amountOut,
    fee: amountOut,
    // The payout's final status.
    outcome: z.string(),
    blockedBy: z.string().nullable(),
    // Both null unless the payout was paid.
    txHash: z.string().nullable(),
    ref: z.string().nullable(),
    requestTxHash: z.string().nullable(),
    issuedAt: z.iso.datetime(),
    settledAt: z.iso.datetime().nullable(),
    legs: z.array(
      z
        .object({
          index: z.int(),
          // Masked.
          destination: z.string(),
          amount: amountOut,
          txHash: z.string().nullable(),
        })
        .strict(),
    ),
    // SHA-256 over the receipt's canonical document.
    documentSha256: z.string(),
  })
  .strict();

const verificationSchema = z
  .object({
    matched: z.boolean(),
    field: z.enum(VERIFY_FIELDS).nullable(),
    txHash: z.string().nullable(),
  })
  .strict();

function filterOf(query: z.output<typeof exportQuery>): ReceiptFilter {
  return {
    ...(query.status === undefined ? {} : { statuses: query.status }),
    ...(query.mandateId === undefined ? {} : { mandateId: query.mandateId.toLowerCase() }),
    ...(query.recipientId === undefined ? {} : { recipientId: query.recipientId.toLowerCase() }),
    ...(query.createdFrom === undefined ? {} : { issuedFrom: query.createdFrom }),
    ...(query.createdTo === undefined ? {} : { issuedTo: query.createdTo }),
  };
}

// Refusals as the one error envelope. Messages are fixed here, so nothing a
// row or the chain said is echoed back.
export function receiptApiError(error: unknown): unknown {
  if (error instanceof DatabaseUnavailableError) {
    return new ApiError('DB_UNAVAILABLE', 'The database is unavailable; try again shortly', {
      headers: { 'retry-after': '5' },
      cause: error,
    });
  }
  if (error instanceof PageRequestError) {
    return new ApiError('INVALID_REQUEST', 'The cursor is not one this API issued', {
      details: [{ path: 'query.cursor', issue: 'invalid' }],
      cause: error,
    });
  }
  if (error instanceof ChainError) {
    return new ApiError('CHAIN_UNAVAILABLE', 'The chain did not answer in time; try again', {
      headers: { 'retry-after': '5' },
      cause: error,
    });
  }
  if (!(error instanceof ReceiptError)) return error;
  switch (error.code) {
    case 'RECEIPT_NOT_FOUND':
      return new ApiError('NOT_FOUND', 'No such receipt', { cause: error });
    case 'RECEIPT_NETWORK_NOT_SERVED':
      return new ApiError(
        'CHAIN_UNAVAILABLE',
        'The receipt is on a network this server does not check',
        { cause: error },
      );
    default:
      return error;
  }
}

async function answering<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw receiptApiError(error);
  }
}

// Each chunk's failure as the error envelope while the answer has not
// started; after that the route can only cut the stream short.
async function* mapped(chunks: AsyncIterable<string>): AsyncIterable<string> {
  try {
    yield* chunks;
  } catch (error) {
    throw receiptApiError(error);
  }
}

const AUTH_ERRORS = [
  'TOKEN_MALFORMED',
  'TOKEN_INVALID',
  'TOKEN_ENVIRONMENT_MISMATCH',
  'SESSION_INVALID',
  'FORBIDDEN',
] as const;

export function receiptRoutes(o: ReceiptRouteOptions): Route[] {
  const authenticate = o.authenticate({ scope: 'payouts:read' });
  // Only the tenant goes on: the service has no use for the key or session.
  const reader = async (c: V1Context): Promise<ProjectContext> => {
    const caller = await authenticate(c);
    return { principalId: caller.principalId, projectId: caller.projectId };
  };

  const list = defineRoute({
    method: 'get',
    path: '/v1/receipts',
    operationId: 'listReceipts',
    summary: 'List receipts',
    description:
      "The project's receipts, newest issued first, one per finished payout. A blocked payout's receipt names the spec error in blockedBy and has no transaction. limit is up to 200; a page holds at most 100, and nextCursor carries on.",
    tags: ['receipts'],
    query: listQuery,
    response: z
      .object({ items: z.array(receiptSchema), nextCursor: z.string().nullable() })
      .strict(),
    errors: [...AUTH_ERRORS, 'DB_UNAVAILABLE'],
    handler: async ({ query }, c) => {
      const caller = await reader(c);
      const { cursor, limit, ...filters } = query;
      const after = cursor === undefined ? undefined : decodeCursor(cursor, cursorSchema).after;
      const page = await answering(() =>
        o.service.list(caller, {
          ...filterOf(filters),
          limit: Math.min(limit ?? DEFAULT_RECEIPT_PAGE, RECEIPT_PAGE_MAX),
          ...(after === undefined ? {} : { after }),
        }),
      );
      return {
        items: page.items.map(receiptWire),
        nextCursor: page.next === null ? null : encodeCursor({ after: page.next }),
      };
    },
  });

  const exportCsv = defineTextRoute({
    path: '/v1/receipts/export.csv',
    operationId: 'exportReceipts',
    summary: 'Export receipts as CSV',
    description:
      'Every receipt the filters select, newest issued first, as RFC 4180 CSV. amount is formatted in the token unit; amount_minor and fee_minor are the exact minor units at scale. Cells a spreadsheet would run as a formula are prefixed with a quote.',
    tags: ['receipts'],
    query: exportQuery,
    mediaType: 'text/csv; charset=utf-8',
    filename: 'receipts.csv',
    responseDescription: 'The receipts, as CSV',
    errors: [...AUTH_ERRORS, 'DB_UNAVAILABLE'],
    handler: async ({ query }, c) => {
      const caller = await reader(c);
      return mapped(o.service.exportCsv(caller, filterOf(query)));
    },
  });

  const get = defineRoute({
    method: 'get',
    path: '/v1/receipts/{id}',
    operationId: 'getReceipt',
    summary: 'Get a receipt',
    tags: ['receipts'],
    params: idParams,
    response: z.object({ receipt: receiptSchema }).strict(),
    errors: [...AUTH_ERRORS, 'NOT_FOUND', 'DB_UNAVAILABLE'],
    handler: async ({ params }, c) => {
      const caller = await reader(c);
      const receipt = await answering(() => o.service.get(caller, params.id.toLowerCase()));
      return { receipt: receiptWire(receipt) };
    },
  });

  const verify = defineRoute({
    method: 'get',
    path: '/v1/receipts/{id}/verify',
    operationId: 'verifyReceipt',
    summary: 'Check a receipt against the chain',
    description:
      'Reads the transaction the receipt names from the chain and checks that it succeeded, called the mandate, and moved each leg to its destination for its amount. field is the first that differs, in the order txHash, mandate, destination, amount, or null when all match. A receipt with no transaction, such as a blocked payout, answers matched false with field txHash.',
    tags: ['receipts'],
    params: idParams,
    response: verificationSchema,
    errors: [...AUTH_ERRORS, 'NOT_FOUND', 'CHAIN_UNAVAILABLE', 'DB_UNAVAILABLE'],
    handler: async ({ params }, c) => {
      const caller = await reader(c);
      return answering(() => o.service.verify(caller, params.id.toLowerCase(), c.get('requestId')));
    },
  });

  // The export first, so its fixed path is never read as a receipt id.
  return [list, exportCsv, get, verify];
}
