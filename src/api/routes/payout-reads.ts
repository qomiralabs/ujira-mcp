// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// GET /v1/payouts, GET /v1/payouts/{id} and GET /v1/approvals.
//
// A platform reads its payouts with an API key holding payouts:read, the
// dashboard with a session; the approvals queue is for people, so it takes a
// session only. The tenant the credential resolves to is the only one any
// query here runs under, so another project's payout reads as not found.
//
// Destinations leave masked, in lists and in the detail alike. Metadata is
// never sent back here: it is the caller's own, and it may name people.

import { z } from 'zod';

import {
  MAX_PAGE_SIZE,
  PageRequestError,
  type PayoutView,
  type ProjectContext,
} from '../../db/index.js';
import {
  PayoutReadError,
  timelineOf,
  type ApprovalView,
  type PayoutReadService,
} from '../../payouts/payout-reads.js';
import { isPayoutStatus, PAYOUT_STATUSES, type PayoutStatus } from '../../payouts/status.js';
import type { Authenticate } from '../authenticate.js';
import { decodeCursor, encodeCursor } from '../cursor.js';
import { ApiError, type ApiErrorCode } from '../errors.js';
import { defineRoute, type Route } from '../route.js';
import { amountOut, amountWire, payoutDetailSchema, payoutWire } from './payouts.js';

export interface PayoutReadRouteOptions {
  readonly service: PayoutReadService;
  readonly authenticate: Authenticate;
}

export const DEFAULT_PAGE_SIZE = 50;

const STATUS_NAMES = PAYOUT_STATUSES.join('|');
// A comma separated list of status codes, such as queued,submitting. Anything
// else, an unknown code or an empty item, fails the pattern and is a 400.
const STATUS_LIST = new RegExp(`^(?:${STATUS_NAMES})(?:,(?:${STATUS_NAMES}))*$`);

// The console asks for up to 200 at a time. A page holds at most MAX_PAGE_SIZE
// and the cursor carries on from there, so a bigger ask gets a full page and a
// cursor rather than an error.
const limit = z
  .string()
  .regex(/^(?:[1-9][0-9]?|1[0-9]{2}|200)$/)
  .optional();

const timestamp = z.iso.datetime({ offset: true });

const listQuery = z
  .object({
    status: z.string().max(256).regex(STATUS_LIST).optional(),
    mandateId: z.uuid().optional(),
    recipientId: z.uuid().optional(),
    // Inclusive.
    createdFrom: timestamp.optional(),
    // Exclusive.
    createdTo: timestamp.optional(),
    cursor: z.string().min(1).max(512).optional(),
    limit,
  })
  .strict();

const pageQuery = z.object({ cursor: z.string().min(1).max(512).optional(), limit }).strict();

const idParams = z.object({ id: z.uuid() }).strict();

// Each list names itself in its cursor, so one list's cursor handed to the
// other is refused rather than read in the wrong direction.
const payoutCursor = z.object({ list: z.literal('payouts'), after: z.string().max(128) }).strict();
const approvalCursor = z
  .object({ list: z.literal('approvals'), after: z.string().max(128) })
  .strict();

// The list item is the payout exactly as POST /v1/payouts answers it; the
// detail and the queue each add one field to it.
const timelineEntrySchema = z
  .object({
    event: z.string(),
    // Null where no time is kept for the step.
    at: z.iso.datetime().nullable(),
    legIndex: z.int().nullable(),
    txHash: z.string().nullable(),
  })
  .strict();

export const payoutWithTimelineSchema = z
  .object({ ...payoutDetailSchema.shape, timeline: z.array(timelineEntrySchema) })
  .strict();

export const approvalItemSchema = z
  .object({
    ...payoutDetailSchema.shape,
    // What the mandate's budget still allows, this payout already set aside;
    // null when the chain did not answer in time.
    budgetLeft: amountOut.nullable(),
  })
  .strict();

function listWire(view: PayoutView): z.input<typeof payoutDetailSchema> {
  return payoutWire(view, view.receiptId);
}

function detailWire(view: PayoutView): z.input<typeof payoutWithTimelineSchema> {
  return {
    ...listWire(view),
    timeline: timelineOf(view).map((entry) => ({
      event: entry.event,
      at: entry.at === null ? null : entry.at.toISOString(),
      legIndex: entry.legIndex,
      txHash: entry.txHash,
    })),
  };
}

function approvalWire(view: ApprovalView): z.input<typeof approvalItemSchema> {
  return {
    ...listWire(view),
    budgetLeft: view.budgetLeft === null ? null : amountWire(view.budgetLeft, view.payout.network),
  };
}

function badCursor(cause: unknown): ApiError {
  return new ApiError('INVALID_REQUEST', 'The cursor is not one this API issued', {
    details: [{ path: 'query.cursor', issue: 'invalid_format' }],
    cause,
  });
}

// The service's refusals as the one error envelope, with fixed messages so
// nothing the caller sent is echoed back. A database outage passes through to
// the app, which answers it with DB_UNAVAILABLE and Retry-After.
export function payoutReadApiError(error: unknown): unknown {
  if (error instanceof PageRequestError) return badCursor(error);
  // PAYOUT_NOT_FOUND is the service's only refusal so far.
  if (error instanceof PayoutReadError) {
    return new ApiError('NOT_FOUND', 'No such payout', { cause: error });
  }
  return error;
}

async function answering<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw payoutReadApiError(error);
  }
}

function pageSize(raw: string | undefined): number {
  return raw === undefined ? DEFAULT_PAGE_SIZE : Math.min(Number.parseInt(raw, 10), MAX_PAGE_SIZE);
}

function statusesOf(raw: string | undefined): PayoutStatus[] | undefined {
  if (raw === undefined) return undefined;
  // The pattern admits only known codes, so the filter drops nothing; it is
  // there to give the codes their type.
  return [...new Set(raw.split(',').filter(isPayoutStatus))];
}

function tenantOf(caller: ProjectContext): ProjectContext {
  return { principalId: caller.principalId, projectId: caller.projectId };
}

const KEY_ERRORS: readonly ApiErrorCode[] = [
  'TOKEN_MALFORMED',
  'TOKEN_INVALID',
  'TOKEN_ENVIRONMENT_MISMATCH',
  'SESSION_INVALID',
  'FORBIDDEN',
  'ORIGIN_NOT_ALLOWED',
  'NOT_FOUND',
  'DB_UNAVAILABLE',
];

export function payoutReadRoutes(o: PayoutReadRouteOptions): Route[] {
  const reader = o.authenticate({ scope: 'payouts:read' });
  const approver = o.authenticate({ via: 'session', permission: 'read' });

  const list = defineRoute({
    method: 'get',
    path: '/v1/payouts',
    operationId: 'listPayouts',
    summary: 'List payouts',
    description:
      "The project's payouts, newest first, a page at a time. Filters combine: status takes a comma separated list of codes, createdFrom is inclusive and createdTo exclusive. An unknown filter or value is a 400. Destinations are masked.",
    tags: ['payouts'],
    query: listQuery,
    response: z
      .object({ items: z.array(payoutDetailSchema), nextCursor: z.string().nullable() })
      .strict(),
    errors: KEY_ERRORS,
    handler: async ({ query }, c) => {
      const caller = await reader(c);
      const createdFrom = query.createdFrom === undefined ? undefined : new Date(query.createdFrom);
      const createdTo = query.createdTo === undefined ? undefined : new Date(query.createdTo);
      if (createdFrom !== undefined && createdTo !== undefined && createdTo <= createdFrom) {
        throw new ApiError('INVALID_REQUEST', 'createdTo must be after createdFrom', {
          details: [{ path: 'query.createdTo', issue: 'too_small' }],
        });
      }
      const after =
        query.cursor === undefined ? undefined : decodeCursor(query.cursor, payoutCursor).after;
      const page = await answering(() =>
        o.service.list(tenantOf(caller), {
          statuses: statusesOf(query.status),
          mandateId: query.mandateId,
          recipientId: query.recipientId,
          createdFrom,
          createdTo,
          after,
          limit: pageSize(query.limit),
        }),
      );
      return {
        items: page.items.map(listWire),
        nextCursor: page.next === null ? null : encodeCursor({ list: 'payouts', after: page.next }),
      };
    },
  });

  const get = defineRoute({
    method: 'get',
    path: '/v1/payouts/{id}',
    operationId: 'getPayout',
    summary: 'Get a payout',
    description:
      'One payout with its legs and a timeline of what the record shows happened to it. Destinations are masked.',
    tags: ['payouts'],
    params: idParams,
    response: z.object({ payout: payoutWithTimelineSchema }).strict(),
    errors: KEY_ERRORS,
    handler: async ({ params }, c) => {
      const caller = await reader(c);
      const view = await answering(() => o.service.get(tenantOf(caller), params.id.toLowerCase()));
      return { payout: detailWire(view) };
    },
  });

  const approvals = defineRoute({
    method: 'get',
    path: '/v1/approvals',
    operationId: 'listApprovals',
    summary: 'List payouts waiting for approval',
    description:
      "The project's payouts in pending_approval, oldest first, each with what its mandate's budget still allows. Approving or rejecting one is a mandate action the approver signs in their wallet. Takes a dashboard session.",
    tags: ['payouts'],
    query: pageQuery,
    response: z
      .object({ items: z.array(approvalItemSchema), nextCursor: z.string().nullable() })
      .strict(),
    errors: ['SESSION_INVALID', 'FORBIDDEN', 'NOT_FOUND', 'DB_UNAVAILABLE'],
    handler: async ({ query }, c) => {
      const caller = await approver(c);
      const after =
        query.cursor === undefined ? undefined : decodeCursor(query.cursor, approvalCursor).after;
      const page = await answering(() =>
        o.service.approvals(
          tenantOf(caller),
          { after, limit: pageSize(query.limit) },
          c.get('requestId'),
        ),
      );
      return {
        items: page.items.map(approvalWire),
        nextCursor:
          page.next === null ? null : encodeCursor({ list: 'approvals', after: page.next }),
      };
    },
  });

  return [list, get, approvals];
}
