// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// Every method of the idempotency, audit, outbox and fee sponsorship
// repositories, run as one
// tenant against another tenant's rows. Each case shows the call finds nothing,
// changes nothing, or lands on the caller's own tenant. The matrix fails when a
// method is added without a case.

import { createHash, randomUUID } from 'node:crypto';

import type { Kysely } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';

import type { Database, ProjectContext } from '../database.js';
import type { Schema } from '../schema.js';
import { insertTenant } from '../testing/admin-tenants.js';
import { caseProblems } from '../testing/cross-tenant.js';
import { databaseAsServiceRoles } from '../testing/databases.js';
import { createTestDatabase, type TestDatabase } from '../testing/harness.js';
import { audit, auditRepositories } from './audit.js';
import { feeSponsorshipRepositories, feeSponsorships } from './fee-sponsorships.js';
import { idempotencyKeys, idempotencyRepositories } from './idempotency.js';
import { outbox, outboxRepositories, webhookDeliveries, webhookEndpoints } from './outbox.js';

const adminUrl = inject('dbAdminUrl');
const roleUrls = inject('dbRoleUrls');

interface World {
  readonly tenant: ProjectContext;
  readonly outboxEventId: string;
  readonly endpointId: string;
}

let database: TestDatabase;
let admin: pg.Client;
let db: Database;
let a: World;
let b: World;

const REPOSITORIES = {
  ...auditRepositories,
  ...feeSponsorshipRepositories,
  ...idempotencyRepositories,
  ...outboxRepositories,
};

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

async function ownerOf(table: string, id: string): Promise<string | undefined> {
  const result = await admin.query<{ principal_id: string }>(
    `select principal_id from ${table} where id = $1`,
    [id],
  );
  return result.rows[0]?.principal_id;
}

// A tenant with one of everything: an event, an endpoint, a delivery and an
// audit row.
async function world(name: string): Promise<World> {
  const tenant = await insertTenant(admin, name);
  const made = await db.tenant(tenant).transaction(async (tx) => {
    const event = await outbox.append(tx, { eventType: 'payout.held', payload: {} });
    const endpoint = await webhookEndpoints.create(tx, {
      url: `https://example.com/${randomUUID()}`,
      secretRef: 'ref',
      eventTypes: ['payout.held'],
    });
    await webhookDeliveries.record(tx, {
      endpointId: endpoint.id,
      eventId: event.id,
      attempt: 1,
      status: 'failed',
    });
    await audit.record(tx, { action: 'api_key.created', actor: { kind: 'system' } });
    return { outboxEventId: event.id, endpointId: endpoint.id };
  });
  return { tenant, ...made };
}

const asA = async <T>(work: (tx: Kysely<Schema>) => Promise<T>): Promise<T> =>
  db.tenant(a.tenant).transaction(work);
const acrossA = async <T>(work: (tx: Kysely<Schema>) => Promise<T>): Promise<T> =>
  db.principal(a.tenant, 'app').transaction(work);

async function leaseHeldByB(key: string): Promise<string> {
  const held = await db
    .tenant(b.tenant)
    .transaction(async (tx) =>
      idempotencyKeys.reserve(tx, { key, requestSha256: Buffer.alloc(32, 1), leaseSeconds: 60 }),
    );
  if (held.kind !== 'started') throw new Error(`expected a lease, got ${held.kind}`);
  return held.leaseId;
}

const FEE_DAY = '2026-11-27';

const txHash = (): string => createHash('sha256').update(randomUUID()).digest('hex');

async function feeReservedByB(maxFee = 10n): Promise<string> {
  const innerTxHash = txHash();
  const held = await db
    .tenant(b.tenant)
    .transaction(async (tx) =>
      feeSponsorships.reserve(tx, { innerTxHash, day: FEE_DAY, maxFee, dailyCap: 1_000_000n }),
    );
  if (held.kind !== 'reserved') throw new Error(`expected a reservation, got ${held.kind}`);
  return innerTxHash;
}

async function feeDayOf(principalId: string): Promise<string | undefined> {
  const row = await admin.query<{ used: string }>(
    'select used_stroops::text as used from ujira.fee_sponsor_days where principal_id = $1 and day = $2',
    [principalId, FEE_DAY],
  );
  return row.rows[0]?.used;
}

async function feeStatusOf(innerTxHash: string): Promise<string[]> {
  const rows = await admin.query<{ status: string }>(
    "select status from ujira.fee_sponsorships where inner_tx_hash = decode($1, 'hex')",
    [innerTxHash],
  );
  return rows.rows.map((row) => row.status);
}

const cases: Record<string, () => Promise<void>> = {
  // The cap charged is the context's principal's: the same envelope reserved by
  // B is a new reservation for A, and B's day does not move.
  'feeSponsorships.reserve': async () => {
    const innerTxHash = await feeReservedByB();
    const before = await feeDayOf(b.tenant.principalId);
    const mine = await asA(async (tx) =>
      feeSponsorships.reserve(tx, { innerTxHash, day: FEE_DAY, maxFee: 7n, dailyCap: 1_000_000n }),
    );
    expect(mine.kind).toBe('reserved');
    expect(await feeDayOf(b.tenant.principalId)).toBe(before);
    const owners = await admin.query<{ principal_id: string }>(
      "select principal_id from ujira.fee_sponsorships where inner_tx_hash = decode($1, 'hex') order by 1",
      [innerTxHash],
    );
    expect(owners.rows.map((row) => row.principal_id)).toEqual(
      [a.tenant.principalId, b.tenant.principalId].sort(),
    );
  },
  'feeSponsorships.settle': async () => {
    const innerTxHash = await feeReservedByB();
    const before = await feeDayOf(b.tenant.principalId);
    expect(await asA(async (tx) => feeSponsorships.settle(tx, { innerTxHash, charged: 1n }))).toBe(
      false,
    );
    expect(await feeStatusOf(innerTxHash)).toEqual(['reserved']);
    expect(await feeDayOf(b.tenant.principalId)).toBe(before);
  },
  'feeSponsorships.release': async () => {
    const innerTxHash = await feeReservedByB();
    const before = await feeDayOf(b.tenant.principalId);
    expect(await asA(async (tx) => feeSponsorships.release(tx, { innerTxHash }))).toBe(false);
    expect(await feeStatusOf(innerTxHash)).toEqual(['reserved']);
    expect(await feeDayOf(b.tenant.principalId)).toBe(before);
  },
  // The chain a row joins comes from the context, so a writer can only ever
  // reach its own: B's head does not move, and the row lands on A.
  'audit.record': async () => {
    const head = 'select last_seq from ujira.audit_heads where principal_id = $1';
    const before = await admin.query(head, [b.tenant.principalId]);
    const written = await asA(async (tx) =>
      audit.record(tx, { action: 'project.routing_settings_changed', actor: { kind: 'system' } }),
    );
    expect(await ownerOf('ujira.audit_log', written.id)).toBe(a.tenant.principalId);
    expect((await admin.query(head, [b.tenant.principalId])).rows).toEqual(before.rows);
  },
  'audit.list': async () => {
    const page = await acrossA(async (tx) => audit.list(tx, { limit: 100 }));
    expect(page.items.length).toBeGreaterThan(0);
    const owners = await admin.query<{ principal_id: string }>(
      'select distinct principal_id from ujira.audit_log where id = any($1::uuid[])',
      [page.items.map((item) => item.id)],
    );
    expect(owners.rows).toEqual([{ principal_id: a.tenant.principalId }]);
  },
  'audit.verify': async () => {
    const counted = await admin.query<{ count: string }>(
      'select count(*)::text as count from ujira.audit_log where principal_id = $1',
      [a.tenant.principalId],
    );
    const verification = await acrossA(async (tx) => audit.verify(tx));
    expect(verification.rows.toString()).toBe(counted.rows[0]?.count);
    expect(verification.firstBreak).toBeNull();
  },
  'idempotencyKeys.reserve': async () => {
    // The same key in another tenant is a different key, however it was used.
    const key = randomUUID();
    await leaseHeldByB(key);
    const mine = await asA(async (tx) =>
      idempotencyKeys.reserve(tx, { key, requestSha256: Buffer.alloc(32, 2), leaseSeconds: 60 }),
    );
    expect(mine.kind).toBe('started');
    const owners = await admin.query<{ principal_id: string }>(
      'select principal_id from ujira.idempotency_keys where idempotency_key = $1 order by 1',
      [key],
    );
    expect(owners.rows.map((row) => row.principal_id)).toEqual(
      [a.tenant.principalId, b.tenant.principalId].sort(),
    );
  },
  'idempotencyKeys.complete': async () => {
    const key = randomUUID();
    const leaseId = await leaseHeldByB(key);
    expect(
      await asA(async (tx) =>
        idempotencyKeys.complete(tx, {
          key,
          leaseId,
          status: 201,
          requestId: 'req_intruder',
          body: '{}',
        }),
      ),
    ).toBe(false);
    const row = await admin.query<{ response_body: string | null }>(
      'select response_body from ujira.idempotency_keys where idempotency_key = $1',
      [key],
    );
    expect(row.rows).toEqual([{ response_body: null }]);
  },
  'idempotencyKeys.release': async () => {
    const key = randomUUID();
    const leaseId = await leaseHeldByB(key);
    expect(await asA(async (tx) => idempotencyKeys.release(tx, { key, leaseId }))).toBe(false);
    const row = await admin.query<{ running: boolean }>(
      'select lease_expires_at > now() as running from ujira.idempotency_keys where idempotency_key = $1',
      [key],
    );
    expect(row.rows).toEqual([{ running: true }]);
  },
  'outbox.append': async () => {
    const written = await asA(async (tx) =>
      outbox.append(tx, { eventType: 'payout.held', payload: {} }),
    );
    expect(await ownerOf('ujira.outbox_events', written.id)).toBe(a.tenant.principalId);
  },
  'outbox.after': async () => {
    // Under A's context nothing of B's is there to read, at any cursor. An event
    // shows only once every older transaction in the cluster has ended, and the
    // other test files share the cluster, so this waits as long as theirs take.
    await vi.waitFor(
      async () => {
        const events = await acrossA(async (tx) => outbox.after(tx, 0n, 100));
        const ids = events.map((event) => event.id);
        expect(ids).toContain(a.outboxEventId);
        expect(ids).not.toContain(b.outboxEventId);
      },
      { timeout: 30_000, interval: 200 },
    );
  },
  'webhookEndpoints.create': async () => {
    const created = await asA(async (tx) =>
      webhookEndpoints.create(tx, {
        url: `https://example.com/${randomUUID()}`,
        secretRef: 'ref',
        eventTypes: ['payout.held'],
      }),
    );
    expect(await ownerOf('ujira.webhook_endpoints', created.id)).toBe(a.tenant.principalId);
  },
  'webhookEndpoints.get': async () => {
    expect(await acrossA(async (tx) => webhookEndpoints.get(tx, b.endpointId))).toBeUndefined();
    expect(await acrossA(async (tx) => webhookEndpoints.get(tx, a.endpointId))).toBeDefined();
  },
  'webhookEndpoints.list': async () => {
    const page = await acrossA(async (tx) => webhookEndpoints.list(tx, { limit: 100 }));
    const ids = page.items.map((endpoint) => endpoint.id);
    expect(ids).toContain(a.endpointId);
    expect(ids).not.toContain(b.endpointId);
  },
  'webhookEndpoints.setStatus': async () => {
    expect(await asA(async (tx) => webhookEndpoints.setStatus(tx, b.endpointId, 'disabled'))).toBe(
      false,
    );
    const row = await admin.query<{ status: string }>(
      'select status from ujira.webhook_endpoints where id = $1',
      [b.endpointId],
    );
    expect(row.rows[0]?.status).toBe('enabled');
  },
  'webhookDeliveries.record': async () => {
    // B's event is out of sight, so nothing is recorded against it.
    expect(
      await asA(async (tx) =>
        webhookDeliveries.record(tx, {
          endpointId: a.endpointId,
          eventId: b.outboxEventId,
          attempt: 9,
          status: 'failed',
        }),
      ),
    ).toBeUndefined();
    // A's own event with B's endpoint fails the composite foreign key.
    const attempt = asA(async (tx) =>
      webhookDeliveries.record(tx, {
        endpointId: b.endpointId,
        eventId: a.outboxEventId,
        attempt: 9,
        status: 'failed',
      }),
    );
    expect(await codeOf(attempt)).toBe('23503');
  },
  'webhookDeliveries.forEvent': async () => {
    expect(
      await acrossA(async (tx) => webhookDeliveries.forEvent(tx, b.endpointId, b.outboxEventId)),
    ).toEqual([]);
    expect(
      await acrossA(async (tx) => webhookDeliveries.forEvent(tx, a.endpointId, a.outboxEventId)),
    ).toHaveLength(1);
  },
};

beforeAll(async () => {
  database = await createTestDatabase(adminUrl, import.meta.url);
  admin = new pg.Client({ connectionString: database.url });
  await admin.connect();
  db = databaseAsServiceRoles(roleUrls, database);
  a = await world('alpha');
  b = await world('bravo');
});

afterAll(async () => {
  await db.close();
  await admin.end();
  await database.drop();
});

describe('across tenants', () => {
  it('has a case for every repository method, and no case without one', () => {
    expect(caseProblems(REPOSITORIES, Object.keys(cases))).toEqual([]);
  });

  it.each(Object.keys(cases))('%s cannot reach another tenant', async (name) => {
    const run = cases[name];
    if (run === undefined) throw new Error(`no case named ${name}`);
    await run();
  });

  it('refuses a row written for another tenant, whatever the caller names', async () => {
    // The insert policy compares the row with the context, so naming B's ids
    // outright under A's context is refused rather than written.
    expect(
      await codeOf(
        asA(async (tx) =>
          tx
            .insertInto('ujira.outbox_events')
            .values({
              principal_id: b.tenant.principalId,
              project_id: b.tenant.projectId,
              event_type: 'payout.held',
              payload: '{}',
            })
            .execute(),
        ),
      ),
    ).toBe('42501');
  });
});
