// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The tenant roots as the app sees them: creating a principal with its first
// project and owner in one call, projects, and the members a wallet becomes.

import { randomUUID } from 'node:crypto';

import { sql } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import type { Database } from './database.js';
import { audit } from './repositories/audit.js';
import { entryPoints } from './repositories/entry-points.js';
import { PageRequestError } from './repositories/page.js';
import { members, principals, projects } from './repositories/tenancy.js';
import { databaseAsServiceRoles } from './testing/databases.js';
import { createTestDatabase, type TestDatabase } from './testing/harness.js';

const adminUrl = inject('dbAdminUrl');
const roleUrls = inject('dbRoleUrls');

let database: TestDatabase;
let db: Database;
let admin: pg.Client;

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

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

// A made up address in the shape a Stellar account has. The database checks
// only that it is a plain run of letters and digits.
function wallet(): string {
  return `G${randomUUID().replace(/-/g, '').toUpperCase()}`;
}

async function counts(): Promise<Record<string, number>> {
  const result = await admin.query<{
    principals: number;
    projects: number;
    memberships: number;
    members: number;
  }>(
    `select (select count(*) from ujira.principals)::integer as principals,
            (select count(*) from ujira.projects)::integer as projects,
            (select count(*) from ujira.principal_members)::integer as memberships,
            (select count(*) from ujira.members)::integer as members`,
  );
  return result.rows[0] ?? {};
}

async function create(
  overrides: { projectName?: string; reportingTimeZone?: string; ownerWallet?: string } = {},
) {
  return db.unscoped(async (tx) =>
    entryPoints.createPrincipal(tx, {
      name: 'Acme',
      projectName: overrides.projectName ?? 'Main',
      ownerWallet: overrides.ownerWallet ?? wallet(),
      ...(overrides.reportingTimeZone === undefined
        ? {}
        : { reportingTimeZone: overrides.reportingTimeZone }),
    }),
  );
}

describe('principals', () => {
  it('reporting_time_zone defaults to UTC, accepts Africa/Lagos and refuses Mars/Olympus', async () => {
    const created = await create();
    const session = db.tenant(created);
    expect(
      (await session.transaction(async (tx) => principals.current(tx)))?.reportingTimeZone,
    ).toBe('UTC');
    expect(
      await session.transaction(async (tx) =>
        principals.setReportingTimeZone(tx, created.principalId, 'Africa/Lagos'),
      ),
    ).toBe(true);
    expect(
      (await session.transaction(async (tx) => principals.current(tx)))?.reportingTimeZone,
    ).toBe('Africa/Lagos');
    expect(
      await codeOf(
        session.transaction(async (tx) =>
          principals.setReportingTimeZone(tx, created.principalId, 'Mars/Olympus'),
        ),
      ),
    ).toBe('22023');
    expect(await codeOf(create({ reportingTimeZone: 'Mars/Olympus' }))).toBe('22023');
  });

  it('create_principal writes the principal, its first project and its owner, or nothing', async () => {
    const before = await counts();
    const owner = wallet();
    const created = await create({ ownerWallet: owner });
    const after = await counts();
    expect(after).toEqual({
      principals: (before['principals'] ?? 0) + 1,
      projects: (before['projects'] ?? 0) + 1,
      memberships: (before['memberships'] ?? 0) + 1,
      members: (before['members'] ?? 0) + 1,
    });
    const membership = await admin.query<{
      member_id: string;
      wallet_address: string;
      role: string;
      status: string;
    }>(
      `select member_id, wallet_address, role, status
         from ujira.principal_members where principal_id = $1`,
      [created.principalId],
    );
    expect(membership.rows).toEqual([
      { member_id: created.memberId, wallet_address: owner, role: 'owner', status: 'active' },
    ]);
    const project = await db
      .tenant(created)
      .transaction(async (tx) => projects.get(tx, created.projectId));
    expect(project?.name).toBe('Main');
    expect(project?.principalId).toBe(created.principalId);

    // Each insert in turn fails after the ones before it succeeded; none of
    // them may survive it.
    const middle = await counts();
    expect(await codeOf(create({ reportingTimeZone: 'Mars/Olympus' }))).toBe('22023');
    expect(await codeOf(create({ projectName: '' }))).toBe('23514');
    expect(await codeOf(create({ ownerWallet: 'not a wallet' }))).toBe('23514');
    expect(await counts()).toEqual(middle);
  });

  it('create_principal starts the audit chain with principal.created by its owner, or writes none', async () => {
    const created = await create();
    const rows = await admin.query<{
      project_id: string;
      seq: string;
      action: string;
      actor_kind: string;
      actor_id: string;
    }>(
      `select project_id, seq::text as seq, action, actor_kind, actor_id
         from ujira.audit_log where principal_id = $1 order by seq`,
      [created.principalId],
    );
    expect(rows.rows).toEqual([
      {
        project_id: created.projectId,
        seq: '1',
        action: 'principal.created',
        actor_kind: 'member',
        actor_id: created.memberId,
      },
    ]);
    const verified = await db.principal(created).transaction(async (tx) => audit.verify(tx));
    expect(verified).toEqual({ rows: 1n, firstBreak: null });

    const before = await admin.query<{ count: number }>(
      'select count(*)::integer as count from ujira.audit_log',
    );
    expect(await codeOf(create({ projectName: '' }))).toBe('23514');
    const after = await admin.query<{ count: number }>(
      'select count(*)::integer as count from ujira.audit_log',
    );
    expect(after.rows).toEqual(before.rows);
  });

  it('lets create_principal write no audit row but its own', async () => {
    // The definer role may insert only principal.created by a member; any
    // other row is refused by its policy even if the function were changed.
    const policy = await admin.query<{ check: string }>(
      `select pg_get_expr(p.polwithcheck, p.polrelid) as check
         from pg_policy p
        where p.polrelid = 'ujira.audit_log'::regclass and p.polname = 'create_principal'`,
    );
    expect(policy.rows[0]?.check).toContain('principal.created');
    const rights = await admin.query<Record<string, boolean>>(
      `select has_table_privilege('ujira_fn_principals', 'ujira.audit_log', 'INSERT') as insert,
              has_table_privilege('ujira_fn_principals', 'ujira.audit_log', 'SELECT') as select,
              has_table_privilege('ujira_fn_principals', 'ujira.audit_log', 'UPDATE') as update,
              has_table_privilege('ujira_fn_principals', 'ujira.audit_heads', 'UPDATE') as heads`,
    );
    expect(rights.rows).toEqual([{ insert: true, select: false, update: false, heads: false }]);
  });

  it('keeps one member for a wallet that owns several principals', async () => {
    const owner = wallet();
    const first = await create({ ownerWallet: owner });
    const before = await counts();
    const second = await create({ ownerWallet: owner });
    expect(second.memberId).toBe(first.memberId);
    expect(second.principalId).not.toBe(first.principalId);
    const after = await counts();
    expect(after['members']).toBe(before['members']);
    expect(after['memberships']).toBe((before['memberships'] ?? 0) + 1);
  });

  it('runs nothing but the entry points without a tenant context', async () => {
    expect(await codeOf(db.unscoped(async (tx) => principals.current(tx)))).toBe('UJ001');
    expect(await codeOf(db.unscoped(async (tx) => projects.list(tx, { limit: 10 })))).toBe('UJ001');
    expect(await codeOf(db.unscoped(async (tx) => members.list(tx, { limit: 10 })))).toBe('UJ001');
    expect(
      await codeOf(
        db.unscoped(async (tx) => members.add(tx, { walletAddress: wallet(), role: 'viewer' })),
      ),
    ).toBe('UJ001');
  });
});

describe('projects', () => {
  it('creates projects for its principal, renames its own, and pages through them all under scope all', async () => {
    const created = await create();
    const session = db.tenant(created);
    const second = await session.transaction(async (tx) => projects.create(tx, { name: 'Second' }));
    await session.transaction(async (tx) => projects.create(tx, { name: 'Third' }));
    expect(
      await session.transaction(async (tx) => projects.rename(tx, created.projectId, 'Renamed')),
    ).toBe(true);
    // Project scope sees its own project only, so another of its projects
    // cannot be renamed from here.
    expect(await session.transaction(async (tx) => projects.rename(tx, second, 'Nope'))).toBe(
      false,
    );
    expect(
      (await session.transaction(async (tx) => projects.get(tx, created.projectId)))?.name,
    ).toBe('Renamed');

    const across = db.principal(created, 'app');
    const first = await across.transaction(async (tx) => projects.list(tx, { limit: 2 }));
    expect(first.items).toHaveLength(2);
    expect(first.next).not.toBeNull();
    const after = first.next;
    if (after === null) throw new Error('expected a second page');
    const rest = await across.transaction(async (tx) => projects.list(tx, { limit: 2, after }));
    expect(rest.items).toHaveLength(1);
    expect(rest.next).toBeNull();
    const all = [...first.items, ...rest.items];
    expect(new Set(all.map((project) => project.principalId))).toEqual(
      new Set([created.principalId]),
    );
  });

  it('cannot create anything under scope all', async () => {
    const created = await create();
    expect(
      await codeOf(
        db.principal(created, 'app').transaction(async (tx) => projects.create(tx, { name: 'x' })),
      ),
    ).toBe('25006');
  });

  it('refuses a page size outside 1 to 100', async () => {
    const created = await create();
    for (const limit of [0, 101, 1.5]) {
      await expect(
        db.tenant(created).transaction(async (tx) => projects.list(tx, { limit })),
      ).rejects.toThrow(PageRequestError);
    }
  });
});

describe('members', () => {
  it('lists the owner, adds a member, changes a role and a status, and refuses what it does not know', async () => {
    const created = await create();
    const session = db.tenant(created);
    const address = wallet();
    const added = await session.transaction(async (tx) =>
      members.add(tx, { walletAddress: address, role: 'developer' }),
    );
    expect(added).toMatchObject({ walletAddress: address, role: 'developer', status: 'active' });
    expect(
      await session.transaction(async (tx) => members.changeRole(tx, added.memberId, 'admin')),
    ).toBe(true);
    expect(
      await session.transaction(async (tx) => members.setStatus(tx, added.memberId, 'suspended')),
    ).toBe(true);
    expect(await session.transaction(async (tx) => members.get(tx, added.memberId))).toMatchObject({
      role: 'admin',
      status: 'suspended',
    });
    const page = await session.transaction(async (tx) => members.list(tx, { limit: 1 }));
    expect(page.items).toHaveLength(1);
    expect(page.next).not.toBeNull();
    const all = await session.transaction(async (tx) => members.list(tx, { limit: 100 }));
    expect(all.items.map((member) => member.memberId).sort()).toEqual(
      [created.memberId, added.memberId].sort(),
    );
    expect(
      await codeOf(
        session.transaction(async (tx) =>
          members.add(tx, { walletAddress: wallet(), role: 'superuser' as 'admin' }),
        ),
      ),
    ).toBe('23514');
    expect(
      await codeOf(
        session.transaction(async (tx) =>
          members.setStatus(tx, added.memberId, 'invited' as 'active'),
        ),
      ),
    ).toBe('23514');
  });

  it('lets one wallet belong to several principals, once in each', async () => {
    const shared = wallet();
    const alpha = await create();
    const bravo = await create();
    const inAlpha = await db
      .tenant(alpha)
      .transaction(async (tx) => members.add(tx, { walletAddress: shared, role: 'viewer' }));
    const inBravo = await db
      .tenant(bravo)
      .transaction(async (tx) => members.add(tx, { walletAddress: shared, role: 'admin' }));
    // One person, with a role of their own in each principal.
    expect(inBravo.memberId).toBe(inAlpha.memberId);
    expect([inAlpha.role, inBravo.role]).toEqual(['viewer', 'admin']);
    expect(
      await codeOf(
        db
          .tenant(alpha)
          .transaction(async (tx) => members.add(tx, { walletAddress: shared, role: 'developer' })),
      ),
    ).toBe('23505');
    const unique = await admin.query<{ definition: string }>(
      `select pg_get_constraintdef(oid) as definition
         from pg_constraint where conname = 'principal_members_wallet_key'`,
    );
    expect(unique.rows).toEqual([{ definition: 'UNIQUE (principal_id, wallet_address)' }]);
  });

  it('adds nobody under scope all', async () => {
    const created = await create();
    const attempt = db
      .principal(created, 'app')
      .transaction(async (tx) => members.add(tx, { walletAddress: wallet(), role: 'viewer' }));
    expect(await codeOf(attempt)).toBe('42501');
  });

  it('gives the app no way to write a membership but its role and status, nor to read a member', async () => {
    const created = await create();
    const other = await create();
    const inTenant = async (statement: string): Promise<string | undefined> =>
      codeOf(db.tenant(created).transaction(async (tx) => sql.raw(statement).execute(tx)));
    expect(
      await inTenant(
        `insert into ujira.principal_members (principal_id, member_id, wallet_address, role)
         values (ujira.current_principal_id(), '${other.memberId}', 'GX', 'owner')`,
      ),
    ).toBe('42501');
    expect(
      await inTenant(`update ujira.principal_members set member_id = '${other.memberId}'`),
    ).toBe('42501');
    expect(await inTenant(`update ujira.principal_members set wallet_address = 'GX'`)).toBe(
      '42501',
    );
    expect(await inTenant('select count(*) from ujira.members')).toBe('42501');
  });
});
