// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  createEmbedAuthenticator,
  pageOrigin,
  type EmbedCredentials,
  type EmbedTokenLookup,
} from './embed-auth.js';
import { issueEmbedToken } from './embed-token.js';
import { issueToken } from './token.js';

const APP = 'https://ujira.co';
const SHOP = 'https://shop.example.com';
const NOW = new Date('2026-11-27T12:00:00.000Z');

function world(over: Partial<EmbedTokenLookup> = {}) {
  const issued = issueEmbedToken('test');
  const lookup: EmbedTokenLookup = {
    sessionId: randomUUID(),
    principalId: randomUUID(),
    projectId: randomUUID(),
    recipientId: randomUUID(),
    expiresAt: new Date(NOW.getTime() + 30 * 60_000),
    allowedOrigins: [SHOP],
    ...over,
  };
  const asked: Buffer[] = [];
  const authenticate = createEmbedAuthenticator({
    store: {
      find: (hash) => {
        asked.push(hash);
        return Promise.resolve(hash.equals(issued.secretSha256) ? lookup : undefined);
      },
    },
    environment: 'test',
    appOrigin: `${APP}/`,
    now: () => NOW,
  });
  return { token: issued.token, lookup, asked, authenticate };
}

function credentials(over: Partial<EmbedCredentials>): EmbedCredentials {
  return { authorization: null, origin: null, fetchSite: null, ...over };
}

describe('embed token authentication', () => {
  it('lets in the token from an origin its project allows, as its own recipient and tenant', async () => {
    const { token, lookup, authenticate } = world();
    const result = await authenticate(
      credentials({ authorization: `Bearer ${token}`, origin: SHOP, fetchSite: 'cross-site' }),
    );
    expect(result).toEqual({
      ok: true,
      origin: SHOP,
      caller: {
        principalId: lookup.principalId,
        projectId: lookup.projectId,
        sessionId: lookup.sessionId,
        recipientId: lookup.recipientId,
        expiresAt: lookup.expiresAt,
      },
    });
  });

  it('always lets in the hosted invite page, by Origin or as a same origin read', async () => {
    const { token, authenticate } = world({ allowedOrigins: [] });
    const authorization = `Bearer ${token}`;
    expect(await authenticate(credentials({ authorization, origin: APP }))).toMatchObject({
      ok: true,
      origin: APP,
    });
    expect(
      await authenticate(credentials({ authorization, fetchSite: 'same-origin' })),
    ).toMatchObject({ ok: true, origin: APP });
  });

  it('refuses a page its project did not allow, and a request from no page at all', async () => {
    const { token, authenticate } = world();
    const authorization = `Bearer ${token}`;
    for (const sent of [
      credentials({ authorization, origin: 'https://evil.example.com' }),
      credentials({ authorization, origin: 'http://shop.example.com' }),
      credentials({ authorization, origin: 'null' }),
      credentials({ authorization }),
      credentials({ authorization, fetchSite: 'cross-site' }),
      credentials({ authorization, fetchSite: 'none' }),
    ]) {
      expect(await authenticate(sent)).toEqual({ ok: false, code: 'ORIGIN_NOT_ALLOWED' });
    }
  });

  it('reads an unknown, a lapsed and a malformed token the same, and looks up only well formed ones', async () => {
    const { token, asked, authenticate } = world({
      expiresAt: new Date(NOW.getTime()),
    });
    const refused = { ok: false, code: 'TOKEN_INVALID' };
    // The store says live; the clock is the second guard.
    expect(
      await authenticate(credentials({ authorization: `Bearer ${token}`, origin: SHOP })),
    ).toEqual(refused);
    expect(
      await authenticate(
        credentials({ authorization: `Bearer ${issueEmbedToken('test').token}`, origin: SHOP }),
      ),
    ).toEqual(refused);
    expect(asked).toHaveLength(2);
    for (const authorization of [
      null,
      token,
      `Basic ${token}`,
      `Bearer ${token}x`,
      `Bearer ${issueEmbedToken('live').token}`,
      `Bearer ${issueToken('test').token}`,
    ]) {
      expect(await authenticate(credentials({ authorization, origin: SHOP }))).toEqual(refused);
    }
    expect(asked).toHaveLength(2);
  });

  it('takes the page origin from Origin first, then from a same origin read only', () => {
    expect(pageOrigin(credentials({ origin: SHOP, fetchSite: 'same-origin' }), APP)).toBe(SHOP);
    expect(pageOrigin(credentials({ fetchSite: 'same-origin' }), APP)).toBe(APP);
    expect(pageOrigin(credentials({ fetchSite: 'same-site' }), APP)).toBeNull();
    expect(pageOrigin(credentials({}), APP)).toBeNull();
  });
});
