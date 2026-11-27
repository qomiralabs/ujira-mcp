// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// Security events hold nothing that reads back into a person. The shape of the
// table is what promises that, so these tests try to break it, and then check
// who can reach it and how long it keeps anything.

import { createHmac } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import type { Database } from '../database.js';
import { databaseAsServiceRoles } from '../testing/databases.js';
import {
  createTestDatabase,
  roleUrl,
  type LoginRole,
  type TestDatabase,
} from '../testing/harness.js';
import { opsCatalogProblems } from '../testing/ops-catalog.js';
import {
  SECURITY_EVENT_KINDS,
  securityEvents,
  type NewSecurityEvent,
  type SecurityEventKind,
} from './security-events.js';

const adminUrl = inject('dbAdminUrl');
const roleUrls = inject('dbRoleUrls');

const HMAC_KEY = 'a key only this test knows';
const EMAIL = 'someone@example.com';
const IP = '203.0.113.7';
const PREFIX = 'ujk_test_abcdefghijklmnop';

const hmac = (text: string): Buffer => createHmac('sha256', HMAC_KEY).update(text).digest();

let database: TestDatabase;
let db: Database;
let admin: pg.Client;

async function record(event: NewSecurityEvent): Promise<void> {
  await db.unscoped(async (tx) => securityEvents.record(tx, event));
}

async function as<T>(role: LoginRole, work: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: roleUrl(roleUrls, role, database.name) });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

// The roles that cannot log in are reached the way their functions reach them:
// by becoming them for one transaction.
async function asNoLogin<T>(
  role: 'ujira_ops' | 'ujira_retention',
  work: () => Promise<T>,
): Promise<T> {
  await admin.query('begin');
  try {
    await admin.query(`set local role ${role}`);
    return await work();
  } finally {
    await admin.query('rollback');
  }
}

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

beforeAll(async () => {
  database = await createTestDatabase(adminUrl, import.meta.url);
  db = databaseAsServiceRoles(roleUrls, database);
  admin = new pg.Client({ connectionString: database.url });
  await admin.connect();
});

afterAll(async () => {
  await admin.end();
  await db.close();
  await database.drop();
});

describe('what is stored', () => {
  it('only HMACs and prefixes are stored', async () => {
    await record({
      kind: 'sign_in_failed',
      emailHmac: hmac(EMAIL),
      tokenPrefix: PREFIX,
      ipHmac: hmac(IP),
    });
    const rows = await admin.query<{ text: string; email_hmac: Buffer; ip_hmac: Buffer }>(
      `select e.email_hmac, e.ip_hmac, to_jsonb(e)::text as text
         from ops.security_events as e
        where e.token_prefix = $1`,
      [PREFIX],
    );
    const row = rows.rows[0];
    expect(row?.email_hmac).toEqual(hmac(EMAIL));
    expect(row?.ip_hmac).toEqual(hmac(IP));
    expect(row?.text).not.toContain(EMAIL);
    expect(row?.text).not.toContain('example.com');
    expect(row?.text).not.toContain(IP);
    expect(Buffer.from(row?.email_hmac ?? []).toString('utf8')).not.toContain(EMAIL);
  });

  it('has exactly these columns, and no tenant among them', async () => {
    const columns = await admin.query<{ column_name: string }>(
      `select column_name from information_schema.columns
        where table_schema = 'ops' and table_name = 'security_events'
        order by ordinal_position`,
    );
    expect(columns.rows.map((row) => row.column_name)).toEqual([
      'id',
      'kind',
      'email_hmac',
      'token_prefix',
      'ip_hmac',
      'occurred_at',
    ]);
  });

  it('passes the no customer data check, as a named exception and no wider', async () => {
    expect(await opsCatalogProblems(admin)).toEqual([]);
    await admin.query('begin');
    try {
      await admin.query('alter table ops.security_events add column email text');
      await admin.query('alter table ops.security_events add column project_id uuid');
      await admin.query(`comment on column ops.security_events.kind is 'the email it was for'`);
      await admin.query(
        'alter table ops.security_events add column principal uuid references ujira.principals (id)',
      );
      expect(await opsCatalogProblems(admin)).toEqual([
        'ops.security_events.kind: the comment reads like personal data',
        'ops.security_events.email: the name reads like personal data',
        'ops.security_events.project_id: is a tenant column',
        expect.stringMatching(
          /^ops\.security_events: foreign key \S+ crosses to ujira\.principals$/,
        ),
      ]);
    } finally {
      await admin.query('rollback');
    }
    expect(await opsCatalogProblems(admin)).toEqual([]);
  });

  it('refuses a plain email where the HMAC goes', async () => {
    expect(
      await codeOf(record({ kind: 'otp_failed', emailHmac: Buffer.from(EMAIL, 'utf8') })),
    ).toBe('23514');
  });

  it('refuses a plain address where the HMAC goes', async () => {
    expect(await codeOf(record({ kind: 'otp_failed', ipHmac: Buffer.from(IP, 'utf8') }))).toBe(
      '23514',
    );
  });

  it('refuses a whole key where the prefix goes, so a secret cannot land here', async () => {
    const wholeKey = `${PREFIX}_${'a'.repeat(59)}`;
    expect(await codeOf(record({ kind: 'token_invalid', tokenPrefix: wholeKey }))).toBe('23514');
  });

  it('refuses an email where the prefix goes', async () => {
    expect(await codeOf(record({ kind: 'token_invalid', tokenPrefix: EMAIL }))).toBe('23514');
  });
});

describe('the kinds', () => {
  it.each(SECURITY_EVENT_KINDS)('accepts %s, with nothing but its kind', async (kind) => {
    await record({ kind });
  });

  it('refuses a kind outside the list', async () => {
    expect(await codeOf(record({ kind: 'made_up' as SecurityEventKind }))).toBe('23514');
  });

  it('matches the check constraint exactly, in both directions', async () => {
    const found = await admin.query<{ definition: string }>(
      `select pg_get_constraintdef(oid) as definition from pg_constraint
        where conrelid = 'ops.security_events'::regclass and conname = 'security_events_kind_known'`,
    );
    const listed = [...(found.rows[0]?.definition ?? '').matchAll(/'([^']+)'::text/g)].map(
      (match) => match[1],
    );
    expect([...listed].sort()).toEqual([...SECURITY_EVENT_KINDS].sort());
  });

  it('dates the event itself', async () => {
    await record({ kind: 'csrf_failed', tokenPrefix: 'ujk_test_dated0000000000' });
    const found = await admin.query<{ recent: boolean }>(
      `select occurred_at > now() - interval '1 minute' as recent
         from ops.security_events where token_prefix = 'ujk_test_dated0000000000'`,
    );
    expect(found.rows).toEqual([{ recent: true }]);
  });
});

describe('who can reach it', () => {
  it.each(['ujira_app', 'ujira_worker', 'ujira_reader'] as const)(
    '%s cannot read or write the table directly',
    async (role) => {
      await as(role, async (client) => {
        expect(await codeOf(client.query('select * from ops.security_events'))).toBe('42501');
        expect(
          await codeOf(
            client.query(`insert into ops.security_events (kind) values ('csrf_failed')`),
          ),
        ).toBe('42501');
        expect(await codeOf(client.query('delete from ops.security_events'))).toBe('42501');
      });
    },
  );

  it('the app can record an event', async () => {
    await as('ujira_app', async (client) => {
      await client.query(
        `select ops.record_security_event('csrf_failed', null::bytea, null::text, null::bytea)`,
      );
    });
  });

  it.each(['ujira_worker', 'ujira_reader'] as const)('%s cannot record an event', async (role) => {
    await as(role, async (client) => {
      expect(
        await codeOf(
          client.query(
            `select ops.record_security_event('csrf_failed', null::bytea, null::text, null::bytea)`,
          ),
        ),
      ).toBe('42501');
    });
  });

  it('the retention role cannot record one either', async () => {
    await asNoLogin('ujira_retention', async () => {
      expect(
        await codeOf(
          admin.query(
            `select ops.record_security_event('csrf_failed', null::bytea, null::text, null::bytea)`,
          ),
        ),
      ).toBe('42501');
    });
  });

  it('even the ops role cannot rewrite an event', async () => {
    await asNoLogin('ujira_ops', async () => {
      expect(await codeOf(admin.query(`update ops.security_events set kind = 'csrf_failed'`))).toBe(
        '42501',
      );
    });
    await admin.query(
      `insert into ops.security_events (kind, token_prefix) values ('mfa_failed', 'ujk_test_rewrite00000000')`,
    );
    expect(
      await codeOf(
        admin.query(
          `update ops.security_events set kind = 'csrf_failed' where token_prefix = 'ujk_test_rewrite00000000'`,
        ),
      ),
    ).toBe('UJ002');
  });
});

describe('retention', () => {
  async function eventsAged(ages: readonly string[]): Promise<void> {
    for (const age of ages) {
      await admin.query(
        `insert into ops.security_events (kind, token_prefix, occurred_at)
         values ('token_invalid', $1, now() - $2::interval)`,
        [`ujk_test_${age.replace(/[^a-z0-9]/g, '')}`, age],
      );
    }
  }

  async function remaining(): Promise<string[]> {
    const found = await admin.query<{ prefix: string }>(
      'select token_prefix as prefix from ops.security_events order by occurred_at desc',
    );
    return found.rows.map((row) => row.prefix);
  }

  // The batch runs in its own transaction, as the prune job's call would, and
  // commits.
  async function deleteExpired(batchSize: number): Promise<number> {
    await admin.query('begin');
    try {
      await admin.query('set local role ujira_retention');
      const result = await admin.query<{ removed: string }>(
        'select ops.delete_expired_security_events($1::integer)::text as removed',
        [batchSize],
      );
      await admin.query('commit');
      return Number.parseInt(result.rows[0]?.removed ?? '0', 10);
    } catch (error) {
      await admin.query('rollback');
      throw error;
    }
  }

  beforeEach(async () => {
    await admin.query('delete from ops.security_events');
  });

  it('security events older than 90 days are deleted', async () => {
    await eventsAged(['91 days', '200 days', '89 days', '1 hour']);
    expect(await deleteExpired(1000)).toBe(2);
    expect(await remaining()).toEqual(['ujk_test_1hour', 'ujk_test_89days']);
  });

  it('keeps an event just inside the 90 days', async () => {
    await eventsAged(['89 days 23 hours']);
    expect(await deleteExpired(1000)).toBe(0);
    expect(await remaining()).toHaveLength(1);
  });

  it('removes one batch at a time, oldest first, so a job can loop', async () => {
    await eventsAged(['100 days', '300 days', '200 days']);
    expect(await deleteExpired(2)).toBe(2);
    expect(await remaining()).toEqual(['ujk_test_100days']);
    expect(await deleteExpired(2)).toBe(1);
    expect(await deleteExpired(2)).toBe(0);
  });

  it.each([0, -1, 10_001])('refuses a batch of %i', async (batchSize) => {
    await expect(deleteExpired(batchSize)).rejects.toMatchObject({ code: '22023' });
  });

  it('the retention role can do this and nothing else with the table', async () => {
    await eventsAged(['1 hour']);
    await asNoLogin('ujira_retention', async () => {
      expect(await codeOf(admin.query('delete from ops.security_events'))).toBe('42501');
    });
    expect(await remaining()).toHaveLength(1);
  });

  it('the app cannot prune', async () => {
    await as('ujira_app', async (client) => {
      expect(await codeOf(client.query('select ops.delete_expired_security_events(10)'))).toBe(
        '42501',
      );
    });
  });
});
