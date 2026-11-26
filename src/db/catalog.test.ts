// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { catalogProblems } from './testing/catalog.js';
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
