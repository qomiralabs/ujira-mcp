// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The widget's routes with the real embed token check over a store held in
// memory and an onboarding service stub: only an embed token gets in, only
// from a page its project allows, only for its own recipient, and a page on
// another origin can read the answer exactly when its token allows it. An
// embed token is refused on every route that is not the widget's.

import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { createEmbedAuthenticator, type EmbedTokenLookup } from '../../auth/embed-auth.js';
import { issueEmbedToken } from '../../auth/embed-token.js';
import { createTokenAuthenticator } from '../../auth/token-auth.js';
import { issueToken } from '../../auth/token.js';
import type { PayoutMethod } from '../../db/index.js';
import {
  EmbedError,
  type EmbedOnboardingService,
  type WalletDestinationInput,
} from '../../identity/embed.js';
import { createV1App } from '../app.js';
import { createAuthenticate } from '../authenticate.js';
import { errorEnvelopeSchema } from '../errors.js';
import { embedSessionRoutes } from './embed-sessions.js';
import {
  EMBED_WIDGET_PATHS,
  embedAuthenticate,
  embedWidgetApiError,
  embedWidgetRoutes,
} from './embed-widget.js';

const APP = 'https://ujira.co';
const SHOP = 'https://shop.example.com';
const ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
const WALLET = 'GBT7ITQKEX3Z2YWIYLPRQ5W3JLA2TJ3JTABB765ZYNG7VLX5YYUPI3DT';

interface Added {
  readonly recipientId: string;
  readonly destination: WalletDestinationInput;
}

function harness(over: Partial<EmbedOnboardingService> = {}) {
  const issued = issueEmbedToken('test');
  const lookup: EmbedTokenLookup = {
    sessionId: randomUUID(),
    principalId: randomUUID(),
    projectId: randomUUID(),
    recipientId: randomUUID(),
    expiresAt: new Date(Date.now() + 1_800_000),
    allowedOrigins: [SHOP],
  };
  const live = { value: true };
  const added: Added[] = [];
  const service: EmbedOnboardingService = {
    onboarding: (caller) =>
      Promise.resolve({
        recipientId: caller.recipientId,
        network: 'stellar:testnet',
        methods: ['stellar_wallet'],
        neverPayable: [ISSUER],
      }),
    addWallet: (caller, recipientId, destination) => {
      if (recipientId !== caller.recipientId) {
        return Promise.reject(new EmbedError('RECIPIENT_NOT_FOUND', 'x'));
      }
      added.push({ recipientId, destination });
      const method: PayoutMethod = {
        id: randomUUID(),
        projectId: caller.projectId,
        recipientId,
        method: 'stellar_wallet',
        destination: destination.address,
        verifiedAt: null,
        destinationStatus: 'receivable',
        checkedAt: new Date(),
        createdAt: new Date(),
      };
      return Promise.resolve(method);
    },
    ...over,
  };
  const embed = embedAuthenticate(
    createEmbedAuthenticator({
      store: {
        find: (hash) =>
          Promise.resolve(live.value && hash.equals(issued.secretSha256) ? lookup : undefined),
      },
      environment: 'test',
      appOrigin: APP,
    }),
  );
  // Keys and sessions as the server wires them, with no key known at all.
  const tokens = createTokenAuthenticator({
    store: {
      find: () => Promise.resolve(undefined),
      touchLastUsed: () => Promise.resolve(),
      recordSecurityEvent: () => Promise.resolve(),
    },
    environment: 'test',
    log: () => undefined,
  });
  const { app } = createV1App({
    routes: [
      ...embedWidgetRoutes({ service, authenticate: embed }),
      ...embedSessionRoutes({
        service: {
          create: () => Promise.reject(new Error('not reached')),
          list: () => Promise.reject(new Error('not reached')),
          revoke: () => Promise.reject(new Error('not reached')),
          allowedOrigins: () => Promise.reject(new Error('not reached')),
          setAllowedOrigins: () => Promise.reject(new Error('not reached')),
        },
        authenticate: createAuthenticate({ tokens }),
      }),
    ],
    crossOrigin: EMBED_WIDGET_PATHS,
  });
  const send = async (
    method: string,
    path: string,
    headers: Record<string, string>,
    body?: unknown,
  ) => {
    const response = await app.request(path, {
      method,
      headers: {
        ...headers,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    return {
      status: response.status,
      headers: response.headers,
      body: text === '' ? undefined : (JSON.parse(text) as unknown),
    };
  };
  return { token: issued.token, lookup, live, added, send };
}

function codeOf(body: unknown): string {
  return errorEnvelopeSchema.parse(body).error.code;
}

const wallet = {
  method: 'stellar_wallet',
  destination: { network: 'stellar:testnet', address: WALLET },
};

describe('GET /v1/embed/onboarding', () => {
  it("answers the token's own recipient to a page its project allows, and lets that page read it", async () => {
    const { token, lookup, send } = harness();
    const answer = await send('GET', '/v1/embed/onboarding', {
      authorization: `Bearer ${token}`,
      origin: SHOP,
    });
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({
      recipientId: lookup.recipientId,
      network: 'stellar:testnet',
      methods: ['stellar_wallet'],
      neverPayable: [ISSUER],
    });
    expect(answer.headers.get('access-control-allow-origin')).toBe(SHOP);
    expect(answer.headers.get('vary')).toBe('Origin');
  });

  it('answers the hosted invite page, which reads its own origin without sending Origin', async () => {
    const { token, send } = harness();
    const answer = await send('GET', '/v1/embed/onboarding', {
      authorization: `Bearer ${token}`,
      'sec-fetch-site': 'same-origin',
    });
    expect(answer.status).toBe(200);
    expect(answer.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('refuses a page its project did not allow, and that page cannot read why', async () => {
    const { token, send } = harness();
    const answer = await send('GET', '/v1/embed/onboarding', {
      authorization: `Bearer ${token}`,
      origin: 'https://evil.example.com',
    });
    expect([answer.status, codeOf(answer.body)]).toEqual([403, 'ORIGIN_NOT_ALLOWED']);
    expect(answer.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('refuses a token from no page at all, as one copied out of a page would be', async () => {
    const { token, send } = harness();
    const answer = await send('GET', '/v1/embed/onboarding', { authorization: `Bearer ${token}` });
    expect([answer.status, codeOf(answer.body)]).toEqual([403, 'ORIGIN_NOT_ALLOWED']);
  });

  it('refuses a revoked or lapsed token with a 401 the page can read, to say the link lapsed', async () => {
    const { token, live, send } = harness();
    live.value = false;
    const answer = await send('GET', '/v1/embed/onboarding', {
      authorization: `Bearer ${token}`,
      origin: SHOP,
    });
    expect([answer.status, codeOf(answer.body)]).toEqual([401, 'TOKEN_INVALID']);
    expect(answer.headers.get('access-control-allow-origin')).toBe(SHOP);
  });

  it('refuses an API key, a session cookie and no credential: only an embed token gets in', async () => {
    const { send } = harness();
    for (const headers of [
      { authorization: `Bearer ${issueToken('test').token}`, origin: SHOP },
      { cookie: 'ujira_session=abc', origin: APP },
      { origin: APP },
    ]) {
      const answer = await send('GET', '/v1/embed/onboarding', headers);
      expect([answer.status, codeOf(answer.body)]).toEqual([401, 'TOKEN_INVALID']);
    }
  });

  it('never reads a token from the query string', async () => {
    const { token, send } = harness();
    const answer = await send('GET', `/v1/embed/onboarding?token=${token}`, { origin: SHOP });
    expect(answer.status).toBe(401);
  });
});

describe('POST /v1/embed/recipients/{id}/methods', () => {
  it('saves a wallet for its own recipient', async () => {
    const { token, lookup, added, send } = harness();
    const answer = await send(
      'POST',
      `/v1/embed/recipients/${lookup.recipientId}/methods`,
      { authorization: `Bearer ${token}`, origin: SHOP },
      wallet,
    );
    expect(answer.status).toBe(201);
    expect(answer.body).toMatchObject({ method: 'stellar_wallet', status: 'active' });
    expect(added).toEqual([
      {
        recipientId: lookup.recipientId,
        destination: { network: 'stellar:testnet', address: WALLET, memo: undefined },
      },
    ]);
    expect(answer.headers.get('access-control-allow-origin')).toBe(SHOP);
  });

  it('reads any other recipient as not found', async () => {
    const { token, added, send } = harness();
    const answer = await send(
      'POST',
      `/v1/embed/recipients/${randomUUID()}/methods`,
      { authorization: `Bearer ${token}`, origin: SHOP },
      wallet,
    );
    expect([answer.status, codeOf(answer.body)]).toEqual([404, 'NOT_FOUND']);
    expect(added).toEqual([]);
  });

  it('refuses another method, and says why an address cannot be paid', async () => {
    const memo = harness({
      addWallet: () =>
        Promise.reject(new EmbedError('DESTINATION_INVALID', 'x', { reason: 'MEMO_UNSUPPORTED' })),
    });
    const headers = { authorization: `Bearer ${memo.token}`, origin: SHOP };
    const path = `/v1/embed/recipients/${memo.lookup.recipientId}/methods`;
    const other = await memo.send('POST', path, headers, { ...wallet, method: 'bank' });
    expect([other.status, codeOf(other.body)]).toEqual([422, 'DESTINATION_INVALID']);
    const needsMemo = await memo.send('POST', path, headers, {
      method: 'stellar_wallet',
      destination: { network: 'stellar:testnet', address: WALLET, memoType: 'id', memo: '42' },
    });
    expect(needsMemo.status).toBe(422);
    expect(errorEnvelopeSchema.parse(needsMemo.body).error).toMatchObject({
      code: 'DESTINATION_INVALID',
      reason: 'MEMO_UNSUPPORTED',
    });
  });

  it('refuses a body outside the contract before the service sees it', async () => {
    const { token, lookup, added, send } = harness();
    const path = `/v1/embed/recipients/${lookup.recipientId}/methods`;
    const headers = { authorization: `Bearer ${token}`, origin: SHOP };
    for (const body of [
      {},
      { method: 'stellar_wallet' },
      { ...wallet, extra: true },
      {
        method: 'stellar_wallet',
        destination: { ...wallet.destination, memoType: 'text', memo: 'x' },
      },
    ]) {
      expect((await send('POST', path, headers, body)).status).toBe(400);
    }
    expect(added).toEqual([]);
  });

  it('answers a chain outage and a recipient on hold with their codes', async () => {
    for (const [code, status, wire] of [
      ['CHAIN_UNAVAILABLE', 503, 'CHAIN_UNAVAILABLE'],
      ['RECIPIENT_SUSPENDED', 403, 'FORBIDDEN'],
    ] as const) {
      const h = harness({ addWallet: () => Promise.reject(new EmbedError(code, 'x')) });
      const answer = await h.send(
        'POST',
        `/v1/embed/recipients/${h.lookup.recipientId}/methods`,
        { authorization: `Bearer ${h.token}`, origin: SHOP },
        wallet,
      );
      expect([answer.status, codeOf(answer.body)]).toEqual([status, wire]);
    }
  });
});

describe('cross origin', () => {
  it('answers the preflight of the widget routes, and of no other route', async () => {
    const { send } = harness();
    for (const path of ['/v1/embed/onboarding', `/v1/embed/recipients/${randomUUID()}/methods`]) {
      const answer = await send('OPTIONS', path, {
        origin: SHOP,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization, content-type',
      });
      expect(answer.status).toBe(204);
      expect(answer.headers.get('access-control-allow-headers')).toContain('authorization');
      expect(answer.headers.get('access-control-allow-methods')).toBe('GET, POST');
    }
    const other = await send('OPTIONS', '/v1/embed/sessions', { origin: SHOP });
    expect(other.status).toBe(404);
    expect(other.headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('an embed token on any other route', () => {
  it('is not an API key, so it is refused before any lookup', async () => {
    const { token, send } = harness();
    const answer = await send(
      'POST',
      '/v1/embed/sessions',
      { authorization: `Bearer ${token}` },
      { recipientId: randomUUID() },
    );
    expect([answer.status, codeOf(answer.body)]).toEqual([401, 'TOKEN_MALFORMED']);
    expect(answer.headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('embedWidgetApiError', () => {
  it('passes anything that is not the service refusing through as it is', () => {
    const other = new Error('boom');
    expect(embedWidgetApiError(other)).toBe(other);
  });
});
