// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// What the retention role can reach in the tenant tables. It has no tenant
// context, so the policies alone keep it to rows past their window, and its
// column grants keep it from what those rows say.

import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import type { Database, ProjectContext } from '../database.js';
import { insertTenant } from '../testing/admin-tenants.js';
import { databaseAsServiceRoles } from '../testing/databases.js';
import { createTestDatabase, type TestDatabase } from '../testing/harness.js';
import { idempotencyKeys } from './idempotency.js';
import { outbox, webhookDeliveries, webhookEndpoints } from './outbox.js';

const adminUrl = inject('dbAdminUrl');
const roleUrls = inject('dbRoleUrls');

let database: TestDatabase;
let admin: pg.Client;
let db: Database;
let tenant: ProjectContext;

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

// The role cannot log in, so the test becomes it for one transaction, as a
// function it owns would. The work is rolled back unless it says otherwise.
async function asRetention<T>(work: () => Promise<T>, keep = false): Promise<T> {
  await admin.query('begin');
  try {
    await admin.query('set local role ujira_retention');
    const result = await work();
    await admin.query(keep ? 'commit' : 'rollback');
    return result;
  } catch (error) {
    await admin.query('rollback');
    throw error;
  }
}

async function ids(table: string): Promise<string[]> {
  return (await admin.query<{ id: string }>(`select id from ${table} order by id`)).rows.map(
    (row) => row.id,
  );
}

beforeAll(async () => {
  database = await createTestDatabase(adminUrl, import.meta.url);
  admin = new pg.Client({ connectionString: database.url });
  await admin.connect();
  db = databaseAsServiceRoles(roleUrls, database);
  tenant = await insertTenant(admin, 'Kept');
});

afterAll(async () => {
  await db.close();
  await admin.end();
  await database.drop();
});

describe('idempotency keys', () => {
  it('sees and removes only rows past their window', async () => {
    const live = randomUUID();
    const expired = randomUUID();
    for (const key of [live, expired]) {
      await db.tenant(tenant).transaction(async (tx) =>
        idempotencyKeys.reserve(tx, {
          key,
          requestSha256: Buffer.alloc(32, 3),
          leaseSeconds: 60,
        }),
      );
    }
    await admin.query(
      `update ujira.idempotency_keys set expires_at = now() - interval '1 second'
        where idempotency_key = $1`,
      [expired],
    );
    const seen = await asRetention(async () =>
      admin.query<{ id: string }>('select id from ujira.idempotency_keys'),
    );
    expect(seen.rows).toHaveLength(1);
    await asRetention(async () => admin.query('delete from ujira.idempotency_keys'), true);
    const left = await admin.query<{ key: string }>(
      'select idempotency_key as key from ujira.idempotency_keys',
    );
    expect(left.rows.map((row) => row.key)).toEqual([live]);
  });

  it('cannot read the stored answer, even of an expired row', async () => {
    expect(
      await codeOf(
        asRetention(async () => admin.query('select response_body from ujira.idempotency_keys')),
      ),
    ).toBe('42501');
  });
});

describe('the outbox and deliveries', () => {
  async function eventWithDelivery(): Promise<{ eventId: string }> {
    return db.tenant(tenant).transaction(async (tx) => {
      const event = await outbox.append(tx, { eventType: 'payout.held', payload: { a: 1 } });
      const endpoint = await webhookEndpoints.create(tx, {
        url: `https://example.com/${randomUUID()}`,
        secretRef: 'ref',
        eventTypes: ['payout.held'],
      });
      await webhookDeliveries.record(tx, {
        endpointId: endpoint.id,
        eventId: event.id,
        attempt: 1,
        status: 'succeeded',
      });
      return { eventId: event.id };
    });
  }

  it('removes an event and its deliveries past 30 days, and leaves a live one', async () => {
    const old = await eventWithDelivery();
    const fresh = await eventWithDelivery();
    // Ageing a row takes the superuser with every trigger off for one
    // transaction, the append only ones and the foreign keys that tie a
    // delivery to its event's time, which is the point of them.
    await admin.query('begin');
    try {
      await admin.query(`set local session_replication_role = 'replica'`);
      await admin.query(
        `update ujira.outbox_events set created_at = now() - interval '31 days' where id = $1`,
        [old.eventId],
      );
      await admin.query(
        `update ujira.webhook_deliveries set event_created_at = now() - interval '31 days'
          where event_id = $1`,
        [old.eventId],
      );
      await admin.query('commit');
    } catch (error) {
      await admin.query('rollback');
      throw error;
    }

    await asRetention(async () => {
      await admin.query('delete from ujira.webhook_deliveries');
      await admin.query('delete from ujira.outbox_events');
    }, true);
    expect(await ids('ujira.outbox_events')).toEqual([fresh.eventId]);
    const deliveries = await admin.query<{ event_id: string }>(
      'select event_id from ujira.webhook_deliveries',
    );
    expect(deliveries.rows.map((row) => row.event_id)).toEqual([fresh.eventId]);
  });

  it('cannot read a payload', async () => {
    expect(
      await codeOf(asRetention(async () => admin.query('select payload from ujira.outbox_events'))),
    ).toBe('42501');
  });

  it('is still refused an update, which only deletion is exempt from', async () => {
    expect(
      await codeOf(
        asRetention(async () =>
          admin.query(`update ujira.outbox_events set event_type = 'payout.paid'`),
        ),
      ),
    ).toBe('42501');
  });
});
