// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// Reads the system catalog and lists every way a table in schema ujira falls
// short of the tenant rules. A table is reference data, a sealed table, or a
// tenant table. Reference data is the same for every tenant. A sealed table
// holds no tenant's rows and must be out of every service role's reach: owned
// by ujira_owner, row level security forced, and no right on it, so the only
// way in is a security definer function, which names exactly what it reads.
// A tenant table must:
//
// - be owned by ujira_owner, so no login role skips row level security by
//   owning it;
// - have row level security enabled and forced;
// - carry its tenant columns as uuid and not null: principal_id and
//   project_id, unless TENANT_COLUMNS names others for a tenant root;
// - have a policy for every command granted to a service role, so a grant
//   can never silently match no rows or every row;
// - point at another tenant table only through a foreign key that carries
//   every tenant column of the target, so a row can never reference another
//   tenant's row.
//
// Every new tenant table is held to this the moment it is migrated, by the
// catalog test, without anyone remembering to add a test for it.

import type pg from 'pg';

export const CATALOG_SCHEMA = 'ujira';

// Reference data, the same for every tenant and writable only by the owner.
export const CATALOG_EXCEPTIONS: readonly string[] = [
  'ujira.chains',
  'ujira.currencies',
  'ujira.currency_scales',
  'ujira.settlement_tokens',
  'ujira.status_transitions',
  // The allowlist of audit metadata keys, which no tenant can write.
  'ujira.audit_metadata_keys',
];

// The sealed tables, each with why it belongs to no tenant.
export const SEALED_TABLES: Readonly<Record<string, string>> = {
  // A person, keyed by the wallet they sign in with, who can belong to several
  // principals. Found or made by create_principal, add_member and
  // session_create only; a membership carries the address a tenant may read.
  'ujira.members': 'a person across principals, reached only by the definer functions',
  // Issued before anyone is known, and spent by the sign in that follows.
  'ujira.auth_challenges': 'issued before any tenant is known',
  // How a request finds which principals a person may act for, so it cannot
  // run under one of them.
  'ujira.sessions': 'resolves to a tenant, so cannot sit under one',
  // Keyed by a digest of what is limited; the key format refuses a raw id.
  'ujira.rate_limit_buckets': 'counters keyed by digests, with no tenant data',
};

export interface TenantColumns {
  readonly principal: string;
  // Null for a table that belongs to a whole principal rather than to one
  // of its projects.
  readonly project: string | null;
}

const DEFAULT_COLUMNS: TenantColumns = { principal: 'principal_id', project: 'project_id' };

// The tenant roots, which carry their tenant under other names: a principal
// is its own principal, a project its own project, and a membership belongs
// to the whole principal, since a person's role holds in every project of it.
// So does an audit head, because one chain runs across all of a principal's
// projects, and a fee sponsor day, because the daily fee cap does too.
export const TENANT_COLUMNS: Readonly<Record<string, TenantColumns>> = {
  'ujira.principals': { principal: 'id', project: null },
  'ujira.projects': { principal: 'principal_id', project: 'id' },
  'ujira.principal_members': { principal: 'principal_id', project: null },
  'ujira.audit_heads': { principal: 'principal_id', project: null },
  'ujira.fee_sponsor_days': { principal: 'principal_id', project: null },
};

// The logins that serve traffic. Every grant to one of them on a tenant
// table must be matched by a policy.
export const SERVICE_ROLES = ['ujira_app', 'ujira_worker', 'ujira_reader'] as const;

const COMMANDS = [
  ['SELECT', 'r'],
  ['INSERT', 'a'],
  ['UPDATE', 'w'],
  ['DELETE', 'd'],
] as const;

interface TableRow {
  readonly oid: number;
  readonly name: string;
  readonly owner: string;
  readonly rls: boolean;
  readonly forced: boolean;
}

interface ColumnRow {
  readonly table_oid: number;
  readonly column: string;
  readonly type: string;
  readonly not_null: boolean;
  readonly attnum: number;
}

interface GrantRow {
  readonly table_oid: number;
  readonly role: string;
  readonly command: string;
  readonly covered: boolean;
}

interface ForeignKeyRow {
  readonly name: string;
  readonly source_oid: number;
  readonly target_oid: number;
  readonly source_columns: number[];
  readonly target_columns: number[];
}

export function tenantColumnsOf(table: string): TenantColumns {
  return TENANT_COLUMNS[table] ?? DEFAULT_COLUMNS;
}

export async function catalogProblems(
  client: pg.ClientBase,
  exceptions: readonly string[] = CATALOG_EXCEPTIONS,
  sealed: readonly string[] = Object.keys(SEALED_TABLES),
): Promise<string[]> {
  const tables = (
    await client.query<TableRow>(
      `select c.oid::int as oid,
              format('%I.%I', n.nspname, c.relname) as name,
              pg_get_userbyid(c.relowner) as owner,
              c.relrowsecurity as rls,
              c.relforcerowsecurity as forced
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = $1 and c.relkind in ('r', 'p')
        order by 2`,
      [CATALOG_SCHEMA],
    )
  ).rows;
  const tenant = tables.filter(
    (table) => !exceptions.includes(table.name) && !sealed.includes(table.name),
  );
  const sealedTables = tables.filter((table) => sealed.includes(table.name));
  const tenantOids = new Set(tenant.map((table) => table.oid));
  const nameOf = new Map(tables.map((table) => [table.oid, table.name]));
  const columnsOf = (oid: number): TenantColumns => tenantColumnsOf(nameOf.get(oid) ?? '');
  const problems: string[] = [];

  const names = new Set<string>([DEFAULT_COLUMNS.principal, 'project_id']);
  for (const columns of Object.values(TENANT_COLUMNS)) {
    names.add(columns.principal);
    if (columns.project !== null) names.add(columns.project);
  }
  const columns = (
    await client.query<ColumnRow>(
      `select a.attrelid::int as table_oid,
              a.attname as column,
              format_type(a.atttypid, a.atttypmod) as type,
              a.attnotnull as not_null,
              a.attnum::int as attnum
         from pg_attribute a
        where a.attrelid = any($1::oid[])
          and a.attname = any($2::text[])
          and not a.attisdropped`,
      [[...tenantOids], [...names]],
    )
  ).rows;
  const column = (oid: number, name: string): ColumnRow | undefined =>
    columns.find((row) => row.table_oid === oid && row.column === name);

  for (const table of tenant) {
    if (table.owner !== 'ujira_owner') {
      problems.push(`${table.name}: owned by ${table.owner}, not ujira_owner`);
    }
    if (!table.rls) problems.push(`${table.name}: row level security is not enabled`);
    if (!table.forced) problems.push(`${table.name}: row level security is not forced`);
    const expected = tenantColumnsOf(table.name);
    for (const name of [expected.principal, expected.project]) {
      if (name === null) continue;
      const found = column(table.oid, name);
      if (found === undefined) {
        problems.push(`${table.name}: has no ${name}`);
      } else {
        if (found.type !== 'uuid') problems.push(`${table.name}: ${name} is not a uuid`);
        if (!found.not_null) problems.push(`${table.name}: ${name} is nullable`);
      }
    }
  }

  // A grant with no policy for its command matches no row under forced row
  // level security, which hides a mistake rather than reporting it.
  const grants = (
    await client.query<GrantRow>(
      `select t.oid::int as table_oid, r.rolname as role, cmd.command,
              exists (
                select 1 from pg_policy p
                 where p.polrelid = t.oid
                   and p.polcmd in (cmd.code, '*')
                   and (r.oid = any(p.polroles) or 0::oid = any(p.polroles))
              ) as covered
         from unnest($1::oid[]) as t (oid)
         cross join unnest($2::text[]) as r0 (rolname)
         join pg_roles r on r.rolname = r0.rolname
         cross join unnest($3::text[], $4::text[]) as cmd (command, code)
        where has_table_privilege(r.oid, t.oid, cmd.command)`,
      [
        [...tenantOids],
        [...SERVICE_ROLES],
        COMMANDS.map(([command]) => command),
        COMMANDS.map(([, code]) => code),
      ],
    )
  ).rows;
  for (const grant of grants) {
    if (!grant.covered) {
      problems.push(
        `${nameOf.get(grant.table_oid) ?? String(grant.table_oid)}: ${grant.role} is granted ${grant.command} with no policy for it`,
      );
    }
  }

  const foreignKeys = (
    await client.query<ForeignKeyRow>(
      `select conname as name,
              conrelid::int as source_oid,
              confrelid::int as target_oid,
              conkey::int[] as source_columns,
              confkey::int[] as target_columns
         from pg_constraint
        where contype = 'f' and conrelid = any($1::oid[])`,
      [[...tenantOids]],
    )
  ).rows;
  for (const key of foreignKeys) {
    if (!tenantOids.has(key.target_oid)) continue;
    const source = columnsOf(key.source_oid);
    const target = columnsOf(key.target_oid);
    // Each tenant column of the target must be filled from the source's
    // column of the same kind, in the same position of the key.
    const pairs: [string | null, string | null][] = [
      [source.principal, target.principal],
      [source.project, target.project],
    ];
    const composite = pairs.every(([from, to]) => {
      if (to === null) return true;
      if (from === null) return false;
      const sourceAt = column(key.source_oid, from)?.attnum;
      const targetAt = column(key.target_oid, to)?.attnum;
      if (sourceAt === undefined || targetAt === undefined) return false;
      const position = key.source_columns.indexOf(sourceAt);
      return position !== -1 && key.target_columns[position] === targetAt;
    });
    if (!composite) {
      problems.push(
        `${nameOf.get(key.source_oid) ?? String(key.source_oid)}: foreign key ${key.name} to ${nameOf.get(key.target_oid) ?? String(key.target_oid)} does not carry its tenant columns`,
      );
    }
  }

  for (const table of sealedTables) {
    if (table.owner !== 'ujira_owner') {
      problems.push(`${table.name}: owned by ${table.owner}, not ujira_owner`);
    }
    if (!table.rls) problems.push(`${table.name}: row level security is not enabled`);
    if (!table.forced) problems.push(`${table.name}: row level security is not forced`);
  }
  // Any right at all, on the table or on one column, is a way in that no
  // definer function guards.
  const reachable = (
    await client.query<{ table_oid: number; role: string }>(
      `select t.oid::int as table_oid, r.rolname as role
         from unnest($1::oid[]) as t (oid)
         cross join unnest($2::text[]) as r0 (rolname)
         join pg_roles r on r.rolname = r0.rolname
        where has_table_privilege(r.oid, t.oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
           or has_any_column_privilege(r.oid, t.oid, 'SELECT, INSERT, UPDATE, REFERENCES')
        order by 1, 2`,
      [sealedTables.map((table) => table.oid), [...SERVICE_ROLES]],
    )
  ).rows;
  for (const row of reachable) {
    problems.push(
      `${nameOf.get(row.table_oid) ?? String(row.table_oid)}: is sealed, and ${row.role} holds a right on it`,
    );
  }

  return problems;
}
