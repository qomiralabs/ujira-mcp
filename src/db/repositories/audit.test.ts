// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The audit chain against a real database: written as the app, verified across
// a principal, and tampered with as the superuser, who is the only one who can.

import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import type { Database, ProjectContext } from '../database.js';
import { insertProject, insertTenant } from '../testing/admin-tenants.js';
import { databaseAsServiceRoles } from '../testing/databases.js';
import { createTestDatabase, type TestDatabase } from '../testing/harness.js';
import { audit, AuditScopeError, type AuditAction, type NewAuditEntry } from './audit.js';
import { PageRequestError } from './page.js';

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

function entry(overrides: Partial<NewAuditEntry> = {}): NewAuditEntry {
  return {
    action: 'project.routing_settings_changed',
    actor: { kind: 'member', id: randomUUID() },
    metadata: { setting: 'chain_fallback', old_value: 'off', new_value: 'verified_methods' },
    ...overrides,
  };
}

async function record(overrides: Partial<NewAuditEntry> = {}) {
  return db.tenant(tenant).transaction(async (tx) => audit.record(tx, entry(overrides)));
}

async function verify() {
  return db.principal(tenant, 'app').transaction(async (tx) => audit.verify(tx));
}

// What it takes to alter this table at all: the owner must switch off the
// trigger that refuses it. Run as the superuser, because that is who can.
async function tamper(statement: string, values: unknown[] = []): Promise<void> {
  await admin.query('alter table ujira.audit_log disable trigger audit_log_append_only');
  try {
    await admin.query(statement, values);
  } finally {
    await admin.query('alter table ujira.audit_log enable trigger audit_log_append_only');
  }
}

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

describe('the audit chain', () => {
  it('verifier accepts an intact chain', async () => {
    for (let index = 0; index < 5; index += 1) await record();
    expect(await verify()).toEqual({ rows: 5n, firstBreak: null });
  });

  it('refuses to verify under one project, where a chain would look broken', async () => {
    await record();
    await expect(
      db.tenant(tenant).transaction(async (tx) => audit.verify(tx)),
    ).rejects.toBeInstanceOf(AuditScopeError);
  });

  it('accepts an empty chain', async () => {
    expect(await verify()).toEqual({ rows: 0n, firstBreak: null });
  });

  it('numbers a chain across every project of a principal', async () => {
    await record();
    const second = await insertProject(admin, tenant.principalId, 'Second');
    await db
      .tenant({ principalId: tenant.principalId, projectId: second })
      .transaction(async (tx) => audit.record(tx, entry()));
    await record();
    const page = await db
      .principal(tenant, 'app')
      .transaction(async (tx) => audit.list(tx, { limit: 10 }));
    expect(page.items.map((item) => item.seq)).toEqual([1n, 2n, 3n]);
    expect(page.items.map((item) => item.projectId)).toEqual([
      tenant.projectId,
      second,
      tenant.projectId,
    ]);
    expect((await verify()).firstBreak).toBeNull();
  });

  it('keeps one chain per principal, so another principal starts at one', async () => {
    await record();
    await record();
    const other = await insertTenant(admin, 'Other');
    const first = await db.tenant(other).transaction(async (tx) => audit.record(tx, entry()));
    expect(first.seq).toBe(1n);
    expect(await verify()).toEqual({ rows: 2n, firstBreak: null });
  });

  it('stays gapless under concurrent writers, and verifies', async () => {
    await Promise.all(Array.from({ length: 16 }, async () => record()));
    expect(await verify()).toEqual({ rows: 16n, firstBreak: null });
  });

  it('overwrites whatever sequence and hashes a caller passes', async () => {
    const inserted = await admin.query<{ seq: string }>(
      `insert into ujira.audit_log
         (principal_id, project_id, action, actor_kind, seq, prev_hash, row_hash)
       values ($1, $2, 'project.routing_settings_changed', 'system', 999, $3, $3)
       returning seq`,
      [tenant.principalId, tenant.projectId, Buffer.alloc(32, 7)],
    );
    expect(inserted.rows).toEqual([{ seq: '1' }]);
    expect((await verify()).firstBreak).toBeNull();
  });

  it('is readable by the reader across a principal, which verifies it too', async () => {
    await record();
    const verified = await db
      .principal(tenant, 'reader')
      .transaction(async (tx) => audit.verify(tx));
    expect(verified).toEqual({ rows: 1n, firstBreak: null });
  });
});

describe('tampering', () => {
  it('a row altered by the owner breaks verification', async () => {
    for (let index = 0; index < 3; index += 1) await record();
    await tamper(
      `update ujira.audit_log set metadata = '{"new_value":"forged"}' where principal_id = $1 and seq = 2`,
      [tenant.principalId],
    );
    expect(await verify()).toEqual({ rows: 3n, firstBreak: { kind: 'row_altered', seq: 2n } });
  });

  it('finds a row removed from the middle', async () => {
    for (let index = 0; index < 3; index += 1) await record();
    await tamper('delete from ujira.audit_log where principal_id = $1 and seq = 2', [
      tenant.principalId,
    ]);
    expect(await verify()).toEqual({ rows: 2n, firstBreak: { kind: 'link_broken', seq: 3n } });
  });

  it('finds the newest row removed, which only the head can show', async () => {
    for (let index = 0; index < 3; index += 1) await record();
    await tamper('delete from ujira.audit_log where principal_id = $1 and seq = 3', [
      tenant.principalId,
    ]);
    expect(await verify()).toEqual({ rows: 2n, firstBreak: { kind: 'head_mismatch', seq: 3n } });
  });

  it('finds the newest row replaced and re-hashed, which only the head can show', async () => {
    for (let index = 0; index < 3; index += 1) await record();
    await tamper(
      `update ujira.audit_log
          set metadata = '{"new_value":"forged"}',
              row_hash = ujira.audit_row_hash(
                prev_hash::bytea, principal_id, project_id, seq, action, actor_kind, actor_id,
                '{"new_value":"forged"}'::jsonb, occurred_at
              )
        where principal_id = $1 and seq = 3`,
      [tenant.principalId],
    );
    expect(await verify()).toEqual({ rows: 3n, firstBreak: { kind: 'head_mismatch', seq: 3n } });
  });

  it('finds every row removed, with the head left behind', async () => {
    await record();
    await tamper('delete from ujira.audit_log where principal_id = $1', [tenant.principalId]);
    expect(await verify()).toEqual({ rows: 0n, firstBreak: { kind: 'head_mismatch', seq: 1n } });
  });

  it('finds a row re-hashed to hide a change, by the next link', async () => {
    for (let index = 0; index < 3; index += 1) await record();
    await tamper(
      `update ujira.audit_log
          set metadata = '{"new_value":"forged"}',
              row_hash = ujira.audit_row_hash(
                prev_hash::bytea, principal_id, project_id, seq, action, actor_kind, actor_id,
                '{"new_value":"forged"}'::jsonb, occurred_at
              )
        where principal_id = $1 and seq = 2`,
      [tenant.principalId],
    );
    expect(await verify()).toEqual({ rows: 3n, firstBreak: { kind: 'link_broken', seq: 3n } });
  });

  it('keeps a head from being removed, even by the owner', async () => {
    await record();
    for (const statement of ['delete from ujira.audit_heads', 'truncate ujira.audit_heads']) {
      await admin.query('begin');
      await admin.query('set local role ujira_owner');
      expect(await codeOf(admin.query(statement)), statement).toBe('UJ002');
      await admin.query('rollback');
    }
  });

  it('refuses update, delete and truncate, from the app and from the owner', async () => {
    await record();
    const statements = [
      `update ujira.audit_log set action = 'x.y'`,
      'delete from ujira.audit_log',
      'truncate ujira.audit_log',
    ];
    for (const statement of statements) {
      await admin.query('begin');
      await admin.query('set local role ujira_owner');
      expect(await codeOf(admin.query(statement)), statement).toBe('UJ002');
      await admin.query('rollback');
      await admin.query('begin');
      await admin.query('set local role ujira_app');
      // Under a context, so it is the missing grant that refuses. Without one
      // the planner evaluates the policy first and the answer is UJ001.
      await admin.query(
        `select set_config('ujira.principal_id', $1, true),
                set_config('ujira.project_id', $2, true),
                set_config('ujira.scope', 'project', true),
                set_config('ujira.txid', txid_current()::text, true)`,
        [tenant.principalId, tenant.projectId],
      );
      expect(await codeOf(admin.query(statement)), statement).toBe('42501');
      await admin.query('rollback');
    }
  });
});

describe('metadata', () => {
  it('metadata key email is rejected', async () => {
    expect(await codeOf(record({ metadata: { email: 'someone@example.com' } }))).toBe('UJ012');
    expect((await verify()).rows).toBe(0n);
  });

  it('refuses nesting, which could hide a key', async () => {
    const nested = { new_value: { email: 'someone@example.com' } } as unknown as Record<
      string,
      string
    >;
    expect(await codeOf(record({ metadata: nested }))).toBe('UJ012');
  });

  it('refuses metadata that is not an object', async () => {
    const list = ['setting'] as unknown as Record<string, string>;
    expect(await codeOf(record({ metadata: list }))).toBe('UJ012');
  });

  it('accepts no metadata at all', async () => {
    const written = await db
      .tenant(tenant)
      .transaction(async (tx) =>
        audit.record(tx, { action: 'project.routing_settings_changed', actor: { kind: 'system' } }),
      );
    expect(written.metadata).toEqual({});
    expect(written.actorKind).toBe('system');
    expect(written.actorId).toBeNull();
  });
});

describe('the fields', () => {
  it('refuses a malformed action, and an actor kind and id that disagree', async () => {
    expect(await codeOf(record({ action: 'NotDotted' as AuditAction }))).toBe('23514');
    expect(
      await codeOf(
        admin.query(
          `insert into ujira.audit_log
             (principal_id, project_id, action, actor_kind, seq, prev_hash, row_hash)
           values ($1, $2, 'project.routing_settings_changed', 'member', 0, $3, $3)`,
          [tenant.principalId, tenant.projectId, Buffer.alloc(32)],
        ),
      ),
    ).toBe('23514');
  });

  it('commits with the work and rolls back with it, leaving the chain whole', async () => {
    await expect(
      db.tenant(tenant).transaction(async (tx) => {
        await audit.record(tx, entry());
        throw new Error('the work failed');
      }),
    ).rejects.toThrow('the work failed');
    await record();
    const page = await db
      .principal(tenant, 'app')
      .transaction(async (tx) => audit.list(tx, { limit: 10 }));
    expect(page.items.map((item) => item.seq)).toEqual([1n]);
    expect((await verify()).firstBreak).toBeNull();
  });

  it('pages in sequence', async () => {
    for (let index = 0; index < 3; index += 1) await record();
    const session = db.principal(tenant, 'app');
    const first = await session.transaction(async (tx) => audit.list(tx, { limit: 2 }));
    expect(first.next).toBe('2');
    const after = first.next ?? '';
    const rest = await session.transaction(async (tx) => audit.list(tx, { limit: 2, after }));
    expect(rest.items.map((item) => item.seq)).toEqual([3n]);
    expect(rest.next).toBeNull();
    await expect(
      session.transaction(async (tx) => audit.list(tx, { limit: 2, after: 'nonsense' })),
    ).rejects.toThrow(PageRequestError);
    await expect(session.transaction(async (tx) => audit.list(tx, { limit: 0 }))).rejects.toThrow(
      PageRequestError,
    );
  });
});
