// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// What each role may do in schema ujira, read from the catalog. Supabase's
// API roles exist on every project and its Data API acts as them, so they
// must hold nothing here, and neither may PUBLIC, which they are all members
// of. A missing ACL means the default, and the default lets PUBLIC execute
// every function and use every type, so defaults are expanded before they
// are read.

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { SERVICE_ROLES } from './testing/catalog.js';
import { createTestDatabase, PLATFORM_ROLES, type TestDatabase } from './testing/harness.js';

const adminUrl = inject('dbAdminUrl');

let database: TestDatabase;
let client: pg.Client;

beforeAll(async () => {
  database = await createTestDatabase(adminUrl, import.meta.url);
  client = new pg.Client({ connectionString: database.url });
  await client.connect();
});

afterAll(async () => {
  await client.end();
  await database.drop();
});

interface Grant {
  readonly object: string;
  readonly grantee: string;
  readonly privilege: string;
}

// Every privilege on schema ujira and on every table, sequence, function,
// domain and enum in it, plus the owner's default privileges, with a null
// ACL read as the default it stands for. Row types and array types follow
// their table or element and need USAGE on the schema to be reached, which
// the first row covers.
const GRANTS = `
  with objects (object, acl) as (
    select 'schema ujira', coalesce(n.nspacl, acldefault('n', n.nspowner))
      from pg_namespace n where n.nspname = 'ujira'
    union all
    select format('relation %I', c.relname), coalesce(c.relacl, acldefault('r', c.relowner))
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'ujira' and c.relkind in ('r', 'p', 'v', 'm', 'S', 'f')
    union all
    select format('function %s', p.oid::regprocedure), coalesce(p.proacl, acldefault('f', p.proowner))
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'ujira'
    union all
    select format('type %s', t.oid::regtype), coalesce(t.typacl, acldefault('T', t.typowner))
      from pg_type t join pg_namespace n on n.oid = t.typnamespace
     where n.nspname = 'ujira' and t.typtype in ('d', 'e')
    union all
    select format('default privileges of %s on %s', pg_get_userbyid(d.defaclrole), d.defaclobjtype), d.defaclacl
      from pg_default_acl d
     where d.defaclrole = 'ujira_owner'::regrole
  )
  select o.object,
         case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end as grantee,
         a.privilege_type as privilege
    from objects o, aclexplode(o.acl) a
`;

async function grants(): Promise<Grant[]> {
  return (await client.query<Grant>(GRANTS)).rows;
}

describe('grants on ujira', () => {
  it('anon, authenticated, service_role and PUBLIC have no grants on ujira', async () => {
    const all = await grants();
    // The query is not vacuous: the service roles do hold grants.
    expect(all.some((grant) => grant.grantee === 'ujira_app')).toBe(true);
    const forbidden = new Set<string>(['PUBLIC', ...PLATFORM_ROLES]);
    expect(all.filter((grant) => forbidden.has(grant.grantee))).toEqual([]);
  });

  it('the API roles exist here, as they do on Supabase, so the check above is not vacuous', async () => {
    const found = await client.query<{ rolname: string }>(
      'select rolname from pg_roles where rolname = any($1::text[]) order by rolname',
      [[...PLATFORM_ROLES]],
    );
    expect(found.rows.map((row) => row.rolname)).toEqual([...PLATFORM_ROLES].sort());
  });

  it('gives every service role usage on the schema and nothing but reads of the reference data', async () => {
    const all = await grants();
    for (const role of SERVICE_ROLES) {
      const mine = all.filter((grant) => grant.grantee === role);
      expect(mine).toContainEqual({ object: 'schema ujira', grantee: role, privilege: 'USAGE' });
      // No tenant table exists yet, so each role reads the reference tables
      // and writes nothing. A migration that adds a table changes this.
      const relations = mine.filter((grant) => grant.object.startsWith('relation '));
      expect(
        relations.filter((grant) => grant.privilege !== 'SELECT'),
        role,
      ).toEqual([]);
      expect(relations.map((grant) => grant.object).sort(), role).toEqual([
        'relation chains',
        'relation currencies',
        'relation currency_scales',
        'relation settlement_tokens',
        'relation status_transitions',
      ]);
    }
  });

  it('lets the service roles call the context functions, and nothing else', async () => {
    const all = await grants();
    for (const role of SERVICE_ROLES) {
      expect(
        all
          .filter((grant) => grant.grantee === role && grant.privilege === 'EXECUTE')
          .map((grant) => grant.object)
          .sort(),
        role,
      ).toEqual([
        'function ujira.current_principal_id()',
        'function ujira.current_project_id()',
        'function ujira.project_scope_all()',
      ]);
    }
  });
});

describe('roles', () => {
  it('creates exactly the owner, the migrator, the app, the worker and the reader', async () => {
    const roles = await client.query<{
      rolname: string;
      rolsuper: boolean;
      rolbypassrls: boolean;
      rolcanlogin: boolean;
      rolcreaterole: boolean;
      rolcreatedb: boolean;
    }>(
      `select rolname, rolsuper, rolbypassrls, rolcanlogin, rolcreaterole, rolcreatedb
         from pg_roles where rolname like 'ujira\\_%' order by rolname`,
    );
    expect(roles.rows.map((role) => role.rolname)).toEqual([
      'ujira_app',
      'ujira_migrator',
      'ujira_owner',
      'ujira_reader',
      'ujira_worker',
    ]);
    for (const role of roles.rows) {
      expect(role.rolsuper, role.rolname).toBe(false);
      expect(role.rolbypassrls, role.rolname).toBe(false);
      expect(role.rolcreaterole, role.rolname).toBe(false);
      expect(role.rolcreatedb, role.rolname).toBe(false);
      expect(role.rolcanlogin, role.rolname).toBe(role.rolname !== 'ujira_owner');
    }
  });

  it('ujira_app has no BYPASSRLS and owns nothing, and neither do the worker and the reader', async () => {
    // Ownership skips row level security unless it is forced, and an owner
    // can turn the forcing off, so a login that owned one table could read
    // every tenant's rows in it.
    for (const role of SERVICE_ROLES) {
      const owned = await client.query<{ object: string }>(
        `select format('schema %I', nspname) as object from pg_namespace where nspowner = $1::regrole
         union all
         select format('relation %s', oid::regclass) from pg_class where relowner = $1::regrole
         union all
         select format('function %s', oid::regprocedure) from pg_proc where proowner = $1::regrole
         union all
         select format('type %s', oid::regtype) from pg_type where typowner = $1::regrole
         union all
         select format('database %I', datname) from pg_database where datdba = $1::regrole`,
        [role],
      );
      expect(owned.rows, role).toEqual([]);
      const bypass = await client.query<{ rolbypassrls: boolean }>(
        'select rolbypassrls from pg_roles where rolname = $1',
        [role],
      );
      expect(bypass.rows, role).toEqual([{ rolbypassrls: false }]);
    }
  });

  it('has no security definer function yet, so nothing runs with the owner rights', async () => {
    const definers = await client.query<{ fn: string }>(
      `select p.oid::regprocedure::text as fn
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'ujira' and p.prosecdef`,
    );
    expect(definers.rows).toEqual([]);
  });

  it('the owner role owns the schema and everything in it', async () => {
    const owners = await client.query<{ owner: string }>(
      `select distinct pg_get_userbyid(owner) as owner from (
         select nspowner as owner from pg_namespace where nspname = 'ujira'
         union all
         select c.relowner from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'ujira'
         union all
         select p.proowner from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'ujira' and not p.prosecdef
         union all
         select t.typowner from pg_type t join pg_namespace n on n.oid = t.typnamespace where n.nspname = 'ujira'
       ) as everything`,
    );
    expect(owners.rows).toEqual([{ owner: 'ujira_owner' }]);
  });

  it('only the migrator is a member of the owner role among the logins', async () => {
    const members = await client.query<{ member: string }>(
      `select pg_get_userbyid(m.member) as member
         from pg_auth_members m
        where m.roleid = 'ujira_owner'::regrole
          and pg_get_userbyid(m.member) like 'ujira\\_%'`,
    );
    expect(members.rows).toEqual([{ member: 'ujira_migrator' }]);
  });

  it('the app role carries server side statement, lock and idle timeouts', async () => {
    const settings = await client.query<{ setting: string }>(
      `select unnest(s.setconfig) as setting
         from pg_db_role_setting s
        where s.setrole = 'ujira_app'::regrole and s.setdatabase = 0
        order by 1`,
    );
    expect(settings.rows.map((row) => row.setting)).toEqual([
      'idle_in_transaction_session_timeout=10s',
      'lock_timeout=3s',
      'statement_timeout=5s',
    ]);
  });
});
