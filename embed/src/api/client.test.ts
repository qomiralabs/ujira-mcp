// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

import { describe, expect, it } from 'vitest';

import { ApiProblem, ApiUnreachable, httpClient, isExpiry, problemOf } from './client.js';
import { WalletChallenge } from './contract.js';

interface Sent {
  url: string;
  method: string;
  headers: Headers;
  body: unknown;
  credentials: RequestCredentials | undefined;
}

function server(status: number, answer: unknown): { sent: Sent[]; fetch: typeof fetch } {
  const sent: Sent[] = [];
  const fake = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    sent.push({
      url: typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      credentials: init?.credentials,
    });
    const body = typeof answer === 'string' ? answer : JSON.stringify(answer);
    return Promise.resolve(new Response(body, { status }));
  };
  return { sent, fetch: fake };
}

const SESSION = {
  recipientId: 'r-1',
  network: 'stellar:testnet',
  methods: ['stellar_wallet', 'mobile_money'],
  neverPayable: [],
  somethingAddedLater: true,
};

async function rejection(work: Promise<unknown>): Promise<unknown> {
  try {
    await work;
  } catch (error) {
    return error;
  }
  throw new Error('it did not reject');
}

describe('the HTTP client', () => {
  it('sends the embed token, never cookies, and reads the session leniently', async () => {
    const { sent, fetch } = server(200, SESSION);
    const client = httpClient({ baseUrl: 'https://ujira.co/', token: 'ujes_test_1', fetch });
    const session = await client.session();
    expect(session).toEqual({
      recipientId: 'r-1',
      network: 'stellar:testnet',
      methods: ['stellar_wallet', 'mobile_money'],
      neverPayable: [],
    });
    expect(sent[0]?.url).toBe('https://ujira.co/v1/embed/onboarding');
    expect(sent[0]?.headers.get('authorization')).toBe('Bearer ujes_test_1');
    expect(sent[0]?.credentials).toBe('omit');
  });

  it('sends only the fields of a destination, with the memo as an id', async () => {
    const { sent, fetch } = server(201, { id: 'm-1', method: 'stellar_wallet', status: 'active' });
    const client = httpClient({ baseUrl: 'https://ujira.co', token: 't', fetch });
    await client.addMethod('r/1', {
      method: 'stellar_wallet',
      destination: { network: 'stellar:testnet', address: 'GABC', memo: '7', extra: 1 } as never,
    });
    expect(sent[0]?.url).toBe('https://ujira.co/v1/embed/recipients/r%2F1/methods');
    expect(sent[0]?.headers.get('content-type')).toBe('application/json');
    expect(sent[0]?.body).toEqual({
      method: 'stellar_wallet',
      destination: { network: 'stellar:testnet', address: 'GABC', memoType: 'id', memo: '7' },
    });
  });

  it('calls the challenge and proof routes for the saved method', async () => {
    const challenge = { challengeId: 'c', message: 'm', nonce: 'n', expiresAt: 'e' };
    const asked = server(201, challenge);
    const client = httpClient({ baseUrl: 'https://ujira.co', token: 't', fetch: asked.fetch });
    await expect(client.createWalletChallenge('r', 'm-1')).resolves.toEqual(challenge);
    expect(asked.sent[0]?.url).toBe(
      'https://ujira.co/v1/embed/recipients/r/methods/m-1/wallet-challenges',
    );
    const proved = server(201, { verificationId: 'v', level: 'wallet_signature' });
    const again = httpClient({ baseUrl: 'https://ujira.co', token: 't', fetch: proved.fetch });
    await again.submitWalletProof('r', 'm-1', {
      challengeId: 'c',
      message: 'm',
      nonce: 'n',
      signature: 's',
    });
    expect(proved.sent[0]?.url).toBe(
      'https://ujira.co/v1/embed/recipients/r/methods/m-1/wallet-proofs',
    );
    expect(proved.sent[0]?.body).toEqual({
      challengeId: 'c',
      message: 'm',
      nonce: 'n',
      signature: 's',
    });
  });

  it('turns the error envelope into a problem with the status, code and reason', async () => {
    const { fetch } = server(422, {
      error: {
        code: 'DESTINATION_NOT_RECEIVABLE',
        message: 'No trustline',
        reason: 'NO_TRUSTLINE',
        requestId: 'req_1',
      },
    });
    const client = httpClient({ baseUrl: 'https://ujira.co', token: 't', fetch });
    const error = await rejection(client.session());
    expect(error).toBeInstanceOf(ApiProblem);
    expect(problemOf(error)).toEqual({
      status: 422,
      code: 'DESTINATION_NOT_RECEIVABLE',
      reason: 'NO_TRUSTLINE',
      requestId: 'req_1',
    });
    expect(isExpiry(error)).toBe(false);
  });

  it('reads a 401 as an expired token', async () => {
    const { fetch } = server(401, { error: { code: 'TOKEN_INVALID', message: 'no' } });
    const client = httpClient({ baseUrl: 'https://ujira.co', token: 't', fetch });
    expect(isExpiry(await rejection(client.session()))).toBe(true);
  });

  it('refuses an answer outside the contract, and an error without the envelope', async () => {
    const wrong = server(200, { recipientId: 'r' });
    const client = httpClient({ baseUrl: 'https://ujira.co', token: 't', fetch: wrong.fetch });
    expect(await rejection(client.session())).toBeInstanceOf(ApiUnreachable);
    const html = server(502, '<html>Bad gateway</html>');
    const other = httpClient({ baseUrl: 'https://ujira.co', token: 't', fetch: html.fetch });
    expect(await rejection(other.session())).toBeInstanceOf(ApiUnreachable);
  });

  it('says so when the request never reached UJIRA', async () => {
    const offline = (() => Promise.reject(new TypeError('Failed to fetch'))) as typeof fetch;
    const client = httpClient({ baseUrl: 'https://ujira.co', token: 't', fetch: offline });
    expect(await rejection(client.session())).toBeInstanceOf(ApiUnreachable);
  });
});

describe('the contract', () => {
  it('refuses empty and oversized text', () => {
    expect(
      WalletChallenge.safeParse({ challengeId: '', message: 'm', nonce: 'n', expiresAt: 'e' })
        .success,
    ).toBe(false);
    expect(
      WalletChallenge.safeParse({
        challengeId: 'c',
        message: 'x'.repeat(4_097),
        nonce: 'n',
        expiresAt: 'e',
      }).success,
    ).toBe(false);
  });
});
