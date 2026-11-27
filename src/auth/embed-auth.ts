// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// Authentication for the widget's own routes. An embed token works only
// there, only for the one recipient it was made for, only until it lapses or
// is revoked, and only from a page the project allows: its own listed origins,
// or UJIRA's hosted invite page. Unknown, lapsed and revoked tokens all read
// the same to the caller.
//
// Nothing is cached, unlike an API key, so revoking a link in the dashboard
// takes effect on the very next request.
//
// A browser says where a page is in Origin, except on a GET to its own origin,
// where it sends Sec-Fetch-Site instead. That is how the hosted invite page
// reads its recipient. A request that says neither is not from a browser page
// at all and is refused, as a token copied out of a page should be.

import type { Tenant } from './scopes.js';
import { parseEmbedToken } from './embed-token.js';
import type { TokenEnvironment } from './token.js';

/** What the store knows about a live token. The secret itself is never in it. */
export interface EmbedTokenLookup {
  readonly sessionId: string;
  readonly principalId: string;
  readonly projectId: string;
  readonly recipientId: string;
  readonly expiresAt: Date;
  /** The pages the project lets the widget run on, beside the hosted invite page. */
  readonly allowedOrigins: readonly string[];
}

export interface EmbedTokenStore {
  /** The live token this hash names, whatever its tenant, or undefined. */
  find(secretSha256: Buffer): Promise<EmbedTokenLookup | undefined>;
}

/** Who an embed token lets in. */
export interface EmbedCaller extends Tenant {
  readonly sessionId: string;
  readonly recipientId: string;
  readonly expiresAt: Date;
}

export interface EmbedCredentials {
  /** The Authorization header as sent, or null. */
  readonly authorization: string | null;
  /** The Origin header as sent, or null. */
  readonly origin: string | null;
  /** The Sec-Fetch-Site header as sent, or null. */
  readonly fetchSite: string | null;
}

export type EmbedFailureCode = 'TOKEN_INVALID' | 'ORIGIN_NOT_ALLOWED';

export type EmbedAuthResult =
  | {
      readonly ok: true;
      readonly caller: EmbedCaller;
      /** The page's origin, to allow it to read the answer. */
      readonly origin: string;
    }
  | { readonly ok: false; readonly code: EmbedFailureCode };

export type AuthenticateEmbed = (credentials: EmbedCredentials) => Promise<EmbedAuthResult>;

export interface EmbedAuthOptions {
  readonly store: EmbedTokenStore;
  /** The one environment whose tokens this deployment accepts. */
  readonly environment: TokenEnvironment;
  /** Where the hosted invite page lives, such as https://ujira.co. Always allowed. */
  readonly appOrigin: string;
  readonly now?: () => Date;
}

const BEARER = /^Bearer ([\x21-\x7e]{1,256})$/;

/** The origin a browser page is on, or null when the request does not come from one. */
export function pageOrigin(credentials: EmbedCredentials, appOrigin: string): string | null {
  if (credentials.origin !== null) return credentials.origin;
  return credentials.fetchSite === 'same-origin' ? appOrigin : null;
}

export function createEmbedAuthenticator(o: EmbedAuthOptions): AuthenticateEmbed {
  const now = o.now ?? (() => new Date());
  const appOrigin = new URL(o.appOrigin).origin;
  return async (credentials) => {
    const presented = BEARER.exec(credentials.authorization ?? '')?.[1];
    const parsed = presented === undefined ? null : parseEmbedToken(presented);
    if (parsed?.environment !== o.environment) return { ok: false, code: 'TOKEN_INVALID' };
    const lookup = await o.store.find(parsed.secretSha256);
    // The store only returns live tokens; the clock here is a second guard.
    if (lookup === undefined || lookup.expiresAt.getTime() <= now().getTime()) {
      return { ok: false, code: 'TOKEN_INVALID' };
    }
    const origin = pageOrigin(credentials, appOrigin);
    if (origin === null || (origin !== appOrigin && !lookup.allowedOrigins.includes(origin))) {
      return { ok: false, code: 'ORIGIN_NOT_ALLOWED' };
    }
    return {
      ok: true,
      origin,
      caller: {
        principalId: lookup.principalId,
        projectId: lookup.projectId,
        sessionId: lookup.sessionId,
        recipientId: lookup.recipientId,
        expiresAt: lookup.expiresAt,
      },
    };
  };
}
