// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// Payouts, legs and receipts against a real database, as the roles that use
// them: the app writes payouts, the worker moves them and issues receipts.
// Every unique key is shown refusing a duplicate written by a second
// transaction while the first is still open, which is when a check in code
// alone would let both through.

import { sql, type Kysely } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import { MoneyError } from '../../money/index.js';
import { InvalidLegsError, InvalidTransitionError } from '../../payouts/errors.js';
import { allocateLegs } from '../../payouts/legs.js';
import type { Database, ProjectContext } from '../database.js';
import type { Schema } from '../schema.js';
import { testHex32 } from '../testing/accounts.js';
import { insertTenant } from '../testing/admin-tenants.js';
import { databaseAsServiceRoles } from '../testing/databases.js';
import { createTestDatabase, type TestDatabase } from '../testing/harness.js';
import {
  TESTNET,
  legKeyOf,
  newPayout,
  payoutWorld,
  recordingJobs,
  usdc,
  type PayoutWorld,
} from '../testing/payout-fixture.js';
import { PageRequestError } from './page.js';
import { payoutJob, unwiredJobQueue } from './payout-jobs.js';
import {
  PayoutConflictError,
  payoutLegs,
  payouts,
  type NewPayout,
  type Payout,
} from './payouts.js';
import { receipts } from './receipts.js';
import { RepositoryInputError } from './values.js';

type Tx = Kysely<Schema>;

const adminUrl = inject('dbAdminUrl');
const roleUrls = inject('dbRoleUrls');

let database: TestDatabase;
let admin: pg.Client;
let second: pg.Client;
let db: Database;
let world: PayoutWorld;

interface Violation {
  readonly code: string | undefined;
  readonly constraint: string | undefined;
}

function violationOf(error: unknown): Violation {
  const failed = error as { code?: string; constraint?: string };
  return { code: failed.code, constraint: failed.constraint };
}

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return violationOf(error).code;
  }
}

const asApp = async <T>(work: (tx: Tx) => Promise<T>, context = world.context): Promise<T> =>
  db.tenant(context).transaction(work);
const asWorker = async <T>(work: (tx: Tx) => Promise<T>, context = world.context): Promise<T> =>
  db.withTenant('worker', { ...context, scope: 'project' }, work);

async function create(input: NewPayout = newPayout(world)) {
  return asApp(async (tx) => payouts.create(tx, input, unwiredJobQueue));
}

// Moves a payout along a path of allowed statuses, as the worker would.
async function drive(id: string, path: readonly Payout['status'][]): Promise<Payout> {
  let current = await asApp(async (tx) => payouts.get(tx, id));
  if (current === undefined) throw new Error('no payout to drive');
  for (const to of path) {
    const from: Payout['status'] = current.status;
    const moved: Payout | undefined = await asWorker(async (tx) =>
      payouts.transition(tx, id, {
        from,
        to,
        ...(to === 'blocked' ? { blockedBy: 'DAILY_CAP_EXCEEDED' } : {}),
      }),
    );
    if (moved === undefined) throw new Error(`the payout did not move to ${to}`);
    current = moved;
  }
  return current;
}

const TO_PAID: readonly Payout['status'][] = ['submitting', 'approved', 'settling', 'paid'];

async function rowsOf(table: string, context: ProjectContext = world.context): Promise<number> {
  const counted = await admin.query<{ count: string }>(
    `select count(*)::text as count from ${table} where principal_id = $1 and project_id = $2`,
    [context.principalId, context.projectId],
  );
  return Number.parseInt(counted.rows[0]?.count ?? '0', 10);
}

// A payout row with no repository in the way, for showing what the database
// refuses on its own.
function rawPayout(
  overrides: Partial<{
    key: string;
    task: string;
    onchain: string;
    amount: string;
    fee: string;
    network: string;
    metadata: string;
    recipientId: string;
  }> = {},
) {
  return async (tx: Tx) =>
    tx
      .insertInto('ujira.payouts')
      .values({
        principal_id: world.context.principalId,
        project_id: world.context.projectId,
        idempotency_key: overrides.key ?? `raw-${testHex32().slice(0, 16)}`,
        request_hash: Buffer.alloc(32, 1),
        mandate_id: world.mandateId,
        recipient_id: overrides.recipientId ?? world.recipientId,
        task_id: overrides.task ?? `raw-${testHex32().slice(0, 16)}`,
        onchain_payout_id: Buffer.from(overrides.onchain ?? testHex32(), 'hex'),
        network: overrides.network ?? TESTNET,
        chain: 'stellar',
        amount: overrides.amount ?? '100',
        fee_amount: overrides.fee ?? '0',
        asset: 'USDC',
        scale: 7,
        metadata: overrides.metadata ?? '{}',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
}

function rawLeg(
  payoutId: string,
  index: number,
  amount: string,
  overrides: Partial<{ fee: string; methodId: string; recipientId: string }> = {},
) {
  return async (tx: Tx) => {
    const method = await tx
      .selectFrom('ujira.payout_methods')
      .select(['method', 'destination_address'])
      .where('id', '=', overrides.methodId ?? world.methodId)
      .executeTakeFirstOrThrow();
    return tx
      .insertInto('ujira.payout_legs')
      .values({
        principal_id: world.context.principalId,
        project_id: world.context.projectId,
        payout_id: payoutId,
        recipient_id: overrides.recipientId ?? world.recipientId,
        leg_index: index,
        payout_method_id: overrides.methodId ?? world.methodId,
        method: method.method,
        destination_address: method.destination_address,
        network: TESTNET,
        chain: 'stellar',
        asset: 'USDC',
        scale: 7,
        amount,
        fee_amount: overrides.fee ?? '0',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
  };
}

// Until the second transaction is seen waiting on a lock, or has already
// answered, which would mean it never waited and the test says so.
async function waitForLockWait(answered: () => boolean): Promise<void> {
  for (let tries = 0; tries < 400 && !answered(); tries += 1) {
    // Activity is read once per transaction unless the snapshot is dropped,
    // and the first racer polls from inside its own.
    await admin.query('select pg_stat_clear_snapshot()');
    const waiting = await admin.query<{ count: number }>(
      `select count(*)::int as count from pg_stat_activity
        where datname = current_database() and wait_event_type = 'Lock'`,
    );
    if ((waiting.rows[0]?.count ?? 0) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('the second transaction never waited on the first');
}

// The first transaction writes and stays open; the second writes the
// duplicate and waits on the first's uncommitted row; the first commits, and
// the second's answer is returned.
async function race(
  first: (tx: Tx) => Promise<unknown>,
  secondWork: (tx: Tx) => Promise<unknown>,
  role: 'app' | 'worker' = 'app',
): Promise<Violation | undefined> {
  const run = role === 'app' ? asApp : asWorker;
  let wrote = (): void => undefined;
  const written = new Promise<void>((resolve) => {
    wrote = resolve;
  });
  let release = (): void => undefined;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const one = run(async (tx) => {
    await first(tx);
    wrote();
    await released;
  });
  await Promise.race([written, one]);
  let answered = false;
  const two = run(secondWork)
    .then(
      () => undefined,
      (error: unknown) => violationOf(error),
    )
    .finally(() => {
      answered = true;
    });
  try {
    await waitForLockWait(() => answered);
  } finally {
    release();
    await one;
  }
  return two;
}

// The same, on two superuser connections, for what the service roles cannot
// write at all.
async function adminRace(firstSql: string[], secondSql: string[]): Promise<Violation | undefined> {
  await admin.query('begin');
  let answered = false;
  try {
    for (const statement of firstSql) await admin.query(statement);
    await second.query('begin');
    const two = (async () => {
      for (const statement of secondSql) await second.query(statement);
    })()
      .then(
        () => undefined,
        (error: unknown) => violationOf(error),
      )
      .finally(() => {
        answered = true;
      });
    await waitForLockWait(() => answered);
    await admin.query('commit');
    const answer = await two;
    await second.query('rollback');
    return answer;
  } catch (error) {
    await admin.query('rollback');
    await second.query('rollback');
    throw error;
  }
}

beforeAll(async () => {
  database = await createTestDatabase(adminUrl, import.meta.url);
  admin = new pg.Client({ connectionString: database.url });
  await admin.connect();
  second = new pg.Client({ connectionString: database.url });
  await second.connect();
  db = databaseAsServiceRoles(roleUrls, database, 3);
});

beforeEach(async () => {
  world = await payoutWorld(db, await insertTenant(admin, 'Acme'));
});

afterAll(async () => {
  await db.close();
  await second.end();
  await admin.end();
  await database.drop();
});

describe('creating a payout', () => {
  it('writes the payout, its leg and its first job in one transaction', async () => {
    const jobs = recordingJobs();
    const input = newPayout(world, { metadata: { batch: 'week-48' } });
    const created = await asApp(async (tx) => payouts.create(tx, input, jobs));
    expect(created.created).toBe(true);
    expect(created.payout).toEqual({
      id: expect.any(String) as string,
      projectId: world.context.projectId,
      mandateId: world.mandateId,
      recipientId: world.recipientId,
      taskId: input.taskId,
      idempotencyKey: input.idempotencyKey,
      network: TESTNET,
      amount: usdc(25_000_000n),
      fee: usdc(0n),
      status: 'queued',
      blockedBy: null,
      onchainPayoutId: input.onchainPayoutId,
      requestTxHash: null,
      metadata: { batch: 'week-48' },
      createdAt: expect.any(Date) as Date,
      updatedAt: expect.any(Date) as Date,
      settledAt: null,
    });
    const id = created.payout.id;
    expect(created.legs).toEqual([
      {
        id: expect.any(String) as string,
        payoutId: id,
        index: 0,
        payoutMethodId: world.methodId,
        method: 'stellar_wallet',
        destination: world.destination,
        amount: usdc(25_000_000n),
        fee: usdc(0n),
        legKey: legKeyOf(id, 0),
        txHash: null,
        status: 'planned',
        createdAt: expect.any(Date) as Date,
        updatedAt: expect.any(Date) as Date,
      },
    ]);
    expect(jobs.jobs).toEqual([
      {
        task: 'payout.advance',
        queue: `agent:${world.context.projectId}`,
        jobKey: `payout:${id}:payout.advance`,
        payload: { ...world.context, payoutId: id },
      },
    ]);
    expect(await asApp(async (tx) => payouts.get(tx, id))).toEqual(created.payout);
    expect(await asApp(async (tx) => payoutLegs.list(tx, id))).toEqual(created.legs);
  });

  it('writes nothing when the job cannot be queued', async () => {
    const failing = {
      enqueue: () => Promise.reject(new Error('queue down')),
    };
    await expect(
      asApp(async (tx) => payouts.create(tx, newPayout(world), failing)),
    ).rejects.toThrow('queue down');
    expect(await rowsOf('ujira.payouts')).toBe(0);
    expect(await rowsOf('ujira.payout_legs')).toBe(0);
  });

  it('answers a retry with the payout it made, and queues nothing more', async () => {
    const input = newPayout(world);
    const first = await create(input);
    const jobs = recordingJobs();
    const again = await asApp(async (tx) => payouts.create(tx, input, jobs));
    expect(again).toEqual({ ...first, created: false });
    expect(jobs.jobs).toEqual([]);
    expect(await rowsOf('ujira.payouts')).toBe(1);
  });

  it('refuses the same key for another request, and the same task under another key', async () => {
    const input = newPayout(world);
    await create(input);
    await expect(
      create({ ...newPayout(world), idempotencyKey: input.idempotencyKey }),
    ).rejects.toEqual(new PayoutConflictError('IDEMPOTENCY_KEY_REUSED'));
    await expect(create({ ...newPayout(world), taskId: input.taskId })).rejects.toEqual(
      new PayoutConflictError('TASK_ID_REUSED'),
    );
    await expect(
      create({ ...newPayout(world), onchainPayoutId: input.onchainPayoutId }),
    ).rejects.toEqual(new PayoutConflictError('ONCHAIN_PAYOUT_ID_REUSED'));
    expect(await rowsOf('ujira.payouts')).toBe(1);
  });

  it('lets two projects use the same key and task', async () => {
    const other = await payoutWorld(db, await insertTenant(admin, 'Other'));
    const input = newPayout(world);
    await create(input);
    const there = await asApp(
      async (tx) =>
        payouts.create(
          tx,
          newPayout(other, { idempotencyKey: input.idempotencyKey, taskId: input.taskId }),
          unwiredJobQueue,
        ),
      other.context,
    );
    expect(there.created).toBe(true);
  });

  it('writes a payout the quote refused as blocked, with its legs cancelled and its receipt queued', async () => {
    const jobs = recordingJobs();
    const created = await asApp(async (tx) =>
      payouts.create(tx, newPayout(world, { blockedBy: 'RECIPIENT_NOT_ALLOWED' }), jobs),
    );
    expect(created.payout.status).toBe('blocked');
    expect(created.payout.blockedBy).toBe('RECIPIENT_NOT_ALLOWED');
    expect(created.legs.map((leg) => leg.status)).toEqual(['cancelled']);
    expect(jobs.jobs).toEqual([
      payoutJob('receipt.issue', { ...world.context, payoutId: created.payout.id }),
    ]);
    expect(jobs.jobs[0]?.queue).toBeNull();
  });

  it('splits a payout into legs that add up, the remainder on leg 0', async () => {
    const total = usdc(10_000_001n);
    const split = allocateLegs(total, [1n, 1n]);
    const created = await create(
      newPayout(world, {
        amount: total,
        legs: split.map((leg) => ({ payoutMethodId: world.methodId, amount: leg.amount })),
      }),
    );
    expect(created.legs.map((leg) => [leg.index, leg.amount.amount, leg.legKey])).toEqual([
      [0, 5_000_001n, legKeyOf(created.payout.id, 0)],
      [1, 5_000_000n, legKeyOf(created.payout.id, 1)],
    ]);
  });

  it('refuses legs that do not add up, before any row', async () => {
    const make = (overrides: Partial<NewPayout>) => create(newPayout(world, overrides));
    await expect(
      make({ legs: [{ payoutMethodId: world.methodId, amount: usdc(1n) }] }),
    ).rejects.toBeInstanceOf(InvalidLegsError);
    await expect(make({ legs: [] })).rejects.toBeInstanceOf(InvalidLegsError);
    const five = Array.from({ length: 5 }, () => ({
      payoutMethodId: world.methodId,
      amount: usdc(5_000_000n),
    }));
    await expect(make({ legs: five })).rejects.toBeInstanceOf(InvalidLegsError);
    await expect(
      make({
        legs: [
          { payoutMethodId: world.methodId, amount: usdc(25_000_000n) },
          { payoutMethodId: world.methodId, amount: usdc(0n) },
        ],
      }),
    ).rejects.toBeInstanceOf(InvalidLegsError);
    await expect(
      make({
        legs: [{ payoutMethodId: world.methodId, amount: usdc(25_000_000n), fee: usdc(1n) }],
      }),
    ).rejects.toBeInstanceOf(InvalidLegsError);
    expect(await rowsOf('ujira.payouts')).toBe(0);
  });

  it('refuses money in another unit than the payout', async () => {
    const amount = usdc(25_000_000n);
    const fiatLike = { ...amount, asset: 'USDT' } as unknown as typeof amount;
    await expect(
      create(newPayout(world, { legs: [{ payoutMethodId: world.methodId, amount: fiatLike }] })),
    ).rejects.toBeInstanceOf(MoneyError);
  });

  it('refuses a fee on testnet', async () => {
    const amount = usdc(25_000_000n);
    const charged = create(
      newPayout(world, {
        fee: usdc(1n),
        legs: [{ payoutMethodId: world.methodId, amount, fee: usdc(1n) }],
      }),
    );
    expect(await codeOf(charged)).toBe('23514');
    expect(await codeOf(asApp(rawPayout({ fee: '1' })))).toBe('23514');
  });

  it('refuses a recipient who is not on the mandate, and a wallet that is not the recipient', async () => {
    const other = await payoutWorld(db, world.context);
    expect(await codeOf(create(newPayout(world, { recipientId: other.recipientId })))).toBe(
      '23503',
    );
    const amount = usdc(25_000_000n);
    expect(
      await codeOf(
        create(newPayout(world, { legs: [{ payoutMethodId: world.otherMethodId, amount }] })),
      ),
    ).toBe('23503');
    expect(await rowsOf('ujira.payouts')).toBe(0);
  });

  it('refuses a payout in another network than its mandate', async () => {
    expect(await codeOf(asApp(rawPayout({ network: 'stellar:pubnet' })))).toBe('23503');
  });

  it('refuses input no row can hold, naming the field', async () => {
    const make = (overrides: Partial<NewPayout>) => create(newPayout(world, overrides));
    await expect(make({ idempotencyKey: 'has space' })).rejects.toEqual(
      new RepositoryInputError('idempotencyKey'),
    );
    await expect(make({ taskId: 'x'.repeat(129) })).rejects.toEqual(
      new RepositoryInputError('taskId'),
    );
    await expect(make({ requestHash: 'AB'.repeat(32) })).rejects.toEqual(
      new RepositoryInputError('requestHash'),
    );
    await expect(make({ onchainPayoutId: 'ab' })).rejects.toEqual(
      new RepositoryInputError('onchainPayoutId'),
    );
    await expect(make({ blockedBy: 'not a code' })).rejects.toEqual(
      new RepositoryInputError('blockedBy'),
    );
    const many = Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`k${String(i)}`, 'v']));
    await expect(make({ metadata: many })).rejects.toEqual(new RepositoryInputError('metadata'));
    await expect(make({ metadata: { long: 'x'.repeat(257) } })).rejects.toEqual(
      new RepositoryInputError('metadata'),
    );
    await expect(make({ metadata: { '': 'empty key' } })).rejects.toEqual(
      new RepositoryInputError('metadata'),
    );
    await expect(make({ metadata: ['list'] as unknown as Record<string, string> })).rejects.toEqual(
      new RepositoryInputError('metadata'),
    );
    expect(await rowsOf('ujira.payouts')).toBe(0);
  });

  it('keeps a metadata key such as __proto__ as a key', async () => {
    const metadata = JSON.parse('{"__proto__":"kept"}') as Record<string, string>;
    const created = await create(newPayout(world, { metadata }));
    expect(Object.keys(created.payout.metadata)).toEqual(['__proto__']);
    expect(Object.getPrototypeOf(created.payout.metadata)).toBe(Object.prototype);
  });

  it('bounds metadata in the database as well', async () => {
    const many = JSON.stringify(
      Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`k${String(i)}`, 'v'])),
    );
    expect(await codeOf(asApp(rawPayout({ metadata: many })))).toBe('UJ009');
    expect(await codeOf(asApp(rawPayout({ metadata: '{"n":1}' })))).toBe('UJ009');
    expect(
      await codeOf(asApp(rawPayout({ metadata: JSON.stringify({ v: 'x'.repeat(257) }) }))),
    ).toBe('UJ009');
    expect(await codeOf(asApp(rawPayout({ metadata: '[]' })))).toBe('23514');
  });

  it('lets the app write a payout only as queued, with nothing recorded yet', async () => {
    const planted = {
      status: 'paid',
      blocked_by: 'X',
      request_tx_hash: Buffer.alloc(32, 2),
      settled_at: new Date(),
      id: '00000000-0000-4000-8000-000000000001',
    };
    for (const [column, value] of Object.entries(planted)) {
      // The column is added to an otherwise valid row.
      const write = asApp(async (tx) =>
        sql`insert into ujira.payouts
              (principal_id, project_id, idempotency_key, request_hash, mandate_id, recipient_id,
               task_id, onchain_payout_id, network, chain, amount, asset, scale, ${sql.ref(column)})
            values (${world.context.principalId}::uuid, ${world.context.projectId}::uuid,
                    ${`planted-${column}`}, ${Buffer.alloc(32, 1)}, ${world.mandateId}::uuid,
                    ${world.recipientId}::uuid, ${`planted-${column}`},
                    ${Buffer.from(testHex32(), 'hex')}, ${TESTNET}, 'stellar', 100, 'USDC', 7,
                    ${value})`.execute(tx),
      );
      expect(await codeOf(write), column).toBe('42501');
    }
  });
});

describe('the database keeps the legs and the total together', () => {
  it('refuses at commit a payout with no legs', async () => {
    expect(await codeOf(asApp(rawPayout()))).toBe('UJ005');
    expect(await rowsOf('ujira.payouts')).toBe(0);
  });

  it('refuses at commit legs that pay more or less than the total, or charge another fee', async () => {
    const short = asApp(async (tx) => {
      const { id } = await rawPayout({ amount: '100' })(tx);
      await rawLeg(id, 0, '60')(tx);
      await rawLeg(id, 1, '39')(tx);
    });
    expect(await codeOf(short)).toBe('UJ005');
    const over = asApp(async (tx) => {
      const { id } = await rawPayout({ amount: '100' })(tx);
      await rawLeg(id, 0, '101')(tx);
    });
    expect(await codeOf(over)).toBe('UJ005');
    expect(await rowsOf('ujira.payouts')).toBe(0);
    expect(await rowsOf('ujira.payout_legs')).toBe(0);
  });

  it('accepts legs written in any order within the transaction', async () => {
    await asApp(async (tx) => {
      const { id } = await rawPayout({ amount: '100' })(tx);
      await rawLeg(id, 1, '40')(tx);
      await rawLeg(id, 0, '60')(tx);
    });
    expect(await rowsOf('ujira.payout_legs')).toBe(2);
  });

  it('refuses a leg added later to a payout that already adds up', async () => {
    const { payout } = await create();
    expect(await codeOf(asApp(rawLeg(payout.id, 1, '1')))).toBe('UJ005');
  });

  it('refuses a leg paying another recipient than the payout', async () => {
    const planted = asApp(async (tx) => {
      const { id } = await rawPayout({ amount: '100' })(tx);
      await rawLeg(id, 0, '100', {
        methodId: world.otherMethodId,
        recipientId: world.otherRecipientId,
      })(tx);
    });
    expect(await codeOf(planted)).toBe('23503');
  });

  it('never lets the app change what a payout or a leg pays', async () => {
    const { payout, legs } = await create();
    const leg = legs[0];
    if (leg === undefined) throw new Error('no leg');
    for (const [column, value] of [
      ['amount', '1'],
      ['fee_amount', '0'],
      ['recipient_id', world.otherRecipientId],
      ['mandate_id', world.mandateId],
      ['task_id', 'moved'],
      ['idempotency_key', 'moved'],
      ['onchain_payout_id', Buffer.alloc(32, 3)],
      ['metadata', '{}'],
      ['settled_at', new Date()],
    ] as const) {
      const moved = asApp(async (tx) =>
        sql`update ujira.payouts set ${sql.ref(column)} = ${value}
             where id = ${payout.id}::uuid`.execute(tx),
      );
      expect(await codeOf(moved), column).toBe('42501');
    }
    for (const [column, value] of [
      ['amount', '1'],
      ['destination_address', 'GELSEWHERE'],
      ['payout_method_id', world.otherMethodId],
      ['leg_key', Buffer.alloc(32, 4)],
    ] as const) {
      const moved = asApp(async (tx) =>
        sql`update ujira.payout_legs set ${sql.ref(column)} = ${value}
             where id = ${leg.id}::uuid`.execute(tx),
      );
      expect(await codeOf(moved), column).toBe('42501');
    }
  });

  it('never deletes a payout, a leg or a receipt, even for the owner', async () => {
    const { payout } = await create();
    await drive(payout.id, ['failed']);
    await asWorker(async (tx) => receipts.issue(tx, payout.id, null));
    for (const table of ['ujira.payouts', 'ujira.payout_legs', 'ujira.receipts']) {
      expect(
        await codeOf(asApp(async (tx) => tx.deleteFrom(table as 'ujira.payouts').execute())),
        table,
      ).toBe('42501');
      expect(await codeOf(admin.query(`delete from ${table}`)), table).toBe('UJ002');
      expect(await codeOf(admin.query(`truncate ${table} cascade`)), table).toBe('UJ002');
    }
  });
});

describe('unique keys under two concurrent transactions', () => {
  it('refuses a second payout with the same idempotency key', async () => {
    const input = newPayout(world);
    const answer = await race(
      async (tx) => payouts.create(tx, input, unwiredJobQueue),
      rawPayout({ key: input.idempotencyKey }),
    );
    expect(answer).toEqual({ code: '23505', constraint: 'payouts_idempotency' });
  });

  it('refuses a second payout for the same task on the mandate', async () => {
    const input = newPayout(world);
    const answer = await race(
      async (tx) => payouts.create(tx, input, unwiredJobQueue),
      rawPayout({ task: input.taskId }),
    );
    expect(answer).toEqual({ code: '23505', constraint: 'payouts_task' });
  });

  it('refuses a second payout with the same on chain id on the mandate', async () => {
    const input = newPayout(world);
    const answer = await race(
      async (tx) => payouts.create(tx, input, unwiredJobQueue),
      rawPayout({ onchain: input.onchainPayoutId }),
    );
    expect(answer).toEqual({ code: '23505', constraint: 'payouts_onchain_id' });
  });

  // A copy of leg 0 at another index for one unit. Without a key the trigger
  // derives it; with one, the caller runs in replica mode, which skips that
  // trigger, so the race can aim at one unique key and not the other.
  const copyLeg = (payoutId: string, index: number, legKey?: string): string => `
    insert into ujira.payout_legs
      (principal_id, project_id, payout_id, recipient_id, leg_index, payout_method_id, method,
       destination_address, network, chain, asset, scale, amount${legKey === undefined ? '' : ', leg_key'})
    select l.principal_id, l.project_id, l.payout_id, l.recipient_id, ${String(index)},
           l.payout_method_id, l.method, l.destination_address, l.network, l.chain, l.asset,
           l.scale, 1${legKey === undefined ? '' : `, '\\x${legKey}'::bytea`}
      from ujira.payout_legs as l
     where l.payout_id = '${payoutId}' and l.leg_index = 0`;
  // The first transaction takes one unit off leg 0 for its new leg, so it
  // still adds up when it commits.
  const firstLeg = (payoutId: string): string[] => [
    `update ujira.payout_legs set amount = amount - 1 where payout_id = '${payoutId}'`,
    copyLeg(payoutId, 1),
  ];

  it('refuses a second leg at the same index of a payout', async () => {
    const { payout } = await create();
    const answer = await adminRace(firstLeg(payout.id), [
      'set local session_replication_role = replica',
      copyLeg(payout.id, 1, testHex32()),
    ]);
    expect(answer).toEqual({ code: '23505', constraint: 'payout_legs_index' });
  });

  it('refuses a second leg with the same key at another index', async () => {
    const { payout } = await create();
    const key = legKeyOf(payout.id, 1);
    const answer = await adminRace(firstLeg(payout.id), [
      'set local session_replication_role = replica',
      copyLeg(payout.id, 2, key),
    ]);
    expect(answer).toEqual({ code: '23505', constraint: 'payout_legs_leg_key' });
    const stored = await admin.query<{ leg_key: Buffer }>(
      'select leg_key from ujira.payout_legs where payout_id = $1 and leg_index = 1',
      [payout.id],
    );
    expect(stored.rows[0]?.leg_key.toString('hex')).toBe(key);
  });

  it('refuses a second receipt for a payout', async () => {
    const { payout } = await create();
    await drive(payout.id, ['failed']);
    const write = async (tx: Tx) =>
      tx
        .insertInto('ujira.receipts')
        .values({
          principal_id: world.context.principalId,
          project_id: world.context.projectId,
          payout_id: payout.id,
        })
        .execute();
    expect(await race(write, write, 'worker')).toEqual({
      code: '23505',
      constraint: 'receipts_payout',
    });
  });

  it('gives two identical concurrent creates one payout', async () => {
    const input = newPayout(world);
    const results = await Promise.all(Array.from({ length: 4 }, () => create(input)));
    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(new Set(results.map((result) => result.payout.id)).size).toBe(1);
    expect(await rowsOf('ujira.payouts')).toBe(1);
  });

  it('gives one of two concurrent creates of a task under two keys a typed refusal', async () => {
    const input = newPayout(world);
    const results = await Promise.allSettled([
      create(input),
      create({ ...newPayout(world), taskId: input.taskId }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const refused = results.find((result) => result.status === 'rejected');
    expect(refused?.reason).toEqual(new PayoutConflictError('TASK_ID_REUSED'));
  });
});

describe('moving a payout', () => {
  it('moves along the machine, and reports a payout no longer where the caller thought', async () => {
    const { payout } = await create();
    const moved = await asWorker(async (tx) =>
      payouts.transition(tx, payout.id, { from: 'queued', to: 'submitting' }),
    );
    expect(moved?.status).toBe('submitting');
    expect(
      await asWorker(async (tx) =>
        payouts.transition(tx, payout.id, { from: 'queued', to: 'submitting' }),
      ),
    ).toBeUndefined();
  });

  it('refuses a move the machine does not allow, in code and in the database', async () => {
    const { payout } = await create();
    await expect(
      asWorker(async (tx) => payouts.transition(tx, payout.id, { from: 'queued', to: 'paid' })),
    ).rejects.toBeInstanceOf(InvalidTransitionError);
    const around = asWorker(async (tx) =>
      tx
        .updateTable('ujira.payouts')
        .set({ status: 'approved' })
        .where('id', '=', payout.id)
        .execute(),
    );
    expect(await codeOf(around)).toBe('UJ004');
  });

  it('blocks with a spec error, and only then', async () => {
    const { payout } = await create();
    await expect(
      asWorker(async (tx) => payouts.transition(tx, payout.id, { from: 'queued', to: 'blocked' })),
    ).rejects.toEqual(new RepositoryInputError('blockedBy'));
    await expect(
      asWorker(async (tx) =>
        payouts.transition(tx, payout.id, {
          from: 'queued',
          to: 'submitting',
          blockedBy: 'DAILY_CAP_EXCEEDED',
        }),
      ),
    ).rejects.toEqual(new RepositoryInputError('blockedBy'));
    const blocked = await asWorker(async (tx) =>
      payouts.transition(tx, payout.id, {
        from: 'queued',
        to: 'blocked',
        blockedBy: 'DAILY_CAP_EXCEEDED',
      }),
    );
    expect(blocked?.blockedBy).toBe('DAILY_CAP_EXCEEDED');
    const another = (await create()).payout;
    const bare = asApp(async (tx) =>
      tx
        .updateTable('ujira.payouts')
        .set({ status: 'blocked' })
        .where('id', '=', another.id)
        .execute(),
    );
    expect(await codeOf(bare)).toBe('23514');
  });

  it('records the request transaction once, and stamps the time it was paid', async () => {
    const { payout } = await create();
    const hash = testHex32();
    const submitted = await asWorker(async (tx) =>
      payouts.transition(tx, payout.id, { from: 'queued', to: 'submitting' }),
    );
    expect(submitted?.requestTxHash).toBeNull();
    const approved = await asWorker(async (tx) =>
      payouts.transition(tx, payout.id, {
        from: 'submitting',
        to: 'approved',
        requestTxHash: hash,
      }),
    );
    expect(approved?.requestTxHash).toBe(hash);
    const rewritten = asWorker(async (tx) =>
      payouts.transition(tx, payout.id, {
        from: 'approved',
        to: 'settling',
        requestTxHash: testHex32(),
      }),
    );
    expect(await codeOf(rewritten)).toBe('UJ006');
    const paid = await drive(payout.id, ['settling', 'paid']);
    expect(paid.requestTxHash).toBe(hash);
    expect(paid.settledAt).toBeInstanceOf(Date);
    await expect(
      asWorker(async (tx) =>
        payouts.transition(tx, payout.id, {
          from: 'approved',
          to: 'settling',
          requestTxHash: 'xy',
        }),
      ),
    ).rejects.toEqual(new RepositoryInputError('requestTxHash'));
  });

  it('never changes a payout that has finished', async () => {
    const { payout } = await create();
    await drive(payout.id, ['blocked']);
    for (const set of [
      { blocked_by: 'OTHER_REASON' },
      { request_tx_hash: Buffer.alloc(32, 5) },
      { status: 'blocked' },
    ] as const) {
      const changed = asWorker(async (tx) =>
        tx.updateTable('ujira.payouts').set(set).where('id', '=', payout.id).execute(),
      );
      expect(await codeOf(changed), Object.keys(set).join()).toBe('UJ007');
    }
  });

  it('finds a payout by its task', async () => {
    const input = newPayout(world);
    const { payout } = await create(input);
    expect(
      (await asApp(async (tx) => payouts.findByTask(tx, world.mandateId, input.taskId)))?.id,
    ).toBe(payout.id);
    expect(
      await asApp(async (tx) => payouts.findByTask(tx, world.mandateId, 'another-task')),
    ).toBeUndefined();
  });
});

describe('moving a leg', () => {
  it('records the send and the settlement', async () => {
    const { legs } = await create();
    const leg = legs[0];
    if (leg === undefined) throw new Error('no leg');
    const txHash = testHex32();
    const sent = await asWorker(async (tx) =>
      payoutLegs.transition(tx, leg.id, { from: 'planned', to: 'submitted', txHash }),
    );
    expect(sent).toMatchObject({ status: 'submitted', txHash });
    const settled = await asWorker(async (tx) =>
      payoutLegs.transition(tx, leg.id, { from: 'submitted', to: 'settled' }),
    );
    expect(settled).toMatchObject({ status: 'settled', txHash });
    expect(
      await asWorker(async (tx) =>
        payoutLegs.transition(tx, leg.id, { from: 'submitted', to: 'settled' }),
      ),
    ).toBeUndefined();
  });

  it('refuses a send with no transaction, and a move the machine does not allow', async () => {
    const { legs } = await create();
    const leg = legs[0];
    if (leg === undefined) throw new Error('no leg');
    expect(
      await codeOf(
        asWorker(async (tx) =>
          payoutLegs.transition(tx, leg.id, { from: 'planned', to: 'submitted' }),
        ),
      ),
    ).toBe('23514');
    await expect(
      asWorker(async (tx) => payoutLegs.transition(tx, leg.id, { from: 'settled', to: 'planned' })),
    ).rejects.toBeInstanceOf(InvalidTransitionError);
    await asWorker(async (tx) =>
      payoutLegs.transition(tx, leg.id, { from: 'planned', to: 'cancelled' }),
    );
    const revived = asWorker(async (tx) =>
      tx
        .updateTable('ujira.payout_legs')
        .set({ status: 'planned' })
        .where('id', '=', leg.id)
        .execute(),
    );
    expect(await codeOf(revived)).toBe('UJ004');
    await expect(
      asWorker(async (tx) =>
        payoutLegs.transition(tx, leg.id, { from: 'planned', to: 'submitted', txHash: 'nope' }),
      ),
    ).rejects.toEqual(new RepositoryInputError('txHash'));
  });
});

describe('listing payouts', () => {
  it('pages newest first, keeping rows written in one transaction apart', async () => {
    const together = await asApp(async (tx) => {
      const made: Payout[] = [];
      for (let i = 0; i < 3; i += 1) {
        made.push((await payouts.create(tx, newPayout(world), unwiredJobQueue)).payout);
      }
      return made;
    });
    const later = (await create()).payout;
    const expected = [
      later.id,
      ...together
        .map((payout) => payout.id)
        .sort()
        .reverse(),
    ];
    const first = await asApp(async (tx) => payouts.list(tx, {}, { limit: 2 }));
    expect(first.items.map((payout) => payout.id)).toEqual(expected.slice(0, 2));
    expect(first.next).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z\|/);
    const rest = await asApp(async (tx) =>
      payouts.list(tx, {}, { limit: 2, after: first.next ?? '' }),
    );
    expect(rest.items.map((payout) => payout.id)).toEqual(expected.slice(2));
    expect(rest.next).toBeNull();
  });

  it('filters by status, mandate, recipient and creation time', async () => {
    const other = await payoutWorld(db, world.context);
    const queued = (await create()).payout;
    const failed = (await create()).payout;
    await drive(failed.id, ['failed']);
    const elsewhere = (
      await create(
        newPayout(other, {
          recipientId: other.otherRecipientId,
          legs: [{ payoutMethodId: other.otherMethodId, amount: usdc(25_000_000n) }],
        }),
      )
    ).payout;
    const ids = async (filter: Parameters<typeof payouts.list>[1]) =>
      (await asApp(async (tx) => payouts.list(tx, filter, { limit: 100 }))).items
        .map((payout) => payout.id)
        .sort();
    expect(await ids({ status: 'failed' })).toEqual([failed.id]);
    expect(await ids({ mandateId: world.mandateId })).toEqual([queued.id, failed.id].sort());
    expect(await ids({ recipientId: other.otherRecipientId })).toEqual([elsewhere.id]);
    expect(await ids({ createdFrom: new Date(Date.now() + 60_000) })).toEqual([]);
    expect(await ids({ createdTo: new Date(Date.now() - 60_000) })).toEqual([]);
    expect(
      await ids({
        createdFrom: new Date(Date.now() - 60_000),
        createdTo: new Date(Date.now() + 60_000),
      }),
    ).toHaveLength(3);
  });

  it('refuses a key it did not hand out', async () => {
    for (const after of ['', 'garbage', `2026-01-01T00:00:00.000Z|${world.mandateId}`]) {
      await expect(
        asApp(async (tx) => payouts.list(tx, {}, { limit: 10, after })),
      ).rejects.toBeInstanceOf(PageRequestError);
    }
  });
});

describe('receipts', () => {
  it('copies a finished payout into its receipt, once', async () => {
    const { payout } = await create();
    const hash = testHex32();
    await drive(payout.id, ['submitting']);
    await asWorker(async (tx) =>
      payouts.transition(tx, payout.id, {
        from: 'submitting',
        to: 'approved',
        requestTxHash: hash,
      }),
    );
    const paid = await drive(payout.id, ['settling', 'paid']);
    const ref = `ujira:tx:v1:stellar:testnet:${testHex32()}:0`;
    const issued = await asWorker(async (tx) => receipts.issue(tx, payout.id, ref));
    expect(issued).toEqual({
      created: true,
      receipt: {
        id: expect.any(String) as string,
        projectId: world.context.projectId,
        payoutId: payout.id,
        status: 'paid',
        blockedBy: null,
        network: TESTNET,
        amount: usdc(25_000_000n),
        fee: usdc(0n),
        chainReceiptRef: ref,
        requestTxHash: hash,
        settledAt: paid.settledAt,
        createdAt: expect.any(Date) as Date,
      },
    });
    const again = await asWorker(async (tx) => receipts.issue(tx, payout.id, ref));
    expect(again).toEqual({ ...issued, created: false });
    expect(await asApp(async (tx) => receipts.get(tx, issued.receipt.id))).toEqual(issued.receipt);
    expect(await asApp(async (tx) => receipts.forPayout(tx, payout.id))).toEqual(issued.receipt);
  });

  it('issues a receipt for a refusal, with the spec error', async () => {
    const { payout } = await create(newPayout(world, { blockedBy: 'MANDATE_PAUSED' }));
    const { receipt } = await asWorker(async (tx) => receipts.issue(tx, payout.id, null));
    expect(receipt).toMatchObject({
      status: 'blocked',
      blockedBy: 'MANDATE_PAUSED',
      chainReceiptRef: null,
    });
  });

  it('refuses a receipt for a payout still moving, and a paid one without its reference', async () => {
    const { payout } = await create();
    expect(await codeOf(asWorker(async (tx) => receipts.issue(tx, payout.id, null)))).toBe('UJ008');
    await drive(payout.id, TO_PAID);
    expect(await codeOf(asWorker(async (tx) => receipts.issue(tx, payout.id, null)))).toBe('23514');
    await expect(
      asWorker(async (tx) => receipts.issue(tx, payout.id, 'has space')),
    ).rejects.toEqual(new RepositoryInputError('chainReceiptRef'));
    expect(await rowsOf('ujira.receipts')).toBe(0);
  });

  it('holds a chain reference to 512 characters in the database itself', async () => {
    // Written past the repository's own check, so this is the table's rule.
    // Postgres caps a regular expression bound at 255, and a check written as
    // {1,512} threw on every reference instead of judging it.
    const issue = async (ref: string) => {
      const { payout } = await create();
      await drive(payout.id, ['failed']);
      return asWorker(async (tx) =>
        tx
          .insertInto('ujira.receipts')
          .values({
            principal_id: world.context.principalId,
            project_id: world.context.projectId,
            payout_id: payout.id,
            chain_receipt_ref: ref,
          })
          .execute(),
      );
    };
    expect(await codeOf(issue('a'.repeat(512)))).toBeUndefined();
    expect(await codeOf(issue('a'.repeat(513)))).toBe('23514');
    expect(await codeOf(issue('has space'))).toBe('23514');
    expect(await codeOf(issue(''))).toBe('23514');
    expect(await rowsOf('ujira.receipts')).toBe(1);
  });

  it('writes what it copies whatever the caller names, and never changes', async () => {
    const { payout } = await create();
    await drive(payout.id, ['failed']);
    await asWorker(async (tx) =>
      tx
        .insertInto('ujira.receipts')
        .values({
          principal_id: world.context.principalId,
          project_id: world.context.projectId,
          payout_id: payout.id,
        })
        .execute(),
    );
    const planted = asWorker(async (tx) =>
      tx
        .insertInto('ujira.receipts')
        .values({
          principal_id: world.context.principalId,
          project_id: world.context.projectId,
          payout_id: payout.id,
          amount: '1',
        })
        .execute(),
    );
    expect(await codeOf(planted)).toBe('42501');
    expect(await codeOf(asApp(async (tx) => receipts.issue(tx, payout.id, null)))).toBe('42501');
    expect(await codeOf(admin.query(`update ujira.receipts set chain_receipt_ref = 'x'`))).toBe(
      'UJ002',
    );
  });

  it('lists receipts newest first, in pages', async () => {
    const made: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const { payout } = await create();
      await drive(payout.id, ['failed']);
      made.push((await asWorker(async (tx) => receipts.issue(tx, payout.id, null))).receipt.id);
    }
    const first = await asApp(async (tx) => receipts.list(tx, { limit: 2 }));
    expect(first.items.map((receipt) => receipt.id)).toEqual([made[2], made[1]]);
    const rest = await asApp(async (tx) =>
      receipts.list(tx, { limit: 2, after: first.next ?? '' }),
    );
    expect(rest.items.map((receipt) => receipt.id)).toEqual([made[0]]);
    expect(rest.next).toBeNull();
  });
});
