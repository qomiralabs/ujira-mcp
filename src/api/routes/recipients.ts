// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// POST /v1/recipients, GET /v1/recipients and GET /v1/recipients/{id}.
//
// Who is asking comes from the authenticate callback, which the server wires
// to sessions and API keys; these routes only say which scope they need and
// whether they write. The tenant it returns is the only tenant any query
// here runs under, so another project's rows read as not found.
//
// Addresses leave masked. An email leaves only in the detail of one
// recipient, never in a list and never in the answer to a create, which a
// client or a proxy is more likely to log.

import { z } from 'zod';

import { DatabaseUnavailableError, type ProjectContext } from '../../db/index.js';
import {
  isPayable,
  maskAddress,
  payStatus,
  RecipientError,
  type RecipientService,
  type RecipientView,
} from '../../payouts/recipients.js';
import type { StoredSigningRequest } from '../../db/index.js';
import type { V1Context } from '../context.js';
import { decodeCursor, encodeCursor } from '../cursor.js';
import { ApiError } from '../errors.js';
import { defineRoute, type Route } from '../route.js';

export type RecipientScope = 'recipients:read' | 'recipients:write';

export interface RecipientAccess {
  readonly scope: RecipientScope;
  // Writes from a browser session also need the app's origin.
  readonly write: boolean;
}

export interface RecipientRouteOptions {
  readonly service: RecipientService;
  // Throws the matching ApiError (TOKEN_INVALID, SESSION_INVALID, FORBIDDEN,
  // ORIGIN_NOT_ALLOWED) when the caller may not do this.
  readonly authenticate: (c: V1Context, access: RecipientAccess) => Promise<ProjectContext>;
}

export const DEFAULT_PAGE_SIZE = 50;

// Control characters would let a label rewrite what a terminal or a log
// shows; the database refuses them too.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

const label = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .refine((value) => !CONTROL.test(value), { message: 'no control characters' });

const createBody = z
  .object({
    mandateId: z.uuid(),
    label,
    address: z.string().min(1).max(128).optional(),
    email: z.email().max(254).optional(),
  })
  .strict();

const listQuery = z
  .object({
    mandateId: z.uuid().optional(),
    cursor: z.string().min(1).max(512).optional(),
    limit: z
      .string()
      .regex(/^(?:[1-9]|[1-9][0-9]|100)$/)
      .optional(),
  })
  .strict();

const idParams = z.object({ id: z.uuid() }).strict();

const cursorSchema = z.object({ after: z.uuid() }).strict();

const payStatusSchema = z.enum([
  'active',
  'suspended',
  'needs_wallet',
  'no_account',
  'no_trustline',
  'unchecked',
]);

const recipientShape = {
  id: z.uuid(),
  mandateId: z.uuid(),
  label: z.string(),
  // Masked, or null until the recipient has a wallet.
  address: z.string().nullable(),
  // active means a payout can go to this recipient now; anything else says why not.
  status: payStatusSchema,
  payable: z.boolean(),
  createdAt: z.iso.datetime(),
};

const recipientSchema = z.object(recipientShape).strict();
const recipientDetailSchema = z
  .object({ ...recipientShape, email: z.string().nullable() })
  .strict();

const signingRequestSchema = z
  .object({
    id: z.uuid(),
    network: z.string(),
    xdr: z.string(),
    signer: z.string(),
    action: z.string(),
    summary: z.string(),
    expiresAt: z.iso.datetime(),
  })
  .strict();

function recipientWire(view: RecipientView): z.input<typeof recipientSchema> {
  return {
    id: view.recipient.id,
    mandateId: view.recipient.mandateId,
    label: view.recipient.label,
    address: view.method === null ? null : maskAddress(view.method.destination),
    status: payStatus(view),
    payable: isPayable(view),
    createdAt: view.recipient.createdAt.toISOString(),
  };
}

function signingRequestWire(request: StoredSigningRequest): z.input<typeof signingRequestSchema> {
  return {
    id: request.id,
    network: request.network,
    xdr: request.envelope,
    signer: request.signer,
    action: request.action,
    summary: request.summary,
    expiresAt: request.expiresAt.toISOString(),
  };
}

// The service's refusals as the one error envelope. Messages are fixed here,
// so nothing the caller sent or the chain said is echoed back.
export function recipientApiError(error: unknown): unknown {
  if (error instanceof DatabaseUnavailableError) {
    return new ApiError('DB_UNAVAILABLE', 'The database is unavailable; try again shortly', {
      cause: error,
    });
  }
  if (!(error instanceof RecipientError)) return error;
  switch (error.code) {
    case 'MANDATE_NOT_FOUND':
      return new ApiError('NOT_FOUND', 'No such mandate', { cause: error });
    case 'RECIPIENT_NOT_FOUND':
      return new ApiError('NOT_FOUND', 'No such recipient', { cause: error });
    case 'LABEL_TAKEN':
      return new ApiError(
        'RECIPIENT_LABEL_TAKEN',
        'A recipient on this mandate already has that label',
        { details: [{ path: 'body.label', issue: 'taken' }], cause: error },
      );
    case 'ADDRESS_INVALID':
      return new ApiError('INVALID_REQUEST', 'The address is not an account address', {
        details: [{ path: 'body.address', issue: 'invalid_address' }],
        cause: error,
      });
    case 'DESTINATION_NEEDS_MEMO':
      return new ApiError(
        'INVALID_REQUEST',
        'That address needs a memo, which a wallet payout does not send',
        { details: [{ path: 'body.address', issue: 'needs_memo' }], cause: error },
      );
    case 'MANDATE_REFUSED':
      return new ApiError('MANDATE_REFUSED', 'The mandate refused this change', {
        details: [
          { path: 'mandate', issue: (error.specError ?? 'refused').toLowerCase().slice(0, 64) },
        ],
        cause: error,
      });
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
    throw recipientApiError(error);
  }
}

export function recipientRoutes(o: RecipientRouteOptions): Route[] {
  const create = defineRoute({
    method: 'post',
    path: '/v1/recipients',
    operationId: 'createRecipient',
    summary: 'Add a recipient to a mandate',
    description:
      'A recipient has a label, unique on its mandate in any case, and optionally a wallet and an email. With a wallet the answer carries the allow_recipients request the principal signs to put it on the mandate; without one it is null. A wallet that cannot take the asset yet is saved with a status that says why, and is not payable until that is fixed.',
    tags: ['recipients'],
    body: createBody,
    status: 201,
    response: z
      .object({ recipient: recipientSchema, signingRequest: signingRequestSchema.nullable() })
      .strict(),
    responseDescription: 'The recipient, and the signing request for its wallet',
    errors: [
      'TOKEN_INVALID',
      'SESSION_INVALID',
      'FORBIDDEN',
      'ORIGIN_NOT_ALLOWED',
      'NOT_FOUND',
      'RECIPIENT_LABEL_TAKEN',
      'MANDATE_REFUSED',
      'CHAIN_UNAVAILABLE',
      'DB_UNAVAILABLE',
    ],
    handler: async ({ body }, c) => {
      const caller = await o.authenticate(c, { scope: 'recipients:write', write: true });
      const created = await answering(() => o.service.create(caller, body, c.get('requestId')));
      return {
        recipient: recipientWire(created.view),
        signingRequest:
          created.signingRequest === null ? null : signingRequestWire(created.signingRequest),
      };
    },
  });

  const list = defineRoute({
    method: 'get',
    path: '/v1/recipients',
    operationId: 'listRecipients',
    summary: 'List recipients',
    description:
      "The project's recipients in a stable order, optionally of one mandate. Emails are never listed.",
    tags: ['recipients'],
    query: listQuery,
    response: z
      .object({ items: z.array(recipientSchema), nextCursor: z.string().nullable() })
      .strict(),
    errors: ['TOKEN_INVALID', 'SESSION_INVALID', 'FORBIDDEN', 'DB_UNAVAILABLE'],
    handler: async ({ query }, c) => {
      const caller = await o.authenticate(c, { scope: 'recipients:read', write: false });
      const after =
        query.cursor === undefined ? undefined : decodeCursor(query.cursor, cursorSchema).after;
      const page = await answering(() =>
        o.service.list(caller, {
          mandateId: query.mandateId,
          after,
          limit: query.limit === undefined ? DEFAULT_PAGE_SIZE : Number.parseInt(query.limit, 10),
        }),
      );
      return {
        items: page.items.map(recipientWire),
        nextCursor: page.next === null ? null : encodeCursor({ after: page.next }),
      };
    },
  });

  const get = defineRoute({
    method: 'get',
    path: '/v1/recipients/{id}',
    operationId: 'getRecipient',
    summary: 'Get a recipient',
    description:
      'One recipient with its email, if it has one. A wallet that could not receive is checked on the chain again, so a fixed one shows as payable.',
    tags: ['recipients'],
    params: idParams,
    response: z.object({ recipient: recipientDetailSchema }).strict(),
    errors: ['TOKEN_INVALID', 'SESSION_INVALID', 'FORBIDDEN', 'NOT_FOUND', 'DB_UNAVAILABLE'],
    handler: async ({ params }, c) => {
      const caller = await o.authenticate(c, { scope: 'recipients:read', write: false });
      const detail = await answering(() => o.service.get(caller, params.id, c.get('requestId')));
      return { recipient: { ...recipientWire(detail), email: detail.email } };
    },
  });

  return [create, list, get];
}
