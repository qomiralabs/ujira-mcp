// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The shared triggers, attached to fixture tables the way a migration
// attaches them to real ones.

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { createTestDatabase, type TestDatabase } from './testing/harness.js';

const adminUrl = inject('dbAdminUrl');

let database: TestDatabase;
let client: pg.Client;

beforeAll(async () => {
  database = await createTestDatabase(adminUrl, import.meta.url);
  client = new pg.Client({ connectionString: database.url });
  await client.connect();
  await client.query(`
    create table public.entries (id bigint primary key, note text not null);
    create trigger entries_append_only before update or delete on public.entries
      for each row execute function ujira.forbid_mutation();

    insert into ujira.status_transitions (machine, from_status, to_status) values
      ('fixture', 'pending', 'sent'),
      ('fixture', 'sent', 'settled');
    create table public.jobs (
      id bigint primary key,
      status text not null,
      note text,
      updated_at timestamptz not null default '2000-01-01'
    );
    create trigger jobs_transition before update on public.jobs
      for each row execute function ujira.check_transition('fixture');
    create trigger jobs_touch before update on public.jobs
      for each row execute function ujira.touch();
  `);
  await client.query(`insert into public.entries values (1, 'kept')`);
  await client.query(`insert into public.jobs (id, status) values (1, 'pending'), (2, 'pending')`);
});

afterAll(async () => {
  await client.end();
  await database.drop();
});

async function failure(sql: string): Promise<{ code?: string; message?: string }> {
  try {
    await client.query(sql);
    return {};
  } catch (error) {
    return error as { code?: string; message?: string };
  }
}

describe('forbid_mutation', () => {
  it('refuses update and delete with UJ002 and keeps the row', async () => {
    const update = await failure(`update public.entries set note = 'changed'`);
    expect(update.code).toBe('UJ002');
    expect(update.message).toBe('public.entries is append only: update is refused');
    expect((await failure('delete from public.entries')).code).toBe('UJ002');
    const rows = await client.query<{ note: string }>('select note from public.entries');
    expect(rows.rows).toEqual([{ note: 'kept' }]);
  });

  it('still allows an insert', async () => {
    await client.query(`insert into public.entries values (2, 'added')`);
    const count = await client.query<{ count: string }>('select count(*) from public.entries');
    expect(count.rows[0]?.count).toBe('2');
  });
});

describe('check_transition', () => {
  it('allows a move the machine lists, step by step', async () => {
    await client.query(`update public.jobs set status = 'sent' where id = 1`);
    await client.query(`update public.jobs set status = 'settled' where id = 1`);
    const row = await client.query<{ status: string }>(
      'select status from public.jobs where id = 1',
    );
    expect(row.rows[0]?.status).toBe('settled');
  });

  it('refuses a move the machine does not list with UJ004', async () => {
    const skipped = await failure(`update public.jobs set status = 'settled' where id = 2`);
    expect(skipped.code).toBe('UJ004');
    expect(skipped.message).toBe('fixture cannot move from pending to settled');
    expect((await failure(`update public.jobs set status = 'pending' where id = 1`)).code).toBe(
      'UJ004',
    );
  });

  it('lets an update that leaves the status alone through', async () => {
    await client.query(`update public.jobs set note = 'same status' where id = 2`);
    const row = await client.query<{ status: string }>(
      'select status from public.jobs where id = 2',
    );
    expect(row.rows[0]?.status).toBe('pending');
  });
});

describe('touch', () => {
  it('sets updated_at on every update', async () => {
    await client.query(`update public.jobs set note = 'touched' where id = 2`);
    const row = await client.query<{ fresh: boolean }>(
      `select updated_at > now() - interval '1 minute' as fresh from public.jobs where id = 2`,
    );
    expect(row.rows[0]?.fresh).toBe(true);
  });
});
