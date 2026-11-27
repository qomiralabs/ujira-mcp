// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { CATALOG_EXCEPTIONS, catalogProblems, SEALED_TABLES } from './testing/catalog.js';
import { createTestDatabase, type TestDatabase } from './testing/harness.js';

const adminUrl = inject('dbAdminUrl');

let migrated: TestDatabase;
let fixtures: TestDatabase;
let fixtureClient: pg.Client;
let fixtureProblems: string[];

// A tenant table built the way every migration builds one: as the owner,
// with the policy template applied and the app granted what it needs.
const COMPLIANT = `
  set role ujira_owner;
  create table ujira.fixture_parent (
    principal_id uuid not null,
    project_id uuid not null,
    id bigint generated always as identity,
    primary key (principal_id, project_id, id)
  );
  select ujira.apply_tenant_policies('ujira.fixture_parent');
  grant select, insert, update on ujira.fixture_parent to ujira_app;
  grant select on ujira.fixture_parent to ujira_reader;
  create table ujira.fixture_child (
    principal_id uuid not null,
    project_id uuid not null,
    parent_id bigint not null,
    foreign key (principal_id, project_id, parent_id)
      references ujira.fixture_parent (principal_id, project_id, id)
  );
  select ujira.apply_tenant_policies('ujira.fixture_child');
  reset role;
`;

// One table per rule, each breaking only that rule.
const BROKEN = `
  set role ujira_owner;
  create table ujira.fixture_no_rls (principal_id uuid not null, project_id uuid not null);
  create table ujira.fixture_not_forced (principal_id uuid not null, project_id uuid not null);
  alter table ujira.fixture_not_forced enable row level security;
  create table ujira.fixture_nullable (principal_id uuid, project_id uuid not null);
  select ujira.apply_tenant_policies('ujira.fixture_nullable');
  create table ujira.fixture_untenanted (id bigint);
  alter table ujira.fixture_untenanted enable row level security;
  alter table ujira.fixture_untenanted force row level security;
  create table ujira.fixture_delete (principal_id uuid not null, project_id uuid not null);
  select ujira.apply_tenant_policies('ujira.fixture_delete');
  grant delete on ujira.fixture_delete to ujira_app;
  create table ujira.fixture_loose_child (
    principal_id uuid not null,
    project_id uuid not null,
    parent_principal uuid not null,
    parent_project uuid not null,
    parent_id bigint not null,
    foreign key (parent_principal, parent_project, parent_id)
      references ujira.fixture_parent (principal_id, project_id, id)
  );
  select ujira.apply_tenant_policies('ujira.fixture_loose_child');
  reset role;
  create table ujira.fixture_wrong_owner (principal_id uuid not null, project_id uuid not null);
  select ujira.apply_tenant_policies('ujira.fixture_wrong_owner');
`;

beforeAll(async () => {
  migrated = await createTestDatabase(adminUrl, import.meta.url);
  fixtures = await createTestDatabase(adminUrl, `${import.meta.url}#fixtures`);
  fixtureClient = new pg.Client({ connectionString: fixtures.url });
  await fixtureClient.connect();
  await fixtureClient.query(COMPLIANT);
  await fixtureClient.query(BROKEN);
  fixtureProblems = await catalogProblems(fixtureClient);
});

afterAll(async () => {
  await fixtureClient.end();
  await fixtures.drop();
  await migrated.drop();
});

function problemsOf(table: string): string[] {
  return fixtureProblems.filter((problem) => problem.startsWith(`ujira.${table}:`));
}

describe('catalog', () => {
  it('passes the migrated schema', async () => {
    const client = new pg.Client({ connectionString: migrated.url });
    await client.connect();
    try {
      expect(await catalogProblems(client)).toEqual([]);
    } finally {
      await client.end();
    }
  });

  it('passes a tenant table built with the template, and a composite foreign key', () => {
    expect(problemsOf('fixture_parent')).toEqual([]);
    expect(problemsOf('fixture_child')).toEqual([]);
  });

  it('fails a table without row level security', () => {
    expect(problemsOf('fixture_no_rls')).toEqual([
      'ujira.fixture_no_rls: row level security is not enabled',
      'ujira.fixture_no_rls: row level security is not forced',
    ]);
  });

  it('fails a table that enables row level security without forcing it', () => {
    expect(problemsOf('fixture_not_forced')).toEqual([
      'ujira.fixture_not_forced: row level security is not forced',
    ]);
  });

  it('fails a nullable tenant column, and a table without tenant columns', () => {
    expect(problemsOf('fixture_nullable')).toEqual([
      'ujira.fixture_nullable: principal_id is nullable',
    ]);
    expect(problemsOf('fixture_untenanted')).toEqual([
      'ujira.fixture_untenanted: has no principal_id',
      'ujira.fixture_untenanted: has no project_id',
    ]);
  });

  it('fails a granted command that has no policy', () => {
    expect(problemsOf('fixture_delete')).toEqual([
      'ujira.fixture_delete: ujira_app is granted DELETE with no policy for it',
    ]);
  });

  it('fails a foreign key to a tenant table that does not carry both tenant columns', () => {
    expect(problemsOf('fixture_loose_child')).toEqual([
      expect.stringMatching(
        /^ujira\.fixture_loose_child: foreign key \S+ to ujira\.fixture_parent does not carry its tenant columns$/,
      ),
    ]);
  });

  it('fails a table not owned by the owner role', () => {
    expect(problemsOf('fixture_wrong_owner')).toEqual([
      expect.stringMatching(/^ujira\.fixture_wrong_owner: owned by \S+, not ujira_owner$/),
    ]);
  });

  it('reports nothing beyond the broken fixtures', () => {
    const named = [
      'fixture_no_rls',
      'fixture_not_forced',
      'fixture_nullable',
      'fixture_untenanted',
      'fixture_delete',
      'fixture_loose_child',
      'fixture_wrong_owner',
    ];
    expect(
      fixtureProblems.filter(
        (problem) => !named.some((table) => problem.startsWith(`ujira.${table}:`)),
      ),
    ).toEqual([]);
  });
});

// Built after the fixtures above were read, so the tenant rules never see them.
const SEALED = `
  set role ujira_owner;
  create table ujira.fixture_sealed (id bigint);
  alter table ujira.fixture_sealed enable row level security;
  alter table ujira.fixture_sealed force row level security;
  create table ujira.fixture_sealed_granted (id bigint);
  alter table ujira.fixture_sealed_granted enable row level security;
  alter table ujira.fixture_sealed_granted force row level security;
  grant select on ujira.fixture_sealed_granted to ujira_reader;
  create table ujira.fixture_sealed_column (id bigint);
  alter table ujira.fixture_sealed_column enable row level security;
  alter table ujira.fixture_sealed_column force row level security;
  grant update (id) on ujira.fixture_sealed_column to ujira_app;
  create table ujira.fixture_sealed_open (id bigint);
  reset role;
`;

describe('sealed tables', () => {
  let sealedProblems: string[];

  beforeAll(async () => {
    await fixtureClient.query(SEALED);
    sealedProblems = await catalogProblems(fixtureClient, CATALOG_EXCEPTIONS, [
      'ujira.fixture_sealed',
      'ujira.fixture_sealed_granted',
      'ujira.fixture_sealed_column',
      'ujira.fixture_sealed_open',
    ]);
  });

  function sealedProblemsOf(table: string): string[] {
    return sealedProblems.filter((problem) => problem.startsWith(`ujira.${table}:`));
  }

  it('passes a sealed table no service role can reach, with no tenant columns', () => {
    expect(sealedProblemsOf('fixture_sealed')).toEqual([]);
  });

  it('fails a sealed table that grants a service role anything, on the table or a column', () => {
    expect(sealedProblemsOf('fixture_sealed_granted')).toEqual([
      'ujira.fixture_sealed_granted: is sealed, and ujira_reader holds a right on it',
    ]);
    expect(sealedProblemsOf('fixture_sealed_column')).toEqual([
      'ujira.fixture_sealed_column: is sealed, and ujira_app holds a right on it',
    ]);
  });

  it('fails a sealed table without forced row level security', () => {
    expect(sealedProblemsOf('fixture_sealed_open')).toEqual([
      'ujira.fixture_sealed_open: row level security is not enabled',
      'ujira.fixture_sealed_open: row level security is not forced',
    ]);
  });

  it('gives every sealed table of the migrations a reason, and each one exists', async () => {
    const client = new pg.Client({ connectionString: migrated.url });
    await client.connect();
    try {
      const found = await client.query<{ name: string }>(
        `select format('%I.%I', n.nspname, c.relname) as name
           from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where format('%I.%I', n.nspname, c.relname) = any($1::text[]) and c.relkind in ('r', 'p')
          order by 1`,
        [Object.keys(SEALED_TABLES)],
      );
      expect(found.rows.map((row) => row.name)).toEqual(Object.keys(SEALED_TABLES).sort());
      for (const reason of Object.values(SEALED_TABLES)) expect(reason.length).toBeGreaterThan(0);
    } finally {
      await client.end();
    }
  });
});
