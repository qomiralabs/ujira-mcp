// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The cross-tenant matrix. Two principals with two projects each. Every
// repository method runs as tenant A against tenant B's ids and must find
// nothing, return a page without B's rows, refuse the write, or land it in A.
// Methods that read one project are also run against A's other project, which
// a project scoped transaction must not see either.

import { randomUUID } from 'node:crypto';

import { sql, type Kysely } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import type { Database, ProjectContext } from './database.js';
import type { Schema } from './schema.js';
import { entryPoints } from './repositories/entry-points.js';
import {
  apiTokens,
  members,
  principals,
  projects,
  tenancyRepositories,
} from './repositories/tenancy.js';
import { caseProblems, methodNames } from './testing/cross-tenant.js';
import { databaseAsServiceRoles } from './testing/databases.js';
import { createTestDatabase, type TestDatabase } from './testing/harness.js';

const adminUrl = inject('dbAdminUrl');
const roleUrls = inject('dbRoleUrls');

interface Tenant {
  readonly first: ProjectContext;
  readonly second: ProjectContext;
  readonly ownerMemberId: string;
  readonly memberId: string;
  readonly tokenId: string;
  readonly secondTokenId: string;
}

const REPOSITORIES = { ...tenancyRepositories };

const EXPIRES_AT = new Date('2100-01-01T00:00:00Z');

let database: TestDatabase;
let db: Database;
let admin: pg.Client;
let a: Tenant;
let b: Tenant;

function wallet(): string {
  return `G${randomUUID().replace(/-/g, '').toUpperCase()}`;
}

function token(name: string) {
  return {
    prefix: `ujk_${name}_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
    secretSha256: Buffer.alloc(32, 7),
    scopes: ['payouts:read'],
    expiresAt: EXPIRES_AT,
  };
}

async function tenant(name: string): Promise<Tenant> {
  const created = await db.unscoped(async (tx) =>
    entryPoints.createPrincipal(tx, { name, projectName: `${name} one`, ownerWallet: wallet() }),
  );
  const first = { principalId: created.principalId, projectId: created.projectId };
  const secondId = await db
    .tenant(first)
    .transaction(async (tx) => projects.create(tx, { name: `${name} two` }));
  const second = { principalId: created.principalId, projectId: secondId };
  const member = await db
    .tenant(first)
    .transaction(async (tx) => members.add(tx, { walletAddress: wallet(), role: 'developer' }));
  const firstToken = await db
    .tenant(first)
    .transaction(async (tx) => apiTokens.create(tx, token(name)));
  const secondToken = await db
    .tenant(second)
    .transaction(async (tx) => apiTokens.create(tx, token(name)));
  return {
    first,
    second,
    ownerMemberId: created.memberId,
    memberId: member.memberId,
    tokenId: firstToken.id,
    secondTokenId: secondToken.id,
  };
}

async function asA<T>(work: (tx: Kysely<Schema>) => Promise<T>): Promise<T> {
  return db.tenant(a.first).transaction(work);
}

// Every project of A, read only.
async function acrossA<T>(work: (tx: Kysely<Schema>) => Promise<T>): Promise<T> {
  return db.principal(a.first, 'app').transaction(work);
}

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

async function principalOf(table: string, column: string, id: string): Promise<string | undefined> {
  const result = await admin.query<{ principal_id: string }>(
    `select principal_id from ${table} where ${column} = $1`,
    [id],
  );
  return result.rows[0]?.principal_id;
}

async function rowOf(table: string, column: string, id: string): Promise<unknown> {
  const result = await admin.query(`select * from ${table} where ${column} = $1`, [id]);
  return result.rows;
}

beforeAll(async () => {
  database = await createTestDatabase(adminUrl, import.meta.url);
  db = databaseAsServiceRoles(roleUrls, database);
  admin = new pg.Client({ connectionString: database.url });
  await admin.connect();
  a = await tenant('alpha');
  b = await tenant('bravo');
});

afterAll(async () => {
  await admin.end();
  await db.close();
  await database.drop();
});

// Each case leaves B exactly as it found it, which the unchanged checks show.
const cases: Record<string, () => Promise<void>> = {
  'principals.current': async () => {
    expect((await asA(async (tx) => principals.current(tx)))?.id).toBe(a.first.principalId);
  },
  'principals.get': async () => {
    expect(await asA(async (tx) => principals.get(tx, b.first.principalId))).toBeUndefined();
    expect(await acrossA(async (tx) => principals.get(tx, b.first.principalId))).toBeUndefined();
  },
  'principals.setReportingTimeZone': async () => {
    const before = await rowOf('ujira.principals', 'id', b.first.principalId);
    expect(
      await asA(async (tx) =>
        principals.setReportingTimeZone(tx, b.first.principalId, 'Africa/Lagos'),
      ),
    ).toBe(false);
    expect(await rowOf('ujira.principals', 'id', b.first.principalId)).toEqual(before);
  },
  'projects.list': async () => {
    // Other cases may have added projects to A; none may belong to B.
    const page = await acrossA(async (tx) => projects.list(tx, { limit: 100 }));
    const ids = page.items.map((project) => project.id);
    expect(ids).toEqual(expect.arrayContaining([a.first.projectId, a.second.projectId]));
    expect(ids).not.toContain(b.first.projectId);
    expect(ids).not.toContain(b.second.projectId);
    // Project scope lists its own project only.
    const own = await asA(async (tx) => projects.list(tx, { limit: 100 }));
    expect(own.items.map((project) => project.id)).toEqual([a.first.projectId]);
  },
  'projects.get': async () => {
    expect(await acrossA(async (tx) => projects.get(tx, b.first.projectId))).toBeUndefined();
    expect(await asA(async (tx) => projects.get(tx, a.second.projectId))).toBeUndefined();
  },
  'projects.create': async () => {
    const id = await asA(async (tx) => projects.create(tx, { name: 'made by a' }));
    expect(await principalOf('ujira.projects', 'id', id)).toBe(a.first.principalId);
  },
  'projects.rename': async () => {
    expect(await asA(async (tx) => projects.rename(tx, b.first.projectId, 'taken'))).toBe(false);
    expect(await asA(async (tx) => projects.rename(tx, a.second.projectId, 'taken'))).toBe(false);
    const names = await admin.query<{ name: string }>(
      'select name from ujira.projects where id = any($1::uuid[]) order by name',
      [[b.first.projectId, a.second.projectId]],
    );
    expect(names.rows.map((row) => row.name)).toEqual(['alpha two', 'bravo one']);
  },
  'members.list': async () => {
    const page = await asA(async (tx) => members.list(tx, { limit: 100 }));
    const ids = page.items.map((member) => member.memberId);
    expect(ids).toEqual(expect.arrayContaining([a.ownerMemberId, a.memberId]));
    expect(ids).not.toContain(b.ownerMemberId);
    expect(ids).not.toContain(b.memberId);
  },
  'members.get': async () => {
    expect(await asA(async (tx) => members.get(tx, b.ownerMemberId))).toBeUndefined();
  },
  'members.add': async () => {
    // The principal comes from the context, so the new membership is A's.
    const address = wallet();
    const added = await asA(async (tx) =>
      members.add(tx, { walletAddress: address, role: 'viewer' }),
    );
    const owners = await admin.query<{ principal_id: string }>(
      'select principal_id from ujira.principal_members where member_id = $1',
      [added.memberId],
    );
    expect(owners.rows).toEqual([{ principal_id: a.first.principalId }]);
  },
  'members.changeRole': async () => {
    expect(await asA(async (tx) => members.changeRole(tx, b.memberId, 'owner'))).toBe(false);
    const role = await admin.query<{ role: string }>(
      'select role from ujira.principal_members where principal_id = $1 and member_id = $2',
      [b.first.principalId, b.memberId],
    );
    expect(role.rows).toEqual([{ role: 'developer' }]);
  },
  'members.setStatus': async () => {
    expect(await asA(async (tx) => members.setStatus(tx, b.ownerMemberId, 'removed'))).toBe(false);
    const status = await admin.query<{ status: string }>(
      'select status from ujira.principal_members where principal_id = $1 and member_id = $2',
      [b.first.principalId, b.ownerMemberId],
    );
    expect(status.rows).toEqual([{ status: 'active' }]);
  },
  'apiTokens.list': async () => {
    const page = await acrossA(async (tx) => apiTokens.list(tx, { limit: 100 }));
    const ids = page.items.map((item) => item.id);
    expect(ids).toEqual(expect.arrayContaining([a.tokenId, a.secondTokenId]));
    expect(ids).not.toContain(b.tokenId);
    expect(ids).not.toContain(b.secondTokenId);
    const own = await asA(async (tx) => apiTokens.list(tx, { limit: 100 }));
    expect(own.items.map((item) => item.id)).not.toContain(a.secondTokenId);
  },
  'apiTokens.get': async () => {
    expect(await acrossA(async (tx) => apiTokens.get(tx, b.tokenId))).toBeUndefined();
    expect(await asA(async (tx) => apiTokens.get(tx, a.secondTokenId))).toBeUndefined();
  },
  'apiTokens.create': async () => {
    const created = await asA(async (tx) => apiTokens.create(tx, token('case')));
    expect(created.projectId).toBe(a.first.projectId);
    expect(await principalOf('ujira.api_tokens', 'id', created.id)).toBe(a.first.principalId);
  },
  'apiTokens.createWithinLimit': async () => {
    // B holds keys of its own, and none of them counts against A's limit.
    const created = await asA(async (tx) => apiTokens.createWithinLimit(tx, token('case'), 1000));
    expect(await principalOf('ujira.api_tokens', 'id', created?.id ?? randomUUID())).toBe(
      a.first.principalId,
    );
  },
  'apiTokens.createSuccessor': async () => {
    const attempt = asA(async (tx) =>
      apiTokens.createSuccessor(tx, { ...token('case'), rotatedFromId: b.tokenId }),
    );
    expect(await codeOf(attempt)).toBe('23503');
  },
  'apiTokens.successorOf': async () => {
    await db
      .tenant(b.first)
      .transaction(async (tx) =>
        apiTokens.createSuccessor(tx, { ...token('bravo'), rotatedFromId: b.tokenId }),
      );
    expect(await acrossA(async (tx) => apiTokens.successorOf(tx, b.tokenId))).toBeUndefined();
  },
  'apiTokens.shortenExpiry': async () => {
    expect(
      await asA(async (tx) => apiTokens.shortenExpiry(tx, b.tokenId, new Date(0))),
    ).toBeUndefined();
    const expiry = await admin.query<{ expires_at: Date }>(
      'select expires_at from ujira.api_tokens where id = $1',
      [b.tokenId],
    );
    expect(expiry.rows).toEqual([{ expires_at: EXPIRES_AT }]);
  },
  'apiTokens.touchLastUsed': async () => {
    expect(await asA(async (tx) => apiTokens.touchLastUsed(tx, b.tokenId))).toBe(false);
    const used = await admin.query<{ last_used_at: Date | null }>(
      'select last_used_at from ujira.api_tokens where id = $1',
      [b.tokenId],
    );
    expect(used.rows).toEqual([{ last_used_at: null }]);
  },
  'apiTokens.revoke': async () => {
    expect(await asA(async (tx) => apiTokens.revoke(tx, b.tokenId))).toBe(false);
    expect(await asA(async (tx) => apiTokens.revoke(tx, a.secondTokenId))).toBe(false);
    const revoked = await admin.query<{ revoked_at: Date | null }>(
      'select revoked_at from ujira.api_tokens where id = any($1::uuid[])',
      [[b.tokenId, a.secondTokenId]],
    );
    expect(revoked.rows).toEqual([{ revoked_at: null }, { revoked_at: null }]);
  },
};

describe('cross-tenant matrix', () => {
  it('has a case for every repository method, and none for a method that does not exist', () => {
    expect(caseProblems(REPOSITORIES, Object.keys(cases))).toEqual([]);
  });

  it.each(methodNames(REPOSITORIES))('%s cannot reach the other tenant', async (name) => {
    const run = cases[name];
    expect(run, name).toBeDefined();
    await run?.();
  });
});

describe('writes that name another tenant outright', () => {
  it('are refused by the policies, whatever the code above them does', async () => {
    const attempts = [
      `insert into ujira.projects (principal_id, name) values ('${b.first.principalId}', 'stolen')`,
      `insert into ujira.api_tokens (principal_id, project_id, prefix, secret_sha256, scopes, expires_at)
       values ('${b.first.principalId}', '${b.first.projectId}', 'ujk_stolen_${randomUUID().slice(0, 8)}',
               decode(repeat('ab', 32), 'hex'), '{payouts:read}', now() + interval '1 day')`,
      `update ujira.api_tokens set principal_id = '${b.first.principalId}', project_id = '${b.first.projectId}'
        where id = '${a.tokenId}'`,
    ];
    for (const statement of attempts) {
      const code = await codeOf(
        db.tenant(a.first).transaction(async (tx) => sql.raw(statement).execute(tx)),
      );
      // A policy refuses with 42501; the token trigger refuses a tenant move
      // with UJ006 before the policy is asked.
      expect(['42501', 'UJ006'], statement).toContain(code);
    }
  });
});
