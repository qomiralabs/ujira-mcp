// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

import { describe, expect, it } from 'vitest';

import { IDS, RECEIPTS_CSV, RECORDED, mandate, payout } from '../test/v1Recorded';
import { ApiError, NETWORK_ERROR, errorRequestId } from './api';
import { createHttpAuthApi } from './auth';
import { formatToken } from './money';
import {
  IDEMPOTENCY_HEADER,
  PROJECT_HEADER,
  createHttpV1Api,
  createV1Transport,
  retryAfterSeconds,
  type V1Api,
} from './v1';
import type { TokenAmount } from './v1Schemas';

interface Call {
  readonly url: string;
  readonly init: RequestInit;
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'Ujira-Request-Id': 'req-recorded', ...headers },
  });
}

function recorder(answer: (call: Call) => Response) {
  const calls: Call[] = [];
  const transport = createV1Transport((url, init) => {
    const call = { url, init: init ?? {} };
    calls.push(call);
    return Promise.resolve(answer(call));
  });
  return { api: createHttpV1Api(transport), transport, calls };
}

function headers(call: Call | undefined): Record<string, string> {
  return (call?.init.headers ?? {}) as Record<string, string>;
}

function sent(call: Call | undefined): unknown {
  return JSON.parse(call?.init.body as string);
}

const usdc = (amount: bigint): TokenAmount => ({
  amount,
  asset: 'USDC',
  network: 'stellar:testnet',
  scale: 7,
});

// Each route, the call that reaches it, and what the client hands back.
const ROUTES: readonly {
  readonly key: keyof typeof RECORDED;
  readonly method: string;
  readonly url: string;
  readonly run: (api: V1Api) => Promise<unknown>;
  readonly body?: unknown;
}[] = [
  {
    key: 'GET /v1/mandates',
    method: 'GET',
    url: '/v1/mandates?cursor=abc&limit=20',
    run: (a) => a.mandates({ cursor: 'abc', limit: 20 }),
  },
  {
    key: 'GET /v1/mandates/{id}',
    method: 'GET',
    url: `/v1/mandates/${IDS.mandate}`,
    run: (a) => a.mandate(IDS.mandate),
  },
  {
    key: 'POST /v1/mandates/prepare',
    method: 'POST',
    url: '/v1/mandates/prepare',
    run: (a) =>
      a.prepareMandate({
        approvers: [],
        approvalsRequired: 1,
        recipients: [],
        limits: {
          totalBudget: usdc(50_000_000_000n),
          perPaymentCap: usdc(5_000_000_000n),
          perRecipientDailyCap: usdc(10_000_000_000n),
          approvalThreshold: usdc(2_500_000_000n),
          payoutTtlSeconds: 86_400,
          expiresAt: '2027-02-20T09:00:00.000Z',
        },
      }),
    body: {
      approvers: [],
      approvalsRequired: 1,
      recipients: [],
      limits: {
        totalBudget: { amount: '50000000000', asset: 'USDC', network: 'stellar:testnet', scale: 7 },
        perPaymentCap: {
          amount: '5000000000',
          asset: 'USDC',
          network: 'stellar:testnet',
          scale: 7,
        },
        perRecipientDailyCap: {
          amount: '10000000000',
          asset: 'USDC',
          network: 'stellar:testnet',
          scale: 7,
        },
        approvalThreshold: {
          amount: '2500000000',
          asset: 'USDC',
          network: 'stellar:testnet',
          scale: 7,
        },
        payoutTtlSeconds: 86_400,
        expiresAt: '2027-02-20T09:00:00.000Z',
      },
    },
  },
  {
    key: 'POST /v1/mandates/import',
    method: 'POST',
    url: '/v1/mandates/import',
    run: (a) => a.importMandate(IDS.contract),
    body: { contractId: IDS.contract },
  },
  {
    key: 'POST /v1/mandates/{id}/actions',
    method: 'POST',
    url: `/v1/mandates/${IDS.mandate}/actions`,
    run: (a) => a.mandateAction(IDS.mandate, { kind: 'withdraw', amount: 15_000_000n }),
    body: { kind: 'withdraw', amount: '15000000' },
  },
  {
    key: 'POST /v1/signing/submit',
    method: 'POST',
    url: '/v1/signing/submit',
    run: (a) => a.submitSigned(IDS.signing, 'AAAAsigned'),
    body: { signingRequestId: IDS.signing, xdr: 'AAAAsigned' },
  },
  {
    key: 'GET /v1/recipients',
    method: 'GET',
    url: `/v1/recipients?limit=100&mandateId=${IDS.mandate}`,
    run: (a) => a.recipients({ limit: 100, mandateId: IDS.mandate }),
  },
  {
    key: 'GET /v1/recipients/{id}',
    method: 'GET',
    url: `/v1/recipients/${IDS.recipient}`,
    run: (a) => a.recipient(IDS.recipient),
  },
  {
    key: 'POST /v1/recipients',
    method: 'POST',
    url: '/v1/recipients',
    run: (a) =>
      a.createRecipient({ label: 'Ada', address: IDS.principalAddress, mandateId: IDS.mandate }),
    body: { label: 'Ada', address: IDS.principalAddress, mandateId: IDS.mandate },
  },
  {
    key: 'GET /v1/embed/sessions',
    method: 'GET',
    url: `/v1/embed/sessions?limit=20&recipientId=${IDS.recipient}`,
    run: (a) => a.embedSessions({ recipientId: IDS.recipient, limit: 20 }),
  },
  {
    key: 'POST /v1/embed/sessions',
    method: 'POST',
    url: '/v1/embed/sessions',
    run: (a) => a.createEmbedSession({ recipientId: IDS.recipient, expiresInSeconds: 86_400 }),
    body: { recipientId: IDS.recipient, expiresInSeconds: 86_400 },
  },
  {
    key: 'POST /v1/payouts',
    method: 'POST',
    url: '/v1/payouts',
    run: (a) =>
      a.createPayout(
        {
          mandateId: IDS.mandate,
          recipientId: IDS.recipient,
          amount: usdc(25_000_000n),
          taskId: 'task-42',
          metadata: { batch: 'week-48' },
        },
        '7c1d0b2e-run-42',
      ),
    body: {
      mandateId: IDS.mandate,
      recipientId: IDS.recipient,
      amount: { amount: '25000000', asset: 'USDC', network: 'stellar:testnet', scale: 7 },
      taskId: 'task-42',
      metadata: { batch: 'week-48' },
    },
  },
  {
    key: 'GET /v1/payouts',
    method: 'GET',
    url: `/v1/payouts?status=paid%2Cblocked&mandateId=${IDS.mandate}&createdFrom=2026-11-01T00%3A00%3A00Z`,
    run: (a) =>
      a.payouts({
        status: 'paid,blocked',
        mandateId: IDS.mandate,
        recipientId: undefined,
        createdFrom: '2026-11-01T00:00:00Z',
      }),
  },
  {
    key: 'GET /v1/payouts/{id}',
    method: 'GET',
    url: `/v1/payouts/${IDS.payout}`,
    run: (a) => a.payout(IDS.payout),
  },
  { key: 'GET /v1/approvals', method: 'GET', url: '/v1/approvals', run: (a) => a.approvals() },
  {
    key: 'GET /v1/receipts',
    method: 'GET',
    url: `/v1/receipts?recipientId=${IDS.recipient}`,
    run: (a) => a.receipts({ recipientId: IDS.recipient }),
  },
  {
    key: 'GET /v1/receipts/{id}',
    method: 'GET',
    url: `/v1/receipts/${IDS.receipt}`,
    run: (a) => a.receipt(IDS.receipt),
  },
  {
    key: 'GET /v1/receipts/{id}/verify',
    method: 'GET',
    url: `/v1/receipts/${IDS.receipt}/verify`,
    run: (a) => a.verifyReceipt(IDS.receipt),
  },
  { key: 'GET /v1/api-keys', method: 'GET', url: '/v1/api-keys', run: (a) => a.apiKeys() },
  {
    key: 'POST /v1/api-keys',
    method: 'POST',
    url: '/v1/api-keys',
    run: (a) => a.createApiKey({ name: 'Payroll runner', scopes: ['payouts:read'] }),
    body: { name: 'Payroll runner', scopes: ['payouts:read'] },
  },
  {
    key: 'GET /v1/stats/overview',
    method: 'GET',
    url: '/v1/stats/overview?from=2026-11-01T00%3A00%3A00.000Z',
    run: (a) => a.overview({ from: '2026-11-01T00:00:00.000Z' }),
  },
];

describe('the /v1 client, against recorded answers', () => {
  it('covers every recorded route', () => {
    expect(new Set(ROUTES.map((r) => r.key))).toEqual(new Set(Object.keys(RECORDED)));
  });

  for (const route of ROUTES) {
    it(`${route.key} sends the right request and parses the answer`, async () => {
      const { api, transport, calls } = recorder(() => json(200, RECORDED[route.key]));
      transport.useProject(IDS.project);
      const result = await route.run(api);
      expect(result).toBeDefined();
      const call = calls[0];
      expect(calls).toHaveLength(1);
      expect(call?.url).toBe(route.url);
      expect(call?.init.method).toBe(route.method);
      expect(call?.init.credentials).toBe('same-origin');
      expect(headers(call)[PROJECT_HEADER]).toBe(IDS.project);
      expect(headers(call).accept).toBe('application/json');
      if (route.body === undefined) {
        expect(call?.init.body).toBeUndefined();
      } else {
        expect(headers(call)['content-type']).toBe('application/json');
        expect(sent(call)).toEqual(route.body);
      }
    });
  }

  it('reads what a recipient can be paid, and an email only on its own page', async () => {
    const { api } = recorder((c) =>
      json(
        200,
        c.url.endsWith(IDS.recipient)
          ? RECORDED['GET /v1/recipients/{id}']
          : RECORDED['GET /v1/recipients'],
      ),
    );
    const [listed] = (await api.recipients()).items;
    expect(listed).toMatchObject({ mandateId: IDS.mandate, status: 'active', payable: true });
    expect(listed?.email).toBeUndefined();
    expect((await api.recipient(IDS.recipient)).email).toBe('ada@example.com');
  });

  it('refuses a recipient answer without the payable flag', async () => {
    const { recipient } = RECORDED['GET /v1/recipients/{id}'];
    const without = Object.fromEntries(Object.entries(recipient).filter(([k]) => k !== 'payable'));
    const { api } = recorder(() => json(200, { recipient: without }));
    await expect(api.recipient(IDS.recipient)).rejects.toMatchObject({ code: 'bad_response' });
  });

  it('revokes an invite link with a DELETE and no body', async () => {
    const { api, calls } = recorder(() => new Response(null, { status: 204 }));
    await api.revokeEmbedSession(IDS.invite);
    expect(calls[0]?.url).toBe(`/v1/embed/sessions/${IDS.invite}`);
    expect(calls[0]?.init.method).toBe('DELETE');
    expect(calls[0]?.init.body).toBeUndefined();
  });

  it('refuses an invite token that would not survive in a link', async () => {
    const created = RECORDED['POST /v1/embed/sessions'];
    const { api } = recorder(() => json(200, { ...created, token: 'ujes test <b>' }));
    await expect(
      api.createEmbedSession({ recipientId: IDS.recipient, expiresInSeconds: 3600 }),
    ).rejects.toMatchObject({ code: 'bad_response' });
  });

  it('sends the idempotency key only on payout creation', async () => {
    const { api, calls } = recorder((c) =>
      json(
        200,
        c.init.method === 'POST' ? RECORDED['POST /v1/payouts'] : RECORDED['GET /v1/payouts'],
      ),
    );
    await api.createPayout(
      { mandateId: IDS.mandate, recipientId: IDS.recipient, amount: usdc(1n), taskId: 't' },
      'run-42',
    );
    await api.payouts();
    expect(headers(calls[0])[IDEMPOTENCY_HEADER]).toBe('run-42');
    expect(headers(calls[1])[IDEMPOTENCY_HEADER]).toBeUndefined();
  });

  it('keeps amounts as bigint from the minor unit strings, past what a number holds', async () => {
    const { api } = recorder(() => json(200, RECORDED['GET /v1/payouts']));
    const page = await api.payouts();
    const [paid, pending] = page.items;
    expect(paid?.amount.amount).toBe(25_000_000n);
    expect(pending?.amount.amount).toBe(300_000_000_000_000_000_000_000_000_000_000_000_001n);
    expect(typeof pending?.legs[0]?.amount.amount).toBe('bigint');
    expect(page.nextCursor).toBeNull();
  });

  it('formats a /v1 amount with the one formatter, in its own scale and asset', async () => {
    const { api } = recorder(() => json(200, RECORDED['GET /v1/mandates/{id}']));
    const m = await api.mandate(IDS.mandate);
    expect(formatToken(m.state.balance)).toBe('2,000.00 USDC');
    expect(formatToken(m.config.limits.approvalThreshold)).toBe('250.00 USDC');
    expect(formatToken({ ...usdc(1n), scale: 2, asset: 'EURC' })).toBe('0.01 EURC');
    expect(formatToken(usdc(300_000_000_000_000_000_000_000_000_000_000_000_001n))).toBe(
      '30,000,000,000,000,000,000,000,000,000,000.0000001 USDC',
    );
  });

  it('keeps fields a later server adds', async () => {
    const { api } = recorder(() => json(200, RECORDED['GET /v1/mandates/{id}']));
    const m = await api.mandate(IDS.mandate);
    expect(m['label']).toBe('Week 48 payouts');
  });

  it('reads a CSV export as text, and only from a CSV answer', async () => {
    const csv = recorder(
      () =>
        new Response(RECEIPTS_CSV, {
          status: 200,
          headers: { 'content-type': 'text/csv; charset=utf-8' },
        }),
    );
    expect(await csv.api.receiptsCsv({ status: 'paid' })).toBe(RECEIPTS_CSV);
    expect(csv.calls[0]?.url).toBe('/v1/receipts/export.csv?status=paid');

    const html = recorder(
      () =>
        new Response('<html>login</html>', {
          status: 200,
          headers: { 'content-type': 'text/html', 'Ujira-Request-Id': 'req-html' },
        }),
    );
    await expect(html.api.receiptsCsv()).rejects.toMatchObject({
      code: 'bad_response',
      requestId: 'req-html',
    });
  });

  it('revokes a key with DELETE and no body', async () => {
    const { api, calls } = recorder(() => new Response(null, { status: 204 }));
    await expect(api.revokeApiKey(IDS.runner)).resolves.toBeUndefined();
    expect(calls[0]?.init.method).toBe('DELETE');
    expect(calls[0]?.url).toBe(`/v1/api-keys/${IDS.runner}`);
  });
});

describe('the /v1 client when the answer is not what it expects', () => {
  it('refuses a mismatch with the request id and none of the data', async () => {
    const secretish = 'ujk_test_should_never_reach_the_screen';
    const { api } = recorder(() =>
      json(200, { payout: { ...payout, amount: { ...payout.amount, amount: 12.5 } }, secretish }),
    );
    const error = await api.payout(IDS.payout).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ code: 'bad_response', requestId: 'req-recorded' });
    expect((error as ApiError).message).toBe(
      'The server sent an answer in a shape we did not expect.',
    );
    expect(JSON.stringify(error)).not.toContain(secretish);
    expect((error as ApiError).message).not.toContain('12.5');
  });

  it('refuses an amount that is not an integer string', async () => {
    for (const amount of ['1.5', '-1', '01', '', '1e9', '1'.repeat(40)]) {
      const { api } = recorder(() =>
        json(200, {
          mandate: {
            ...mandate,
            state: { ...mandate.state, balance: { ...mandate.state.balance, amount } },
          },
        }),
      );
      await expect(api.mandate(IDS.mandate)).rejects.toMatchObject({ code: 'bad_response' });
    }
  });

  it('refuses a payout with no legs', async () => {
    const { api } = recorder(() => json(200, { payout: { ...payout, legs: [] } }));
    await expect(api.payout(IDS.payout)).rejects.toMatchObject({ code: 'bad_response' });
  });

  it('says so when the body is not JSON, with the request id', async () => {
    const { api } = recorder(
      () => new Response('oops', { status: 200, headers: { 'Ujira-Request-Id': 'req-7' } }),
    );
    const error = await api.approvals().catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'bad_response', requestId: 'req-7' });
    expect(errorRequestId(error)).toBe('req-7');
  });

  it('drops a request id that does not look like one', async () => {
    const { api } = recorder(
      () =>
        new Response('{}', {
          status: 200,
          headers: { 'content-type': 'application/json', 'Ujira-Request-Id': '<script>x</script>' },
        }),
    );
    const error = await api.approvals().catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'bad_response', requestId: undefined });
  });
});

describe('the /v1 error envelope', () => {
  it('reads the code and the request id, with a sentence a person can act on', async () => {
    const { api } = recorder(() =>
      json(409, {
        error: { code: 'TASK_ID_REUSED', message: 'task reused', requestId: 'req-env' },
      }),
    );
    const error = await api
      .createPayout(
        { mandateId: IDS.mandate, recipientId: IDS.recipient, amount: usdc(1n), taskId: 't' },
        'k',
      )
      .catch((e: unknown) => e);
    expect(error).toMatchObject({
      code: 'TASK_ID_REUSED',
      status: 409,
      requestId: 'req-env',
      message: 'This task already has a payout on this mandate. Use a new task ID.',
    });
  });

  it('falls back to the header request id when the envelope has none', async () => {
    const { api } = recorder(() =>
      json(404, { error: { code: 'NOT_FOUND', message: 'No such payout' } }),
    );
    await expect(api.payout('x')).rejects.toMatchObject({
      code: 'NOT_FOUND',
      requestId: 'req-recorded',
    });
  });

  it('keeps the server message for a code it has no sentence for', async () => {
    const { api } = recorder(() =>
      json(400, {
        error: { code: 'INVALID_REQUEST', message: 'The body is not valid', requestId: 'r' },
      }),
    );
    await expect(api.recipients()).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
      message: 'The body is not valid',
    });
  });

  it('says how long to wait on a 429, from Retry-After in seconds', async () => {
    const { api } = recorder(() =>
      json(
        429,
        { error: { code: 'RATE_LIMITED', message: 'Too many requests', requestId: 'req-429' } },
        { 'Retry-After': '120' },
      ),
    );
    const error = await api.payouts().catch((e: unknown) => e);
    expect(error).toMatchObject({
      code: 'RATE_LIMITED',
      status: 429,
      retryAfterSeconds: 120,
      requestId: 'req-429',
      message: 'Too many tries in a short time. Try again in about 2 minutes.',
    });
  });

  it('says how long to wait on a bare 429 too', async () => {
    const { api } = recorder(
      () => new Response(null, { status: 429, headers: { 'Retry-After': '20' } }),
    );
    await expect(api.payouts()).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      retryAfterSeconds: 20,
      message: 'Too many tries in a short time. Try again in less than a minute.',
    });
  });

  it('asks for a minute when a 429 does not say how long', async () => {
    const { api } = recorder(() => new Response(null, { status: 429 }));
    await expect(api.payouts()).rejects.toMatchObject({
      retryAfterSeconds: undefined,
      message: 'Too many tries in a short time. Wait a minute and try again.',
    });
  });

  it('reads Retry-After as seconds or as a date', () => {
    const now = Date.parse('2026-11-26T10:00:00Z');
    expect(retryAfterSeconds('90', now)).toBe(90);
    expect(retryAfterSeconds('Thu, 26 Nov 2026 10:05:00 GMT', now)).toBe(300);
    expect(retryAfterSeconds('Thu, 26 Nov 2026 09:00:00 GMT', now)).toBe(0);
    expect(retryAfterSeconds('soon', now)).toBeUndefined();
    expect(retryAfterSeconds(null, now)).toBeUndefined();
  });

  it('turns a server failure without a body into a plain sentence', async () => {
    const { api } = recorder(() => new Response('<html>502</html>', { status: 502 }));
    await expect(api.overview()).rejects.toMatchObject({
      code: 'INTERNAL',
      message: 'The UJIRA server had a problem. Try again in a moment.',
    });
  });

  it('says when the server cannot be reached', async () => {
    const api = createHttpV1Api(createV1Transport(() => Promise.reject(new TypeError('offline'))));
    await expect(api.mandates()).rejects.toMatchObject({ code: 'network', message: NETWORK_ERROR });
  });
});

describe('a lost session', () => {
  it('tells every listener on a 401 from any route, then stops when unsubscribed', async () => {
    const { api, transport } = recorder(() =>
      json(401, { error: { code: 'SESSION_INVALID', message: 'no session', requestId: 'r' } }),
    );
    let lost = 0;
    const off = transport.onSessionLost(() => {
      lost += 1;
    });
    await expect(api.payouts()).rejects.toMatchObject({ code: 'SESSION_INVALID', status: 401 });
    await expect(api.receipt(IDS.receipt)).rejects.toMatchObject({ code: 'SESSION_INVALID' });
    expect(lost).toBe(2);
    off();
    await api.payouts().catch(() => undefined);
    expect(lost).toBe(2);
  });

  it('does not count other refusals as a lost session', async () => {
    const { api, transport } = recorder(() =>
      json(403, { error: { code: 'FORBIDDEN', message: 'no', requestId: 'r' } }),
    );
    let lost = 0;
    transport.onSessionLost(() => {
      lost += 1;
    });
    await api.createApiKey({ name: 'k', scopes: [] }).catch(() => undefined);
    expect(lost).toBe(0);
  });

  it('shares the transport with sign in, so both name the same project and hear the same 401', async () => {
    const calls: Call[] = [];
    const transport = createV1Transport((url, init) => {
      calls.push({ url, init: init ?? {} });
      return Promise.resolve(
        url === '/v1/projects'
          ? json(200, { projects: [] })
          : json(401, { error: { code: 'SESSION_INVALID', message: 'x', requestId: 'r' } }),
      );
    });
    const auth = createHttpAuthApi(transport);
    const api = createHttpV1Api(transport);
    let lost = 0;
    auth.onSessionLost(() => {
      lost += 1;
    });
    auth.useProject(IDS.project);
    await auth.projects();
    await api.approvals().catch(() => undefined);
    expect(headers(calls[1])[PROJECT_HEADER]).toBe(IDS.project);
    expect(lost).toBe(1);
  });
});
