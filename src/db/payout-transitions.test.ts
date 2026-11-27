// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The status machines in the database against the ones in src/payouts. The
// code refuses a bad move with a typed error and the database refuses it for
// anyone who comes around the code, so the two must be the same machine: this
// compares the rows, the status lists and the terminal statuses, then tries
// every pair of statuses in the database itself.

import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import {
  LEG_STATUSES,
  LEG_TRANSITIONS,
  canLegTransition,
  type LegStatus,
} from '../payouts/leg-status.js';
import {
  PAYOUT_STATUSES,
  PAYOUT_TRANSITIONS,
  TERMINAL_STATUSES,
  canTransition,
  isTerminal,
  type PayoutStatus,
} from '../payouts/status.js';
import type { Database } from './database.js';
import { testHex32 } from './testing/accounts.js';
import { insertTenant } from './testing/admin-tenants.js';
import { databaseAsServiceRoles } from './testing/databases.js';
import { createTestDatabase, type TestDatabase } from './testing/harness.js';
import { TESTNET, payoutWorld, type PayoutWorld } from './testing/payout-fixture.js';

const adminUrl = inject('dbAdminUrl');
const roleUrls = inject('dbRoleUrls');

let database: TestDatabase;
let admin: pg.Client;
let db: Database;
let world: PayoutWorld;

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

function flatten(machine: Readonly<Record<string, readonly string[]>>): string[] {
  return Object.entries(machine)
    .flatMap(([from, exits]) => exits.map((to) => `${from} -> ${to}`))
    .sort();
}

async function transitionRows(machine: string): Promise<string[]> {
  const rows = await admin.query<{ move: string }>(
    `select from_status || ' -> ' || to_status as move
       from ujira.status_transitions where machine = $1 order by 1`,
    [machine],
  );
  return rows.rows.map((row) => row.move).sort();
}

// The quoted values of a check constraint, which is how the status lists are
// written in the migration.
async function checkValues(constraint: string): Promise<string[]> {
  const found = await admin.query<{ definition: string }>(
    'select pg_get_constraintdef(oid) as definition from pg_constraint where conname = $1',
    [constraint],
  );
  const definition = found.rows[0]?.definition ?? '';
  return [...definition.matchAll(/'([a-z_]+)'::text/g)].map((match) => match[1] ?? '').sort();
}

// A payout written straight into the table at any status, with one leg at
// any status, as only the superuser can.
async function payoutAt(
  status: PayoutStatus,
  legStatus: LegStatus = 'planned',
): Promise<{
  payoutId: string;
  legId: string;
}> {
  await admin.query('begin');
  try {
    const payout = await admin.query<{ id: string }>(
      `insert into ujira.payouts
         (principal_id, project_id, idempotency_key, request_hash, mandate_id, recipient_id,
          task_id, onchain_payout_id, network, chain, amount, asset, scale, status, blocked_by,
          settled_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'stellar', 100, 'USDC', 7, $10, $11, $12)
       returning id`,
      [
        world.context.principalId,
        world.context.projectId,
        `key-${randomUUID()}`,
        Buffer.alloc(32, 1),
        world.mandateId,
        world.recipientId,
        `task-${randomUUID()}`,
        Buffer.from(testHex32(), 'hex'),
        TESTNET,
        status,
        status === 'blocked' ? 'DAILY_CAP_EXCEEDED' : null,
        status === 'paid' ? new Date() : null,
      ],
    );
    const payoutId = payout.rows[0]?.id;
    if (payoutId === undefined) throw new Error('no payout written');
    const leg = await admin.query<{ id: string }>(
      `insert into ujira.payout_legs
         (principal_id, project_id, payout_id, recipient_id, leg_index, payout_method_id, method,
          destination_address, network, chain, asset, scale, amount, status, chain_tx_hash)
       select $1, $2, $3, $4, 0, m.id, m.method, m.destination_address, $5, 'stellar', 'USDC', 7,
              100, $6, $7
         from ujira.payout_methods as m where m.id = $8
       returning id`,
      [
        world.context.principalId,
        world.context.projectId,
        payoutId,
        world.recipientId,
        TESTNET,
        legStatus,
        legStatus === 'submitted' || legStatus === 'settled' ? Buffer.alloc(32, 9) : null,
        world.methodId,
      ],
    );
    const legId = leg.rows[0]?.id;
    if (legId === undefined) throw new Error('no leg written');
    await admin.query('commit');
    return { payoutId, legId };
  } catch (error) {
    await admin.query('rollback');
    throw error;
  }
}

const asWorker = async (work: Parameters<Database['withTenant']>[2]): Promise<unknown> =>
  db.withTenant('worker', { ...world.context, scope: 'project' }, work);

beforeAll(async () => {
  database = await createTestDatabase(adminUrl, import.meta.url);
  admin = new pg.Client({ connectionString: database.url });
  await admin.connect();
  db = databaseAsServiceRoles(roleUrls, database);
  world = await payoutWorld(db, await insertTenant(admin, 'Acme'));
});

afterAll(async () => {
  await db.close();
  await admin.end();
  await database.drop();
});

describe('the payout machine in the database', () => {
  it('holds exactly the moves of src/payouts/status.ts', async () => {
    expect(await transitionRows('payout')).toEqual(flatten(PAYOUT_TRANSITIONS));
  });

  it('allows exactly the statuses of src/payouts/status.ts', async () => {
    expect(await checkValues('payouts_status')).toEqual([...PAYOUT_STATUSES].sort());
  });

  it('writes receipts for exactly the terminal statuses', async () => {
    expect(await checkValues('receipts_status')).toEqual([...TERMINAL_STATUSES].sort());
  });

  const pairs = PAYOUT_STATUSES.flatMap((from) =>
    PAYOUT_STATUSES.filter((to) => to !== from).map((to) => [from, to] as const),
  );

  it.each(pairs)('%s to %s is allowed exactly when the code allows it', async (from, to) => {
    const { payoutId } = await payoutAt(from);
    const moved = asWorker(async (tx) =>
      tx
        .updateTable('ujira.payouts')
        .set({ status: to, blocked_by: to === 'blocked' ? 'DAILY_CAP_EXCEEDED' : null })
        .where('id', '=', payoutId)
        .execute(),
    );
    let expected: string | undefined;
    if (isTerminal(from)) expected = 'UJ007';
    else if (!canTransition(from, to)) expected = 'UJ004';
    expect(await codeOf(moved)).toBe(expected);
  });

  it.each(PAYOUT_STATUSES)(
    'a payout that is %s takes a receipt, and stops changing, exactly when it is terminal',
    async (status) => {
      const { payoutId } = await payoutAt(status);
      const touched = asWorker(async (tx) =>
        tx
          .updateTable('ujira.payouts')
          .set({ request_tx_hash: Buffer.alloc(32, 7) })
          .where('id', '=', payoutId)
          .execute(),
      );
      expect(await codeOf(touched)).toBe(isTerminal(status) ? 'UJ007' : undefined);
      const issued = asWorker(async (tx) =>
        tx
          .insertInto('ujira.receipts')
          .values({
            principal_id: world.context.principalId,
            project_id: world.context.projectId,
            payout_id: payoutId,
            chain_receipt_ref: 'ujira:tx:v1:stellar:testnet:ref:0',
          })
          .execute(),
      );
      expect(await codeOf(issued)).toBe(isTerminal(status) ? undefined : 'UJ008');
    },
  );
});

describe('the leg machine in the database', () => {
  it('holds exactly the moves of src/payouts/leg-status.ts', async () => {
    expect(await transitionRows('payout_leg')).toEqual(flatten(LEG_TRANSITIONS));
  });

  it('allows exactly the statuses of src/payouts/leg-status.ts', async () => {
    expect(await checkValues('payout_legs_status')).toEqual([...LEG_STATUSES].sort());
  });

  const pairs = LEG_STATUSES.flatMap((from) =>
    LEG_STATUSES.filter((to) => to !== from).map((to) => [from, to] as const),
  );

  it.each(pairs)('%s to %s is allowed exactly when the code allows it', async (from, to) => {
    const { legId } = await payoutAt('settling', from);
    const moved = asWorker(async (tx) =>
      tx
        .updateTable('ujira.payout_legs')
        .set({ status: to, chain_tx_hash: Buffer.alloc(32, 8) })
        .where('id', '=', legId)
        .execute(),
    );
    expect(await codeOf(moved)).toBe(canLegTransition(from, to) ? undefined : 'UJ004');
  });
});
