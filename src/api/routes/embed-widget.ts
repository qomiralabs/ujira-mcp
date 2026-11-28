// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The onboarding widget's own routes, which take an embed token and nothing
// else: GET /v1/embed/onboarding and POST /v1/embed/recipients/{id}/methods.
// The widget calls them from the hosted invite page or from a page the
// project allows, so a page on another origin may read the answer once its
// token allows that page, and only then.
//
// An API key or a session cookie is not an embed token and is refused here,
// and an embed token is refused everywhere else, because it is not a key.
//
// The wallet proof that follows, wallet-challenges and wallet-proofs under a
// method, mounts beside these with the same embedAuthenticate.

import { z } from 'zod';

import type { AuthenticateEmbed, EmbedCaller } from '../../auth/embed-auth.js';
import { EmbedError, WALLET_METHOD, type EmbedOnboardingService } from '../../identity/embed.js';
import { addLogContext } from '../../log.js';
import type { V1Context } from '../context.js';
import { ApiError } from '../errors.js';
import { defineRoute, type Route } from '../route.js';

/** What the app answers a CORS preflight on, as Hono patterns. */
export const EMBED_WIDGET_PATHS = ['/v1/embed/onboarding', '/v1/embed/recipients/*'] as const;

const MESSAGES = {
  TOKEN_INVALID: 'This link has expired or was revoked',
  ORIGIN_NOT_ALLOWED: 'This page may not run the widget',
} as const;

/**
 * The embed caller behind a request, or the refusal. A page on another origin
 * is let read the answer once its token allows it, and also when the token is
 * refused, so the widget can say the link lapsed: that tells the page only
 * what it already holds.
 */
export function embedAuthenticate(
  authenticate: AuthenticateEmbed,
): (c: V1Context) => Promise<EmbedCaller> {
  return async (c) => {
    const origin = c.req.header('origin') ?? null;
    const result = await authenticate({
      authorization: c.req.header('authorization') ?? null,
      origin,
      fetchSite: c.req.header('sec-fetch-site') ?? null,
    });
    if (!result.ok) {
      if (result.code === 'TOKEN_INVALID' && origin !== null) c.set('corsOrigin', origin);
      throw new ApiError(result.code, MESSAGES[result.code]);
    }
    if (origin !== null) c.set('corsOrigin', result.origin);
    addLogContext({ principalId: result.caller.principalId, projectId: result.caller.projectId });
    return result.caller;
  };
}

export interface EmbedWidgetRouteOptions {
  readonly service: EmbedOnboardingService;
  readonly authenticate: (c: V1Context) => Promise<EmbedCaller>;
}

const recipientParams = z.object({ id: z.uuid() }).strict();

const addMethodBody = z
  .object({
    method: z.string().min(1).max(64),
    destination: z
      .object({
        network: z.string().min(1).max(64),
        address: z.string().min(1).max(128),
        memoType: z.literal('id').optional(),
        memo: z.string().min(1).max(64).optional(),
      })
      .strict(),
  })
  .strict();

const onboardingSchema = z
  .object({
    recipientId: z.uuid(),
    network: z.string(),
    methods: z.array(z.string()),
    neverPayable: z.array(z.string()),
  })
  .strict();

const savedMethodSchema = z
  .object({
    id: z.uuid(),
    method: z.literal(WALLET_METHOD),
    status: z.enum(['active', 'disabled']),
  })
  .strict();

// Fixed messages, so nothing the page sent or the chain said is echoed back.
export function embedWidgetApiError(error: unknown): unknown {
  if (!(error instanceof EmbedError)) return error;
  switch (error.code) {
    case 'RECIPIENT_NOT_FOUND':
    case 'SESSION_NOT_FOUND':
      return new ApiError('NOT_FOUND', 'No such recipient', { cause: error });
    case 'RECIPIENT_SUSPENDED':
      return new ApiError('FORBIDDEN', 'Payouts to this recipient are on hold', { cause: error });
    case 'DESTINATION_INVALID':
      return new ApiError('DESTINATION_INVALID', 'This address cannot be paid', {
        ...(error.reason === undefined ? {} : { reason: error.reason }),
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
    throw embedWidgetApiError(error);
  }
}

const TOKEN_ERRORS = ['TOKEN_INVALID', 'ORIGIN_NOT_ALLOWED', 'DB_UNAVAILABLE'] as const;

export function embedWidgetRoutes(o: EmbedWidgetRouteOptions): Route[] {
  const onboarding = defineRoute({
    method: 'get',
    path: '/v1/embed/onboarding',
    operationId: 'getEmbedOnboarding',
    summary: 'What the widget needs before its first question',
    description:
      'Takes an embed token. The recipient the token was made for, the network a wallet is on, the methods it may be paid by, and the addresses a payout would burn.',
    tags: ['embed'],
    response: onboardingSchema,
    errors: [...TOKEN_ERRORS, 'NOT_FOUND'],
    handler: async (_input, c) => {
      const caller = await o.authenticate(c);
      const view = await answering(() => o.service.onboarding(caller));
      return {
        recipientId: view.recipientId,
        network: view.network,
        methods: [...view.methods],
        neverPayable: [...view.neverPayable],
      };
    },
  });

  const addMethod = defineRoute({
    method: 'post',
    path: '/v1/embed/recipients/{id}/methods',
    operationId: 'addEmbedPayoutMethod',
    summary: "Save the recipient's wallet",
    description:
      'Takes an embed token, for its own recipient only. The wallet is checked and saved unproven; the wallet proof comes next. Saving the same wallet again returns it. An address that needs a memo is refused with the reason MEMO_UNSUPPORTED, since a wallet payout sends none.',
    tags: ['embed'],
    params: recipientParams,
    body: addMethodBody,
    status: 201,
    response: savedMethodSchema,
    errors: [...TOKEN_ERRORS, 'NOT_FOUND', 'FORBIDDEN', 'DESTINATION_INVALID', 'CHAIN_UNAVAILABLE'],
    handler: async ({ params, body }, c) => {
      const caller = await o.authenticate(c);
      if (body.method !== WALLET_METHOD) {
        throw new ApiError('DESTINATION_INVALID', 'This widget saves a Stellar wallet only');
      }
      const saved = await answering(() =>
        o.service.addWallet(
          caller,
          params.id,
          {
            network: body.destination.network,
            address: body.destination.address,
            memo: body.destination.memo,
          },
          c.get('requestId'),
        ),
      );
      return { id: saved.id, method: WALLET_METHOD, status: 'active' as const };
    },
  });

  return [onboarding, addMethod];
}
