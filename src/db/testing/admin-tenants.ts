// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// Principals and projects written straight into the tables as the superuser,
// for tests of the tables that hang off them. Those tests are about their own
// table, so they should not depend on how the tenancy service creates a
// principal, only on the two rows every tenant row points at.

import type pg from 'pg';

import type { ProjectContext } from '../database.js';

export async function insertProject(
  admin: pg.ClientBase,
  principalId: string,
  name: string,
): Promise<string> {
  const project = await admin.query<{ id: string }>(
    'insert into ujira.projects (principal_id, name) values ($1, $2) returning id',
    [principalId, name],
  );
  const id = project.rows[0]?.id;
  if (id === undefined) throw new Error('the project insert returned no row');
  return id;
}

export async function insertTenant(admin: pg.ClientBase, name: string): Promise<ProjectContext> {
  const principal = await admin.query<{ id: string }>(
    'insert into ujira.principals (name) values ($1) returning id',
    [name],
  );
  const principalId = principal.rows[0]?.id;
  if (principalId === undefined) throw new Error('the principal insert returned no row');
  return { principalId, projectId: await insertProject(admin, principalId, name) };
}
