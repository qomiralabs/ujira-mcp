// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// Holds schema ops to the terms of its exception. It is allowed to skip the
// tenant columns only because it holds nothing about a tenant, so this reads
// the catalog and reports anything that says otherwise:
//
// - a tenant column;
// - a foreign key between ops and ujira, in either direction;
// - a column whose name or comment reads like personal data.
//
// The security events test runs this against the migrated schema and against
// a column added to break it.

import type pg from 'pg';

const TENANT_COLUMN_NAMES: ReadonlySet<string> = new Set(['principal_id', 'project_id']);

// Whole words of a snake case name or of a comment, so `address` matches
// `recipient_address` and not `addressable`.
const PERSONAL_DATA = /(?:^|[^a-z])(?:name|email|phone|address|country|document)(?:[^a-z]|$)/i;

// security_events.email_hmac holds an HMAC and its own check refuses anything
// else, which security-events.test.ts tries to break. It is the only column
// allowed past the pattern above, by its full name.
export const OPS_COLUMN_EXCEPTIONS: ReadonlySet<string> = new Set([
  'ops.security_events.email_hmac',
]);

interface OpsColumnRow {
  readonly table_name: string;
  readonly column_name: string;
  readonly comment: string | null;
}

interface ForeignKeyRow {
  readonly source: string;
  readonly target: string;
  readonly name: string;
}

export async function opsCatalogProblems(client: pg.ClientBase): Promise<string[]> {
  const problems: string[] = [];
  const columns = (
    await client.query<OpsColumnRow>(
      `select c.relname as table_name,
              a.attname as column_name,
              col_description(c.oid, a.attnum) as comment
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
         join pg_attribute a on a.attrelid = c.oid
        where n.nspname = 'ops'
          and c.relkind in ('r', 'p')
          and a.attnum > 0
          and not a.attisdropped
        order by 1, a.attnum`,
    )
  ).rows;
  for (const row of columns) {
    const column = `ops.${row.table_name}.${row.column_name}`;
    if (TENANT_COLUMN_NAMES.has(row.column_name)) {
      problems.push(`${column}: is a tenant column`);
    }
    if (OPS_COLUMN_EXCEPTIONS.has(column)) continue;
    if (PERSONAL_DATA.test(row.column_name)) {
      problems.push(`${column}: the name reads like personal data`);
    }
    if (row.comment !== null && PERSONAL_DATA.test(row.comment)) {
      problems.push(`${column}: the comment reads like personal data`);
    }
  }
  problems.push(...(await crossSchemaKeys(client)));
  return problems;
}

// Foreign keys between ops and ujira, in either direction. Neither schema may
// depend on the other's rows, so the exception stays one that can be read
// about and checked on its own.
export async function crossSchemaKeys(client: pg.ClientBase): Promise<string[]> {
  const keys = (
    await client.query<ForeignKeyRow>(
      `select format('%I.%I', sn.nspname, s.relname) as source,
              format('%I.%I', tn.nspname, t.relname) as target,
              k.conname as name
         from pg_constraint k
         join pg_class s on s.oid = k.conrelid
         join pg_namespace sn on sn.oid = s.relnamespace
         join pg_class t on t.oid = k.confrelid
         join pg_namespace tn on tn.oid = t.relnamespace
        where k.contype = 'f'
          and ((sn.nspname = 'ops' and tn.nspname = 'ujira')
            or (sn.nspname = 'ujira' and tn.nspname = 'ops'))
        order by 1, 3`,
    )
  ).rows;
  return keys.map((key) => `${key.source}: foreign key ${key.name} crosses to ${key.target}`);
}
