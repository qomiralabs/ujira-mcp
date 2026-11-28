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

const QUEUE_SCHEMAS = ['graphile_worker', 'ujira_jobs'] as const;

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

  it('gives every service role usage on the schema and exactly the table rights its job needs', async () => {
    const all = await grants();
    const REFERENCE = [
      'chains',
      'currencies',
      'currency_scales',
      'settlement_tokens',
      'status_transitions',
    ].map((table) => `relation ${table} SELECT`);
    // The worker reads and writes tenant rows only where a job needs to: it
    // appends the outbox events of the payouts it moves, and reads the
    // mandate, recipient, destination and agent key a payout needs. The sealed
    // tables appear for no one. Column grants are not listed here; the tests
    // after this one pin them.
    const expected: Record<(typeof SERVICE_ROLES)[number], string[]> = {
      ujira_app: [
        ...REFERENCE,
        'relation agent_keys INSERT',
        'relation embed_sessions INSERT',
        'relation embed_sessions SELECT',
        'relation embed_settings INSERT',
        'relation embed_settings SELECT',
        'relation fee_sponsor_days INSERT',
        'relation fee_sponsor_days SELECT',
        'relation fee_sponsorships INSERT',
        'relation fee_sponsorships SELECT',
        'relation mandates INSERT',
        'relation mandates SELECT',
        'relation payout_methods INSERT',
        'relation payout_methods SELECT',
        'relation payout_legs SELECT',
        'relation payouts SELECT',
        'relation receipts SELECT',
        'relation recipient_pii INSERT',
        'relation recipient_pii SELECT',
        'relation recipients INSERT',
        'relation recipients SELECT',
        'relation signing_requests INSERT',
        'relation signing_requests SELECT',
        'relation audit_heads SELECT',
        'relation audit_log INSERT',
        'relation audit_log SELECT',
        'relation idempotency_keys INSERT',
        'relation idempotency_keys SELECT',
        'relation idempotency_keys UPDATE',
        'relation outbox_events INSERT',
        'relation outbox_events SELECT',
        'relation webhook_deliveries INSERT',
        'relation webhook_deliveries SELECT',
        'relation webhook_endpoints INSERT',
        'relation webhook_endpoints SELECT',
        'relation api_tokens INSERT',
        'relation api_tokens SELECT',
        'relation api_tokens UPDATE',
        'relation principal_members SELECT',
        'relation principals SELECT',
        'relation principals UPDATE',
        'relation projects INSERT',
        'relation projects SELECT',
        'relation projects UPDATE',
      ],
      ujira_worker: [
        ...REFERENCE,
        'relation agent_keys SELECT',
        'relation mandates SELECT',
        'relation outbox_events INSERT',
        'relation outbox_events SELECT',
        'relation payout_methods SELECT',
        'relation payout_legs SELECT',
        'relation payouts SELECT',
        'relation receipts SELECT',
        'relation recipients SELECT',
      ],
      ujira_reader: [
        ...REFERENCE,
        'relation fee_sponsor_days SELECT',
        'relation fee_sponsorships SELECT',
        'relation mandates SELECT',
        'relation payout_methods SELECT',
        'relation payout_legs SELECT',
        'relation payouts SELECT',
        'relation receipts SELECT',
        'relation recipients SELECT',
        'relation signing_requests SELECT',
        'relation audit_heads SELECT',
        'relation audit_log SELECT',
        'relation outbox_events SELECT',
        'relation webhook_deliveries SELECT',
        'relation api_tokens SELECT',
        'relation principal_members SELECT',
        'relation principals SELECT',
        'relation projects SELECT',
      ],
    };
    for (const role of SERVICE_ROLES) {
      const mine = all.filter((grant) => grant.grantee === role);
      expect(mine).toContainEqual({ object: 'schema ujira', grantee: role, privilege: 'USAGE' });
      expect(
        mine
          .filter((grant) => grant.object.startsWith('relation '))
          .map((grant) => `${grant.object} ${grant.privilege}`)
          .sort(),
        role,
      ).toEqual([...expected[role]].sort());
    }
  });

  it('lets the app change a membership role and status, and no other column', async () => {
    const columns = await client.query<{ column_name: string }>(
      `select column_name::text as column_name
         from information_schema.column_privileges
        where table_schema = 'ujira' and table_name = 'principal_members'
          and grantee = 'ujira_app' and privilege_type = 'UPDATE'
        order by 1`,
    );
    expect(columns.rows.map((row) => row.column_name)).toEqual(['role', 'status']);
  });

  it('lets the app move a fee sponsorship and its day total, and never whose it is or which transaction', async () => {
    const columns = await client.query<{ table_name: string; column_name: string }>(
      `select table_name::text as table_name, column_name::text as column_name
         from information_schema.column_privileges
        where table_schema = 'ujira'
          and table_name = any($1::text[])
          and grantee = 'ujira_app' and privilege_type = 'UPDATE'`,
      [['fee_sponsor_days', 'fee_sponsorships']],
    );
    expect(columns.rows.map((row) => `${row.table_name}.${row.column_name}`).sort()).toEqual([
      'fee_sponsor_days.used_stroops',
      'fee_sponsorships.charged_stroops',
      'fee_sponsorships.day',
      'fee_sponsorships.max_fee_stroops',
      'fee_sponsorships.status',
    ]);
  });

  it('lets the app change only what is meant to change on a mandate, a recipient, a destination and a key', async () => {
    const columns = await client.query<{ table_name: string; column_name: string }>(
      `select table_name::text as table_name, column_name::text as column_name
         from information_schema.column_privileges
        where table_schema = 'ujira'
          and table_name = any($1::text[])
          and grantee = 'ujira_app' and privilege_type = 'UPDATE'`,
      [
        [
          'agent_keys',
          'mandates',
          'recipients',
          'recipient_pii',
          'payout_methods',
          'signing_requests',
        ],
      ],
    );
    expect(columns.rows.map((row) => `${row.table_name}.${row.column_name}`).sort()).toEqual([
      'agent_keys.funded_at',
      'agent_keys.funding_attempts',
      'agent_keys.funding_error',
      'agent_keys.funding_status',
      'agent_keys.status',
      'mandates.name',
      'payout_methods.destination_checked_at',
      'payout_methods.destination_status',
      'payout_methods.verified_at',
      'recipient_pii.email_ciphertext',
      'recipient_pii.email_nonce',
      'recipients.label',
      'recipients.status',
      'signing_requests.submitted_at',
      'signing_requests.submitted_tx_hash',
    ]);
  });

  it('lets the app only revoke an embed session and replace its project origins', async () => {
    const columns = await client.query<{ grant: string }>(
      `select format('%s %s %s.%s', grantee, privilege_type, table_name, column_name) as grant
         from information_schema.column_privileges
        where table_schema = 'ujira'
          and table_name in ('embed_sessions', 'embed_settings')
          and grantee in ('ujira_app', 'ujira_worker', 'ujira_reader')
          and privilege_type = 'UPDATE'`,
    );
    expect(columns.rows.map((row) => row.grant).sort()).toEqual([
      'ujira_app UPDATE embed_sessions.revoked_at',
      'ujira_app UPDATE embed_settings.allowed_origins',
    ]);
  });

  it('lets the roles write only what a payout, a leg and a receipt are meant to take', async () => {
    const columns = await client.query<{ grant: string }>(
      `select format('%s %s %s.%s', grantee, privilege_type, table_name, column_name) as grant
         from information_schema.column_privileges
        where table_schema = 'ujira'
          and table_name in ('payouts', 'payout_legs', 'receipts')
          and grantee in ('ujira_app', 'ujira_worker', 'ujira_reader')
          and privilege_type in ('INSERT', 'UPDATE')`,
    );
    const grantsOf = (role: string, privilege: string, table: string, names: string[]) =>
      names.map((name) => `${role} ${privilege} ${table}.${name}`);
    const moves = (role: string) => [
      ...grantsOf(role, 'UPDATE', 'payouts', ['blocked_by', 'request_tx_hash', 'status']),
      ...grantsOf(role, 'UPDATE', 'payout_legs', ['chain_tx_hash', 'status']),
    ];
    // A new payout starts queued with nothing recorded, a leg starts planned
    // with its key derived, and a receipt names its payout and chain reference.
    expect(columns.rows.map((row) => row.grant).sort()).toEqual(
      [
        ...grantsOf('ujira_app', 'INSERT', 'payouts', [
          'amount',
          'asset',
          'chain',
          'fee_amount',
          'idempotency_key',
          'mandate_id',
          'metadata',
          'network',
          'onchain_payout_id',
          'principal_id',
          'project_id',
          'recipient_id',
          'request_hash',
          'scale',
          'task_id',
        ]),
        ...grantsOf('ujira_app', 'INSERT', 'payout_legs', [
          'amount',
          'asset',
          'chain',
          'destination_address',
          'fee_amount',
          'leg_index',
          'method',
          'network',
          'payout_id',
          'payout_method_id',
          'principal_id',
          'project_id',
          'recipient_id',
          'scale',
        ]),
        ...grantsOf('ujira_worker', 'INSERT', 'receipts', [
          'chain_receipt_ref',
          'payout_id',
          'principal_id',
          'project_id',
        ]),
        ...moves('ujira_app'),
        ...moves('ujira_worker'),
      ].sort(),
    );
  });

  it('lets only the worker read an agent secret, and the reader no personal data', async () => {
    const readable = async (role: string, table: string): Promise<string[]> => {
      const found = await client.query<{ column_name: string }>(
        `select a.attname::text as column_name
           from pg_attribute a
          where a.attrelid = $2::regclass and a.attnum > 0 and not a.attisdropped
            and has_column_privilege($1::name, a.attrelid, a.attnum, 'SELECT')`,
        [role, table],
      );
      return found.rows.map((row) => row.column_name).sort();
    };
    const publicColumns = [
      'created_at',
      'funded_at',
      'funding_attempts',
      'funding_error',
      'funding_status',
      'id',
      'network',
      'principal_id',
      'project_id',
      'public_key',
      'status',
      'updated_at',
    ];
    expect(await readable('ujira_app', 'ujira.agent_keys')).toEqual(publicColumns);
    expect(await readable('ujira_reader', 'ujira.agent_keys')).toEqual(publicColumns);
    expect(await readable('ujira_worker', 'ujira.agent_keys')).toEqual(
      [...publicColumns, 'secret_ciphertext', 'secret_nonce'].sort(),
    );
    expect(await readable('ujira_reader', 'ujira.recipient_pii')).toEqual([]);
    expect(await readable('ujira_worker', 'ujira.recipient_pii')).toEqual([]);
  });

  it('lets each service role call the context functions and the entry points of its job, and nothing else', async () => {
    const all = await grants();
    // The verifier recomputes hashes with the function the chain trigger uses,
    // so whoever may verify may call it. The worker writes no audit rows.
    const AUDIT_ROW_HASH =
      'function ujira.audit_row_hash(bytea,uuid,uuid,bigint,text,text,uuid,jsonb,timestamp with time zone)';
    const CONTEXT = [
      'function ujira.current_principal_id()',
      'function ujira.current_project_id()',
      'function ujira.project_scope_all()',
    ];
    const expected: Record<(typeof SERVICE_ROLES)[number], string[]> = {
      ujira_app: [
        ...CONTEXT,
        'function ujira.add_member(text,text)',
        AUDIT_ROW_HASH,
        'function ujira.auth_challenge_consume(uuid,text)',
        'function ujira.auth_challenge_create(text,text,integer)',
        'function ujira.authenticate_token(text)',
        'function ujira.create_principal(text,text,text,text)',
        'function ujira.embed_session_resolve(bytea)',
        'function ujira.session_create(bytea,text,integer,integer)',
        'function ujira.session_principals(bytea)',
        'function ujira.session_projects(bytea)',
        'function ujira.session_resolve(bytea,uuid)',
        'function ujira.session_revoke(bytea,text)',
        'function ujira.session_touch(bytea,integer)',
        'function ujira.take_rate_limit_tokens(text[],integer[],integer[])',
      ],
      ujira_worker: [
        ...CONTEXT,
        'function ujira.auth_challenges_delete_expired(integer)',
        'function ujira.embed_sessions_delete_expired(integer)',
        'function ujira.sessions_delete_expired(integer)',
      ],
      ujira_reader: [...CONTEXT, AUDIT_ROW_HASH],
    };
    for (const role of SERVICE_ROLES) {
      expect(
        all
          .filter((grant) => grant.grantee === role && grant.privilege === 'EXECUTE')
          .map((grant) => grant.object)
          .sort(),
        role,
      ).toEqual([...expected[role]].sort());
    }
  });
});

describe('roles', () => {
  it('creates exactly the owner, the logins, the definer roles and the retention role', async () => {
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
      'ujira_fn_audit',
      'ujira_fn_principals',
      'ujira_fn_rate_limits',
      'ujira_fn_sessions',
      'ujira_fn_tokens',
      'ujira_migrator',
      'ujira_ops',
      'ujira_owner',
      'ujira_reader',
      'ujira_retention',
      'ujira_worker',
    ]);
    // Only the logins a service connects with may log in. The rest hold rights
    // that code borrows through a function they own, never a connection.
    const logins = new Set(['ujira_app', 'ujira_migrator', 'ujira_reader', 'ujira_worker']);
    for (const role of roles.rows) {
      expect(role.rolsuper, role.rolname).toBe(false);
      expect(role.rolbypassrls, role.rolname).toBe(false);
      expect(role.rolcreaterole, role.rolname).toBe(false);
      expect(role.rolcreatedb, role.rolname).toBe(false);
      expect(role.rolcanlogin, role.rolname).toBe(logins.has(role.rolname));
    }
  });

  it('ujira_app has no BYPASSRLS and owns nothing, and neither do the worker and the reader', async () => {
    // Ownership skips row level security unless it is forced, and an owner
    // can turn the forcing off, so a login that owned one table could read
    // every tenant's rows in it. The worker is the one exception, for the job
    // queue alone: the library's tables allow their owner and nobody else,
    // and they hold job ids, not tenant rows.
    for (const role of SERVICE_ROLES) {
      const queue = role === 'ujira_worker' ? QUEUE_SCHEMAS : [];
      const owned = await client.query<{ object: string }>(
        `select format('schema %I', nspname) as object from pg_namespace
          where nspowner = $1::regrole and nspname <> all($2::text[])
         union all
         select format('relation %s', c.oid::regclass)
           from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where c.relowner = $1::regrole and n.nspname <> all($2::text[])
            -- A toast table and its index live in pg_toast and take the owner
            -- of the table they store for, so they count as that table's.
            and not exists (
              select from pg_class t join pg_namespace tn on tn.oid = t.relnamespace
               where tn.nspname = any($2::text[])
                 and t.reltoastrelid in (
                   c.oid,
                   (select i.indrelid from pg_index i where i.indexrelid = c.oid)
                 )
            )
         union all
         select format('function %s', p.oid::regprocedure)
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where p.proowner = $1::regrole and n.nspname <> all($2::text[])
         union all
         select format('type %s', t.oid::regtype)
           from pg_type t join pg_namespace n on n.oid = t.typnamespace
          where t.typowner = $1::regrole and n.nspname <> all($2::text[])
         union all
         select format('database %I', datname) from pg_database where datdba = $1::regrole`,
        [role, queue],
      );
      expect(owned.rows, role).toEqual([]);
      const bypass = await client.query<{ rolbypassrls: boolean }>(
        'select rolbypassrls from pg_roles where rolname = $1',
        [role],
      );
      expect(bypass.rows, role).toEqual([{ rolbypassrls: false }]);
    }
  });

  it('the worker owns the two queue schemas and no other schema', async () => {
    const schemas = await client.query<{ nspname: string }>(
      `select nspname from pg_namespace where nspowner = 'ujira_worker'::regrole order by 1`,
    );
    expect(schemas.rows.map((row) => row.nspname)).toEqual([...QUEUE_SCHEMAS]);
  });

  it('runs every security definer function as its own narrow role, never as the owner', async () => {
    const definers = await client.query<{ fn: string; owner: string; config: string[] | null }>(
      `select p.oid::regprocedure::text as fn,
              pg_get_userbyid(p.proowner) as owner,
              p.proconfig as config
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname in ('ujira', 'ops') and p.prosecdef
        order by 1`,
    );
    expect(Object.fromEntries(definers.rows.map((row) => [row.fn, row.owner]))).toEqual({
      'ops.delete_expired_security_events(integer)': 'ujira_ops',
      'ops.record_security_event(text,bytea,text,bytea)': 'ujira_ops',
      'ujira.add_member(text,text)': 'ujira_fn_principals',
      'ujira.audit_chain()': 'ujira_fn_audit',
      'ujira.auth_challenge_consume(uuid,text)': 'ujira_fn_sessions',
      'ujira.auth_challenge_create(text,text,integer)': 'ujira_fn_sessions',
      'ujira.auth_challenges_delete_expired(integer)': 'ujira_fn_sessions',
      'ujira.authenticate_token(text)': 'ujira_fn_tokens',
      'ujira.create_principal(text,text,text,text)': 'ujira_fn_principals',
      'ujira.embed_session_resolve(bytea)': 'ujira_fn_tokens',
      'ujira.embed_sessions_delete_expired(integer)': 'ujira_fn_tokens',
      'ujira.session_create(bytea,text,integer,integer)': 'ujira_fn_sessions',
      'ujira.session_principals(bytea)': 'ujira_fn_sessions',
      'ujira.session_projects(bytea)': 'ujira_fn_sessions',
      'ujira.session_resolve(bytea,uuid)': 'ujira_fn_sessions',
      'ujira.session_revoke(bytea,text)': 'ujira_fn_sessions',
      'ujira.session_touch(bytea,integer)': 'ujira_fn_sessions',
      'ujira.sessions_delete_expired(integer)': 'ujira_fn_sessions',
      'ujira.take_rate_limit_tokens(text[],integer[],integer[])': 'ujira_fn_rate_limits',
    });
    // A definer that searched the caller's path could be handed a look alike
    // function or table by anyone able to create one.
    for (const row of definers.rows) expect(row.config, row.fn).toEqual(['search_path=pg_catalog']);
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
