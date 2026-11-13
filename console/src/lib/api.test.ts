// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

import { describe, expect, it, vi } from 'vitest';

import { ApiError, NETWORK_ERROR, createHttpApi, errorMessage } from './api';

function respond(status: number, body: unknown): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const ADDRESS = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
const MANDATE = 'CB4AYBA5NVQPVPNOWUCSZQK6ZIGOF7KSCS6SF6UV6D2OKPDXLHEPD4V7';

describe('createHttpApi', () => {
  it('GETs with the address encoded and returns the checked body', async () => {
    const fetchImpl = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(() =>
      Promise.resolve(
        respond(200, { address: ADDRESS, exists: true, xlm: '10000.0000000', usdc: null }),
      ),
    );
    const api = createHttpApi(fetchImpl);
    const account = await api.account(ADDRESS);
    expect(account).toMatchObject({ address: ADDRESS, exists: true, usdc: null });
    expect(fetchImpl).toHaveBeenCalledWith(`/api/accounts/${ADDRESS}`, {
      headers: { accept: 'application/json' },
    });
  });

  it('POSTs JSON for transaction building', async () => {
    const fetchImpl = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(() =>
      Promise.resolve(respond(200, { xdr: 'AAAA', description: 'Pause the mandate' })),
    );
    const api = createHttpApi(fetchImpl, 'https://example.test');
    const tx = await api.buildTx('pause', ADDRESS, { mandate: MANDATE });
    expect(tx).toEqual({ xdr: 'AAAA', description: 'Pause the mandate' });
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe('https://example.test/api/tx/build');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(init?.body as string)).toEqual({
      action: 'pause',
      source: ADDRESS,
      params: { mandate: MANDATE },
    });
  });

  it('unwraps list responses', async () => {
    const fetchImpl = vi.fn((url: string) =>
      Promise.resolve(
        url.endsWith('/payouts')
          ? respond(200, {
              payouts: [
                {
                  taskId: 't-1',
                  payoutId: 'ab',
                  recipient: ADDRESS,
                  recipientLabel: 'Ada',
                  amount: '120000000',
                  rail: 'usdc',
                  status: 'pending_approval',
                  at: '2026-11-13T10:00:00Z',
                },
              ],
            })
          : respond(200, {
              mandates: [{ id: MANDATE, createdAt: '2026-11-13T10:00:00Z', createTx: 'ff' }],
            }),
      ),
    );
    const api = createHttpApi(fetchImpl);
    expect(await api.mandates(ADDRESS)).toHaveLength(1);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(`/api/mandates?principal=${ADDRESS}`);
    const payouts = await api.payouts(MANDATE);
    expect(payouts[0]?.status).toBe('pending_approval');
  });

  it('turns the API error shape into an ApiError with its sentence', async () => {
    const api = createHttpApi(() =>
      Promise.resolve(
        respond(429, {
          error: { code: 'faucet_used', message: 'This wallet already received its test USDC.' },
        }),
      ),
    );
    const failure = await api.onboardUsdc(ADDRESS).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(ApiError);
    expect(failure).toMatchObject({
      code: 'faucet_used',
      status: 429,
      message: 'This wallet already received its test USDC. Each wallet gets it once.',
    });
  });

  it('keeps the server sentence for codes it has no words for', async () => {
    const api = createHttpApi(() =>
      Promise.resolve(
        respond(400, {
          error: { code: 'invalid_rules', message: 'The expiry must be within a year' },
        }),
      ),
    );
    await expect(api.buildTx('create_mandate', ADDRESS, {})).rejects.toMatchObject({
      code: 'invalid_rules',
      message: 'The expiry must be within a year.',
    });
  });

  it('turns contract reasons into plain words', async () => {
    const api = createHttpApi(() =>
      Promise.resolve(
        respond(400, { error: { code: 'mandate_paused', message: 'mandate_paused' } }),
      ),
    );
    await expect(
      api.quote(MANDATE, { recipient: 'Ada', amount: '1', rail: 'usdc' }),
    ).rejects.toMatchObject({
      message: 'The mandate is paused. Resume it to pay again.',
    });
  });

  it('tells the person to press Pay now again after a gateway timeout', async () => {
    const api = createHttpApi(() => Promise.resolve(respond(504, 'Gateway Timeout')));
    await expect(
      api.request(MANDATE, { recipient: 'Ada', amount: '1', rail: 'sdp', taskId: 't-3' }),
    ).rejects.toMatchObject({
      code: 'timeout',
      message: expect.stringMatching(/press Pay now again/) as unknown,
    });
  });

  it('gives a plain sentence when the error body is not JSON', async () => {
    const api = createHttpApi(() => Promise.resolve(respond(502, '<html>Bad gateway</html>')));
    await expect(api.config()).rejects.toMatchObject({
      code: 'server_error',
      message: 'The UJIRA server had a problem. Try again in a moment.',
    });
  });

  it('says when the server cannot be reached', async () => {
    const api = createHttpApi(() => Promise.reject(new TypeError('Failed to fetch')));
    await expect(api.config()).rejects.toMatchObject({ code: 'network', message: NETWORK_ERROR });
  });

  it('refuses a response in the wrong shape', async () => {
    const api = createHttpApi(() => Promise.resolve(respond(200, { address: ADDRESS, usdc: 12 })));
    await expect(api.account(ADDRESS)).rejects.toMatchObject({ code: 'bad_response' });
  });

  it('refuses amounts that are not integer strings', async () => {
    const api = createHttpApi(() =>
      Promise.resolve(respond(200, { address: ADDRESS, exists: true, xlm: '1', usdc: '1.5' })),
    );
    await expect(api.account(ADDRESS)).rejects.toMatchObject({ code: 'bad_response' });
  });

  it('keeps fields the server adds later', async () => {
    const api = createHttpApi(() =>
      Promise.resolve(
        respond(200, {
          task_id: 't-2',
          recipient: 'Ada',
          amount: '10000000',
          outcome: 'paid',
          tx_hash: 'a'.repeat(64),
          amount_display: '1.00 USDC',
        }),
      ),
    );
    const receipt = await api.request(MANDATE, {
      recipient: 'Ada',
      amount: '10000000',
      rail: 'usdc',
      taskId: 't-2',
    });
    expect(receipt['amount_display']).toBe('1.00 USDC');
  });
});

describe('errorMessage', () => {
  it('prefers the sentence of any error', () => {
    expect(errorMessage(new ApiError('x', 'Readable.', 400))).toBe('Readable.');
    expect(errorMessage(new Error('Plain.'))).toBe('Plain.');
    expect(errorMessage('weird')).toBe('Something went wrong. Try again.');
  });
});
