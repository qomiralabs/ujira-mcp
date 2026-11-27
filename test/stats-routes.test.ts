// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// GET /v1/stats/overview in front of an overview service held in memory, with
// real sign in and real API keys: who may read it, what the query accepts,
// and that the answer is the shape the console reads. The route on a real
// database is in test/stats-overview.db.test.ts.

import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { createV1App } from '../src/api/app.js';
import { createAuthenticate } from '../src/api/authenticate.js';
import { buildOpenApi } from '../src/api/openapi.js';
import { apiKeyRoutes } from '../src/api/routes/api-keys.js';
import { authRoutes } from '../src/api/routes/auth.js';
import { overviewSchema, statsRoutes } from '../src/api/routes/stats.js';
import { createApiKeyService } from '../src/auth/api-key-service.js';
import { SignIn } from '../src/auth/sign-in.js';
import { createTokenAuthenticator } from '../src/auth/token-auth.js';
import { DatabaseUnavailableError, type Mandate, type ProjectContext } from '../src/db/index.js';
import { tokenAmount } from '../src/money/index.js';
import {
  PeriodError,
  type Overview,
  type OverviewService,
  type PeriodRequest,
} from '../src/payouts/overview.js';
import { resolvePeriod } from '../src/payouts/overview-period.js';
import { codeOf, MemoryKeys, ProjectSignInStore, requestFor } from './api-key-helpers.js';
import {
  clientFor,
  ORIGIN,
  signInWith,
  START,
  verifier,
  wallet,
  type Clock,
} from './sign-in-helpers.js';

const NETWORK = 'stellar:testnet';

// The console's recorded answer for this route, as console/src/test/v1Recorded.ts holds it.
const RECORDED = {
  period: { from: '2026-11-01T00:00:00.000Z', to: '2026-11-26T00:00:00.000Z' },
  paid: [{ amount: '1225000000', asset: 'USDC', network: NETWORK, scale: 7 }],
  byStatus: { paid: 12, pending_approval: 1, blocked: 2 },
  approvalsWaiting: 1,
};

const MANDATE: Mandate = {
  id: '0b8f6a4c-58c3-4a3b-9f0e-6c1d2e3f4a5b',
  projectId: randomUUID(),
  name: 'Payroll',
  network: NETWORK,
  contractAddress: 'CB4AYBA5NVQPVPNOWUCSZQK6ZIGOF7KSCS6SF6UV6D2OKPDXLHEPD4V7',
  asset: 'USDC',
  scale: 7,
  agentKeyId: null,
  agentAddress: `G${'A'.repeat(55)}`,
  principalWallet: `G${'B'.repeat(55)}`,
  createdTxHash: null,
  createdAt: new Date(START),
};

interface Asked {
  readonly context: ProjectContext;
  readonly request: PeriodRequest;
  readonly correlationId: string;
}

function recordedOverview(request: PeriodRequest): Overview {
  return {
    period: resolvePeriod(request, 'Africa/Lagos', new Date(START)),
    paid: [{ network: NETWORK, amount: tokenAmount(1_225_000_000n, 'USDC', 'stellar') }],
    byStatus: { paid: 12, pending_approval: 1, blocked: 2 },
    blockedByRule: { DAILY_CAP_EXCEEDED: 2 },
    approvalsWaiting: 1,
    mandates: [
      {
        mandate: MANDATE,
        state: { balance: 5_000_000_000n, committed: 250_000_000n, free: 4_750_000_000n },
      },
      { mandate: { ...MANDATE, id: randomUUID(), name: 'Grants' }, state: null },
    ],
    moreMandates: false,
  };
}

function harness(
  answer: (request: PeriodRequest) => Promise<Overview> = (r) =>
    Promise.resolve(recordedOverview(r)),
) {
  const clock: Clock = { now: START };
  const now = () => new Date(clock.now);
  const sessions = new ProjectSignInStore(clock);
  const keys = new MemoryKeys(clock);
  const lines: string[] = [];
  const log = (line: string) => {
    lines.push(line);
  };
  const signIn = new SignIn({ store: sessions, verifier, origin: ORIGIN, log, now });
  const tokens = createTokenAuthenticator({ store: keys, environment: 'test', log, now });
  const keyService = createApiKeyService({
    records: keys,
    environment: 'test',
    onRevoked: (prefix) => {
      tokens.forget(prefix);
    },
    now,
  });
  const authenticate = createAuthenticate({ tokens, session: { signIn, origin: ORIGIN } });
  const asked: Asked[] = [];
  const overview: OverviewService = {
    overview: (context, request, correlationId) => {
      asked.push({ context, request, correlationId });
      return answer(request);
    },
  };
  const routes = [
    ...authRoutes({ signIn, origin: ORIGIN, now }),
    ...apiKeyRoutes({ keys: keyService, authenticate }),
    ...statsRoutes({ overview, authenticate }),
  ];
  const v1 = createV1App({ routes, log });
  const request = requestFor(v1.app);
  const call = clientFor(v1.app);

  async function member(role: string) {
    const kp = wallet();
    const principalId = randomUUID();
    const projectId = randomUUID();
    sessions.grant(kp.publicKey(), { principalId, name: 'Acme', role });
    const memberId = sessions.members.get(kp.publicKey()) ?? '';
    sessions.access.set(memberId, [{ principalId, projectId, role }]);
    const { token } = await signInWith(call, kp, { client: randomUUID() });
    if (token === undefined) throw new Error('sign in failed');
    return { principalId, projectId, cookie: token };
  }

  return { request, member, asked, lines, routes };
}

describe('GET /v1/stats/overview', () => {
  it("answers the console's recorded shape, with what it adds beside it", async () => {
    const h = harness();
    const owner = await h.member('owner');
    const answer = await h.request(
      'GET',
      '/v1/stats/overview?from=2026-11-01T00:00:00.000Z&to=2026-11-26T00:00:00.000Z',
      { cookie: owner.cookie, project: owner.projectId },
    );
    expect(answer.status).toBe(200);
    expect(answer.json).toMatchObject(RECORDED);
    expect(answer.json).toEqual({
      ...RECORDED,
      period: { ...RECORDED.period, timeZone: 'Africa/Lagos' },
      blockedByRule: { DAILY_CAP_EXCEEDED: 2 },
      mandates: [
        {
          id: MANDATE.id,
          contractId: MANDATE.contractAddress,
          name: 'Payroll',
          state: {
            balance: { amount: '5000000000', asset: 'USDC', network: NETWORK, scale: 7 },
            committed: { amount: '250000000', asset: 'USDC', network: NETWORK, scale: 7 },
            free: { amount: '4750000000', asset: 'USDC', network: NETWORK, scale: 7 },
          },
        },
        {
          id: expect.any(String) as unknown,
          contractId: MANDATE.contractAddress,
          name: 'Grants',
          state: null,
        },
      ],
      moreMandates: false,
    });
  });

  it("runs as the session's project, with the request id as the correlation id", async () => {
    const h = harness();
    const viewer = await h.member('viewer');
    const answer = await h.request('GET', '/v1/stats/overview', {
      cookie: viewer.cookie,
      project: viewer.projectId,
    });
    expect(answer.status).toBe(200);
    expect(h.asked).toEqual([
      {
        context: { principalId: viewer.principalId, projectId: viewer.projectId },
        request: { from: undefined, to: undefined },
        correlationId: answer.headers.get('ujira-request-id'),
      },
    ]);
  });

  it('reads the period from the query, with or without an offset', async () => {
    const h = harness();
    const owner = await h.member('owner');
    const answer = await h.request(
      'GET',
      `/v1/stats/overview?from=${encodeURIComponent('2026-11-01T00:00:00+01:00')}`,
      { cookie: owner.cookie, project: owner.projectId },
    );
    expect(answer.status).toBe(200);
    expect(h.asked[0]?.request).toEqual({
      from: new Date('2026-10-31T23:00:00.000Z'),
      to: undefined,
    });
  });

  it('refuses a period that is not one, naming where', async () => {
    const h = harness((request) => {
      try {
        return Promise.resolve(recordedOverview(request));
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error('failed'));
      }
    });
    const owner = await h.member('owner');
    const send = (query: string) =>
      h.request('GET', `/v1/stats/overview?${query}`, {
        cookie: owner.cookie,
        project: owner.projectId,
      });
    const backwards = await send('from=2026-11-26T00:00:00.000Z&to=2026-11-01T00:00:00.000Z');
    expect(backwards.status).toBe(400);
    expect(backwards.json?.['error']).toMatchObject({
      code: 'INVALID_REQUEST',
      details: [{ path: 'query.from', issue: 'from_not_before_to' }],
    });
    const long = await send('from=2024-01-01T00:00:00.000Z&to=2026-11-01T00:00:00.000Z');
    expect(long.json?.['error']).toMatchObject({
      code: 'INVALID_REQUEST',
      details: [{ path: 'query.to', issue: 'longer_than_max' }],
    });
    for (const bad of ['from=yesterday', 'to=2026-11-01', 'project=other', 'from=1&from=2']) {
      const refused = await send(bad);
      expect(refused.status).toBe(400);
      expect(codeOf(refused)).toBe('INVALID_REQUEST');
    }
  });

  it('refuses an API key whatever it holds, and a caller with no session', async () => {
    const h = harness();
    const owner = await h.member('owner');
    const created = await h.request('POST', '/v1/api-keys', {
      cookie: owner.cookie,
      project: owner.projectId,
      body: { name: 'Everything', scopes: ['payouts:read', 'mandates:read', 'receipts:read'] },
    });
    const key = String(created.json?.['secret']);
    const byKey = await h.request('GET', '/v1/stats/overview', { key });
    expect(byKey.status).toBe(403);
    expect(codeOf(byKey)).toBe('FORBIDDEN');
    const anonymous = await h.request('GET', '/v1/stats/overview');
    expect(anonymous.status).toBe(401);
    expect(codeOf(anonymous)).toBe('SESSION_INVALID');
    expect(h.asked).toEqual([]);
  });

  it('answers NOT_FOUND for a project the member cannot reach, and never asks for its figures', async () => {
    const h = harness();
    const owner = await h.member('owner');
    const other = await h.member('owner');
    const answer = await h.request('GET', '/v1/stats/overview', {
      cookie: owner.cookie,
      project: other.projectId,
    });
    expect(answer.status).toBe(404);
    expect(codeOf(answer)).toBe('NOT_FOUND');
    expect(h.asked).toEqual([]);
  });

  it('answers 503 when the database is down', async () => {
    const h = harness(() => Promise.reject(new DatabaseUnavailableError('connect')));
    const owner = await h.member('owner');
    const answer = await h.request('GET', '/v1/stats/overview', {
      cookie: owner.cookie,
      project: owner.projectId,
    });
    expect(answer.status).toBe(503);
    expect(codeOf(answer)).toBe('DB_UNAVAILABLE');
  });

  it('lets an error that is not about the period through as INTERNAL', async () => {
    const h = harness(() => Promise.reject(new TypeError('a bug')));
    const owner = await h.member('owner');
    const answer = await h.request('GET', '/v1/stats/overview', {
      cookie: owner.cookie,
      project: owner.projectId,
    });
    expect(answer.status).toBe(500);
    expect(codeOf(answer)).toBe('INTERNAL');
  });

  it('keeps a PeriodError typed for the route to translate', () => {
    expect(new PeriodError('longer_than_max', 'x').name).toBe('PeriodError');
  });

  it('publishes its schemas in the OpenAPI document', () => {
    const h = harness();
    const doc = buildOpenApi(h.routes, { title: 'UJIRA', version: '1' });
    const operation = doc.paths['/v1/stats/overview']?.['get'];
    expect(operation?.['operationId']).toBe('getOverview');
    expect(JSON.stringify(operation)).toContain('approvalsWaiting');
  });

  it('refuses an amount that is not whole minor units on the way out', () => {
    const wire = {
      period: { from: RECORDED.period.from, to: RECORDED.period.to, timeZone: 'UTC' },
      paid: [{ amount: '12.5', asset: 'USDC', network: NETWORK, scale: 7 }],
      byStatus: {},
      blockedByRule: {},
      approvalsWaiting: 0,
      mandates: [],
      moreMandates: false,
    };
    expect(overviewSchema.safeParse(wire).success).toBe(false);
    expect(overviewSchema.safeParse({ ...wire, paid: [] }).success).toBe(true);
    expect(overviewSchema.safeParse({ ...wire, paid: [], byStatus: { lost: 1 } }).success).toBe(
      false,
    );
  });
});
