// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The /v1 idempotency pipeline against a real database, as the role the API
// runs as. What stops a duplicate across instances is the unique constraint on
// the principal, the project and the key, so the races here run on two pools,
// as two server instances would.

import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { z } from 'zod';

import {
  entryPoints,
  idempotencyKeys,
  projects,
  type Database,
  type ProjectContext,
} from '../db/index.js';
import {
  createTestDatabase,
  databaseAsServiceRoles,
  type TestDatabase,
} from '../db/testing/index.js';
import { createV1App } from './app.js';
import { ApiError, errorEnvelopeSchema } from './errors.js';
import { requestFingerprint } from './idempotency.js';
import { databaseIdempotencyStore } from './idempotency-store.js';
import { defineIdempotentRoute } from './route.js';

const adminUrl = inject('dbAdminUrl');
const roleUrls = inject('dbRoleUrls');

let database: TestDatabase;
let first: Database;
let second: Database;

beforeAll(async () => {
  database = await createTestDatabase(adminUrl, import.meta.url);
  first = databaseAsServiceRoles(roleUrls, database, 4);
  second = databaseAsServiceRoles(roleUrls, database, 4);
});

afterAll(async () => {
  await first.close();
  await second.close();
  await database.drop();
});

function wallet(): string {
  return `G${randomUUID().replace(/-/g, '').toUpperCase()}`;
}

async function newTenant(): Promise<ProjectContext> {
  const created = await first.unscoped((tx) =>
    entryPoints.createPrincipal(tx, { name: 'Tenant', projectName: 'Main', ownerWallet: wallet() }),
  );
  return { principalId: created.principalId, projectId: created.projectId };
}

async function siblingOf(tenant: ProjectContext): Promise<ProjectContext> {
  const projectId = await first
    .tenant(tenant)
    .transaction((tx) => projects.create(tx, { name: 'Second' }));
  return { principalId: tenant.principalId, projectId };
}

interface Counter {
  runs: number;
}

const BODY = { name: 'Ada' };

function instance(db: Database, tenant: ProjectContext, counter: Counter) {
  const route = defineIdempotentRoute({
    method: 'post',
    path: '/v1/things',
    operationId: 'createThing',
    summary: 'Create a thing',
    body: z.object({ name: z.string(), outage: z.boolean().optional() }).strict(),
    status: 202,
    response: z.object({ id: z.string(), run: z.number() }).strict(),
    idempotency: {
      store: databaseIdempotencyStore(db),
      authenticate: () => Promise.resolve(tenant),
      log: () => undefined,
    },
    handler: async ({ body }) => {
      counter.runs += 1;
      const run = counter.runs;
      // Long enough that the racers find it running, not finished.
      await new Promise((resolve) => setTimeout(resolve, 50));
      if (body.outage === true) throw new ApiError('CHAIN_UNAVAILABLE', 'Not answering');
      return { id: body.name, run };
    },
  });
  const { app } = createV1App({ routes: [route] });
  return (key: string, body: unknown = BODY): Promise<Response> =>
    Promise.resolve(
      app.request('/v1/things', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': key },
        body: JSON.stringify(body),
      }),
    );
}

describe('against the database', () => {
  it('a replay with the same body returns the stored status and body', async () => {
    const tenant = await newTenant();
    const counter = { runs: 0 };
    const post = instance(first, tenant, counter);
    const key = randomUUID();
    const original = await post(key);
    const repeated = await post(key);
    expect(original.status).toBe(202);
    expect(repeated.status).toBe(202);
    expect(repeated.headers.get('idempotent-replayed')).toBe('true');
    expect(await repeated.text()).toBe(await original.text());
    expect(counter.runs).toBe(1);
  });

  it('the same key with another body answers 422', async () => {
    const tenant = await newTenant();
    const post = instance(first, tenant, { runs: 0 });
    const key = randomUUID();
    await post(key, { name: 'Ada' });
    const response = await post(key, { name: 'Grace' });
    expect(response.status).toBe(422);
    expect(errorEnvelopeSchema.parse(await response.json()).error.code).toBe(
      'IDEMPOTENCY_KEY_REUSED',
    );
  });

  it('20 concurrent identical requests on two instances produce exactly one stored response', async () => {
    const tenant = await newTenant();
    const counter = { runs: 0 };
    const one = instance(first, tenant, counter);
    const two = instance(second, tenant, counter);
    const key = randomUUID();
    const responses = await Promise.all(
      Array.from({ length: 20 }, (_unused, index) => (index % 2 === 0 ? one : two)(key)),
    );
    expect(counter.runs).toBe(1);
    // One ran; each other found it running or found it finished.
    for (const response of responses) expect([202, 409]).toContain(response.status);
    const fresh = responses.filter(
      (r) => r.status === 202 && r.headers.get('idempotent-replayed') === null,
    );
    expect(fresh).toHaveLength(1);
    const answer = await fresh[0]?.text();

    // The row holds that one answer, and a later retry on either instance gets it.
    const stored = await first.tenant(tenant).transaction((tx) =>
      idempotencyKeys.reserve(tx, {
        key,
        requestSha256: requestFingerprint(
          'POST',
          new URL('http://localhost/v1/things'),
          Buffer.from(JSON.stringify(BODY)),
        ),
        leaseSeconds: 1,
      }),
    );
    expect(stored).toMatchObject({ kind: 'replay', status: 202, body: answer });
    expect(await (await two(key)).text()).toBe(answer);
  });

  it('keys are per project: one key in two projects and two principals is three requests', async () => {
    const alpha = await newTenant();
    const sibling = await siblingOf(alpha);
    const bravo = await newTenant();
    const key = randomUUID();
    const counters = [{ runs: 0 }, { runs: 0 }, { runs: 0 }];
    const answers = await Promise.all(
      [alpha, sibling, bravo].map(async (tenant, index) => {
        const counter = counters[index] ?? { runs: 0 };
        const response = await instance(first, tenant, counter)(key, { name: `t${index}` });
        return { status: response.status, replayed: response.headers.get('idempotent-replayed') };
      }),
    );
    expect(answers).toEqual([
      { status: 202, replayed: null },
      { status: 202, replayed: null },
      { status: 202, replayed: null },
    ]);
    expect(counters.map((c) => c.runs)).toEqual([1, 1, 1]);
  });

  it('runs again after a failure worth retrying, since the key was given back', async () => {
    const tenant = await newTenant();
    const counter = { runs: 0 };
    const post = instance(first, tenant, counter);
    const key = randomUUID();
    const body = { name: 'Ada', outage: true };
    expect((await post(key, body)).status).toBe(503);
    expect((await post(key, body)).status).toBe(503);
    expect(counter.runs).toBe(2);
  });
});
