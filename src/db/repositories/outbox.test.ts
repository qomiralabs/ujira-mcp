// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The outbox and the webhook tables against a real database, as the app and,
// for the outbox, as the worker whose jobs write payout events.

import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it, vi } from 'vitest';

import type { Database, ProjectContext } from '../database.js';
import { insertTenant } from '../testing/admin-tenants.js';
import { databaseAsServiceRoles } from '../testing/databases.js';
import { createTestDatabase, roleUrl, type TestDatabase } from '../testing/harness.js';
import { outbox, webhookDeliveries, webhookEndpoints, type WebhookEndpoint } from './outbox.js';

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

// The cursor waits for every transaction on the server, including other test files'
// on a shared container, so a committed event shows up after they finish.
async function readAll(): Promise<readonly string[]> {
  const events = await db.tenant(tenant).transaction(async (tx) => outbox.after(tx, 0n, 100));
  return events.map((event) => event.eventType);
}

const WAIT = { timeout: 30_000, interval: 200 };

beforeAll(async () => {
  database = await createTestDatabase(adminUrl, import.meta.url);
  admin = new pg.Client({ connectionString: database.url });
  await admin.connect();
  db = databaseAsServiceRoles(roleUrls, database, 4);
});

beforeEach(async () => {
  tenant = await insertTenant(admin, 'Acme');
});

afterAll(async () => {
  await db.close();
  await admin.end();
  await database.drop();
});

describe('the outbox', () => {
  it('rolled back write leaves no outbox row', async () => {
    await expect(
      db.tenant(tenant).transaction(async (tx) => {
        await outbox.append(tx, { eventType: 'payout.held', payload: { a: 1 } });
        throw new Error('the work failed');
      }),
    ).rejects.toThrow('the work failed');
    const rows = await admin.query('select id from ujira.outbox_events where principal_id = $1', [
      tenant.principalId,
    ]);
    expect(rows.rows).toEqual([]);
  });

  it('a committed write is there, exactly as it was written', async () => {
    const written = await db
      .tenant(tenant)
      .transaction(async (tx) =>
        outbox.append(tx, { eventType: 'payout.held', payload: { payoutId: 'p', amount: '5' } }),
      );
    expect(written.payload).toEqual({ payoutId: 'p', amount: '5' });
    await vi.waitFor(async () => {
      expect(await readAll()).toEqual(['payout.held']);
    }, WAIT);
  });

  it('is written by the worker too, in its own tenant transaction', async () => {
    const written = await db.withTenant('worker', { ...tenant, scope: 'project' }, async (tx) =>
      outbox.append(tx, { eventType: 'payout.paid', payload: { payoutId: 'p' } }),
    );
    const owner = await admin.query<{ principal_id: string; project_id: string }>(
      'select principal_id, project_id from ujira.outbox_events where id = $1',
      [written.id],
    );
    expect(owner.rows).toEqual([
      { principal_id: tenant.principalId, project_id: tenant.projectId },
    ]);
  });

  it('a cursor never passes an event still to commit', async () => {
    let releaseSlow: () => void = () => undefined;
    const slowMayFinish = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });
    let slowWrote: () => void = () => undefined;
    const slowHasWritten = new Promise<void>((resolve) => {
      slowWrote = resolve;
    });
    // Takes the lower seq, and stays open.
    const slow = db.tenant(tenant).transaction(async (tx) => {
      await outbox.append(tx, { eventType: 'slow.lower_seq', payload: {} });
      slowWrote();
      await slowMayFinish;
    });
    await slowHasWritten;
    await db
      .tenant(tenant)
      .transaction(async (tx) => outbox.append(tx, { eventType: 'fast.higher_seq', payload: {} }));

    // The higher seq is committed and must still not be readable: a reader that took
    // it would move its cursor past the lower one for good.
    expect(await readAll()).toEqual([]);

    releaseSlow();
    await slow;
    await vi.waitFor(async () => {
      expect(await readAll()).toEqual(['slow.lower_seq', 'fast.higher_seq']);
    }, WAIT);
  });

  it('reads on from a cursor, in order', async () => {
    const session = db.tenant(tenant);
    const first = await session.transaction(async (tx) =>
      outbox.append(tx, { eventType: 'a.one', payload: {} }),
    );
    await session.transaction(async (tx) => outbox.append(tx, { eventType: 'a.two', payload: {} }));
    await vi.waitFor(async () => {
      const rest = await session.transaction(async (tx) => outbox.after(tx, first.seq, 10));
      expect(rest.map((event) => event.eventType)).toEqual(['a.two']);
    }, WAIT);
  });

  it('refuses a malformed event type, and a payload that is not an object', async () => {
    const session = db.tenant(tenant);
    expect(
      await codeOf(
        session.transaction(async (tx) => outbox.append(tx, { eventType: 'Nope', payload: {} })),
      ),
    ).toBe('23514');
    expect(
      await codeOf(
        session.transaction(async (tx) =>
          outbox.append(tx, {
            eventType: 'a.b',
            payload: [] as unknown as Record<string, unknown>,
          }),
        ),
      ),
    ).toBe('23514');
  });

  it('refuses an update or a delete, even from the owner', async () => {
    await db
      .tenant(tenant)
      .transaction(async (tx) => outbox.append(tx, { eventType: 'payout.held', payload: {} }));
    // A truncate of the events is refused before the trigger is reached, by the
    // deliveries' foreign key, so the trigger is shown on the deliveries.
    for (const [statement, code] of [
      [`update ujira.outbox_events set event_type = 'payout.paid'`, 'UJ002'],
      ['delete from ujira.outbox_events', 'UJ002'],
      ['truncate ujira.outbox_events', '0A000'],
      ['truncate ujira.webhook_deliveries', 'UJ002'],
    ] as const) {
      await admin.query('begin');
      try {
        await admin.query('set local role ujira_owner');
        expect(await codeOf(admin.query(statement)), statement).toBe(code);
      } finally {
        await admin.query('rollback');
      }
    }
  });
});

describe('webhook endpoints', () => {
  it('refuses a url that is not https, and a second endpoint on one url', async () => {
    const session = db.tenant(tenant);
    const input = { secretRef: 'ref', eventTypes: ['payout.held'] };
    expect(
      await codeOf(
        session.transaction(async (tx) =>
          webhookEndpoints.create(tx, { ...input, url: 'http://example.com/hook' }),
        ),
      ),
    ).toBe('23514');
    await session.transaction(async (tx) =>
      webhookEndpoints.create(tx, { ...input, url: 'https://example.com/hook' }),
    );
    expect(
      await codeOf(
        session.transaction(async (tx) =>
          webhookEndpoints.create(tx, { ...input, url: 'https://example.com/hook' }),
        ),
      ),
    ).toBe('23505');
  });

  it('refuses an endpoint listening for nothing', async () => {
    expect(
      await codeOf(
        db.tenant(tenant).transaction(async (tx) =>
          webhookEndpoints.create(tx, {
            url: 'https://example.com/hook',
            secretRef: 'ref',
            eventTypes: [],
          }),
        ),
      ),
    ).toBe('23514');
  });

  it('can be found, disabled, and paged', async () => {
    const session = db.tenant(tenant);
    const endpoint = await session.transaction(async (tx) =>
      webhookEndpoints.create(tx, {
        url: 'https://example.com/hook',
        secretRef: 'ref',
        eventTypes: ['payout.held'],
      }),
    );
    expect(await session.transaction(async (tx) => webhookEndpoints.get(tx, endpoint.id))).toEqual(
      endpoint,
    );
    expect(
      await session.transaction(async (tx) => webhookEndpoints.get(tx, randomUUID())),
    ).toBeUndefined();
    expect(
      await session.transaction(async (tx) =>
        webhookEndpoints.setStatus(tx, endpoint.id, 'disabled'),
      ),
    ).toBe(true);
    const page = await session.transaction(async (tx) => webhookEndpoints.list(tx, { limit: 5 }));
    expect(page.items.map((item) => item.status)).toEqual(['disabled']);
  });

  it('pages by id, so the next page starts after the last one', async () => {
    const session = db.tenant(tenant);
    const created: WebhookEndpoint[] = [];
    for (let index = 0; index < 3; index += 1) {
      created.push(
        await session.transaction(async (tx) =>
          webhookEndpoints.create(tx, {
            url: `https://example.com/${randomUUID()}`,
            secretRef: 'ref',
            eventTypes: ['payout.held'],
          }),
        ),
      );
    }
    const ids = created.map((endpoint) => endpoint.id).sort();
    const first = await session.transaction(async (tx) => webhookEndpoints.list(tx, { limit: 2 }));
    expect(first.items.map((item) => item.id)).toEqual(ids.slice(0, 2));
    const rest = await session.transaction(async (tx) =>
      webhookEndpoints.list(tx, { limit: 2, after: first.next ?? '' }),
    );
    expect(rest.items.map((item) => item.id)).toEqual(ids.slice(2));
    expect(rest.next).toBeNull();
  });

  it('keeps the secret reference from the reader', async () => {
    const reader = new pg.Client({
      connectionString: roleUrl(roleUrls, 'ujira_reader', database.name),
    });
    await reader.connect();
    try {
      // Under a context, so it is the missing grant that refuses. Without one the
      // planner evaluates the policy first and the answer is UJ001.
      await reader.query('begin');
      await reader.query(
        `select set_config('ujira.principal_id', $1, true),
                set_config('ujira.project_id', $2, true),
                set_config('ujira.scope', 'project', true),
                set_config('ujira.txid', txid_current()::text, true)`,
        [tenant.principalId, tenant.projectId],
      );
      expect(await codeOf(reader.query('select secret_ref from ujira.webhook_endpoints'))).toBe(
        '42501',
      );
      await reader.query('rollback');
    } finally {
      await reader.end();
    }
  });
});

describe('webhook deliveries', () => {
  async function eventAndEndpoint() {
    return db.tenant(tenant).transaction(async (tx) => {
      const event = await outbox.append(tx, { eventType: 'payout.held', payload: {} });
      const endpoint = await webhookEndpoints.create(tx, {
        url: `https://example.com/${randomUUID()}`,
        secretRef: 'ref',
        eventTypes: ['payout.held'],
      });
      return { eventId: event.id, endpointId: endpoint.id };
    });
  }

  it('keeps one row per attempt, and finds a repeat of one', async () => {
    const { eventId, endpointId } = await eventAndEndpoint();
    const session = db.tenant(tenant);
    const record = async (attempt: number, status: 'failed' | 'succeeded') =>
      session.transaction(async (tx) =>
        webhookDeliveries.record(tx, {
          endpointId,
          eventId,
          attempt,
          status,
          responseStatus: status === 'failed' ? 503 : 200,
          errorCode: status === 'failed' ? 'upstream_503' : null,
        }),
      );
    expect((await record(1, 'failed'))?.errorCode).toBe('upstream_503');
    expect((await record(2, 'succeeded'))?.responseStatus).toBe(200);
    expect(await record(2, 'succeeded')).toBeUndefined();
    const all = await session.transaction(async (tx) =>
      webhookDeliveries.forEvent(tx, endpointId, eventId),
    );
    expect(all.map((row) => [row.attempt, row.status])).toEqual([
      [1, 'failed'],
      [2, 'succeeded'],
    ]);
  });

  it('records the dead letter state', async () => {
    const { eventId, endpointId } = await eventAndEndpoint();
    const written = await db
      .tenant(tenant)
      .transaction(async (tx) =>
        webhookDeliveries.record(tx, { endpointId, eventId, attempt: 1, status: 'dead_letter' }),
      );
    expect(written?.status).toBe('dead_letter');
    expect(written?.responseStatus).toBeNull();
    expect(written?.errorCode).toBeNull();
  });

  it('records nothing for an event that does not exist', async () => {
    const { endpointId } = await eventAndEndpoint();
    expect(
      await db.tenant(tenant).transaction(async (tx) =>
        webhookDeliveries.record(tx, {
          endpointId,
          eventId: randomUUID(),
          attempt: 1,
          status: 'failed',
        }),
      ),
    ).toBeUndefined();
  });

  it('refuses an attempt outside 1 to 1000', async () => {
    const { eventId, endpointId } = await eventAndEndpoint();
    expect(
      await codeOf(
        db
          .tenant(tenant)
          .transaction(async (tx) =>
            webhookDeliveries.record(tx, { endpointId, eventId, attempt: 0, status: 'failed' }),
          ),
      ),
    ).toBe('23514');
  });
});
