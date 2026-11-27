// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// Payouts and their legs. A payout is written with its legs and its first job
// in the caller's one transaction, before anything is sent on chain. A retry
// with the same idempotency key and request finds the payout it made; the same
// key for another request, or the same task on the mandate under another key,
// is refused by a unique constraint and reported as a typed error.
//
// Status moves are checked here, for a typed error, and by the database, for
// anyone who comes around this code. Each move names the status it expects to
// leave, so two workers racing on one payout cannot both move it.

import { sql, type Kysely } from 'kysely';

import { equals, sum, tokenAmount, type TokenAmount } from '../../money/index.js';
import { InvalidLegsError } from '../../payouts/errors.js';
import { assertLegTransition, isLegStatus, type LegStatus } from '../../payouts/leg-status.js';
import { MAX_LEGS } from '../../payouts/legs.js';
import { assertTransition, isPayoutStatus, type PayoutStatus } from '../../payouts/status.js';
import { amountParam, tokenFromRow } from '../money-mapper.js';
import type { Schema } from '../schema.js';
import { PAGE_TIME, olderThan, pageKey } from './newest-first.js';
import { checkedLimit, pageOf, type Page, type PageRequest } from './page.js';
import { payoutJob, type PayoutJobQueue } from './payout-jobs.js';
import type { PayoutMethodKind } from './recipients.js';
import { RepositoryInputError, bytesHex32, hex32Bytes } from './values.js';

type Tx = Kysely<Schema>;

const CURRENT_PRINCIPAL = sql<string>`ujira.current_principal_id()`;
const CURRENT_PROJECT = sql<string>`ujira.current_project_id()`;

// The same forms the columns check, so a caller gets a typed error naming the
// field instead of a constraint violation.
const IDEMPOTENCY_KEY = /^[A-Za-z0-9_.:-]{1,255}$/;
const TASK_ID = /^[A-Za-z0-9._:/@#-]{1,128}$/;
const SPEC_ERROR = /^[A-Z][A-Z0-9_]{0,63}$/;
const MAX_METADATA_KEYS = 16;
const MAX_METADATA_LENGTH = 256;

export type PayoutConflict =
  'IDEMPOTENCY_KEY_REUSED' | 'TASK_ID_REUSED' | 'ONCHAIN_PAYOUT_ID_REUSED';

const CONFLICT_MESSAGES: Readonly<Record<PayoutConflict, string>> = {
  IDEMPOTENCY_KEY_REUSED: 'this idempotency key was used for a different payout',
  TASK_ID_REUSED: 'this task already has a payout on this mandate, under another key',
  ONCHAIN_PAYOUT_ID_REUSED: 'this on chain payout id already belongs to another payout',
};

export class PayoutConflictError extends Error {
  override readonly name = 'PayoutConflictError';

  constructor(readonly code: PayoutConflict) {
    super(CONFLICT_MESSAGES[code]);
  }
}

export type PayoutMetadata = Readonly<Record<string, string>>;

export interface Payout {
  readonly id: string;
  readonly projectId: string;
  readonly mandateId: string;
  readonly recipientId: string;
  readonly taskId: string;
  readonly idempotencyKey: string;
  // The chain adapter's network id, such as stellar:testnet.
  readonly network: string;
  readonly amount: TokenAmount;
  readonly fee: TokenAmount;
  readonly status: PayoutStatus;
  // The spec error name, set exactly when the status is blocked.
  readonly blockedBy: string | null;
  // 64 lowercase hex digits.
  readonly onchainPayoutId: string;
  readonly requestTxHash: string | null;
  readonly metadata: PayoutMetadata;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  // When it was paid.
  readonly settledAt: Date | null;
}

export interface PayoutLeg {
  readonly id: string;
  readonly payoutId: string;
  readonly index: number;
  readonly payoutMethodId: string;
  readonly method: PayoutMethodKind;
  readonly destination: string;
  readonly amount: TokenAmount;
  readonly fee: TokenAmount;
  // What the rail sends this leg under, as 64 lowercase hex digits.
  readonly legKey: string;
  readonly txHash: string | null;
  readonly status: LegStatus;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface NewPayoutLeg {
  // One of the recipient's payout methods. Its method and destination are
  // copied onto the leg as recorded.
  readonly payoutMethodId: string;
  readonly amount: TokenAmount;
  readonly fee?: TokenAmount;
}

export interface NewPayout {
  readonly idempotencyKey: string;
  // SHA-256 of the request, as 64 lowercase hex digits.
  readonly requestHash: string;
  readonly mandateId: string;
  readonly recipientId: string;
  readonly taskId: string;
  // As the engine derives it from the mandate and the task.
  readonly onchainPayoutId: string;
  // In the mandate's own token; the network is the mandate's.
  readonly amount: TokenAmount;
  readonly fee?: TokenAmount;
  readonly metadata?: PayoutMetadata;
  // In leg order. Leg 0 carries any rounding remainder.
  readonly legs: readonly NewPayoutLeg[];
  // Set when the quote already refused it: the payout is written blocked,
  // with this spec error, so the caller still has a record and a receipt.
  readonly blockedBy?: string;
}

export interface CreatedPayout {
  // False when this was a retry and the payout already existed.
  readonly created: boolean;
  readonly payout: Payout;
  readonly legs: readonly PayoutLeg[];
}

export interface PayoutTransition {
  readonly from: PayoutStatus;
  readonly to: PayoutStatus;
  // Required when moving to blocked, refused otherwise.
  readonly blockedBy?: string;
  // Recorded once; a different hash later is refused.
  readonly requestTxHash?: string;
}

export interface LegTransition {
  readonly from: LegStatus;
  readonly to: LegStatus;
  readonly txHash?: string;
}

export interface PayoutFilter {
  readonly status?: PayoutStatus;
  readonly mandateId?: string;
  readonly recipientId?: string;
  // Inclusive.
  readonly createdFrom?: Date;
  // Exclusive.
  readonly createdTo?: Date;
}

// Exported with the row mappers below for the read views, which page
// payouts and attach what a person needs beside them.
export const payoutColumns = [
  'principal_id',
  'id',
  'project_id',
  'mandate_id',
  'recipient_id',
  'task_id',
  'idempotency_key',
  'request_hash',
  'network',
  'chain',
  'amount',
  'fee_amount',
  'asset',
  'scale',
  'status',
  'blocked_by',
  'onchain_payout_id',
  'request_tx_hash',
  'metadata',
  'created_at',
  'updated_at',
  'settled_at',
] as const;

export interface PayoutRow {
  principal_id: string;
  id: string;
  project_id: string;
  mandate_id: string;
  recipient_id: string;
  task_id: string;
  idempotency_key: string;
  request_hash: Buffer;
  network: string;
  chain: string;
  amount: string;
  fee_amount: string;
  asset: string;
  scale: number;
  status: string;
  blocked_by: string | null;
  onchain_payout_id: Buffer;
  request_tx_hash: Buffer | null;
  metadata: unknown;
  created_at: Date;
  updated_at: Date;
  settled_at: Date | null;
}

// The column checks make these unreachable unless the lists drift apart.
function payoutStatusOf(value: string): PayoutStatus {
  if (!isPayoutStatus(value))
    throw new Error('a payout row holds a status this code does not know');
  return value;
}

function legStatusOf(value: string): LegStatus {
  if (!isLegStatus(value)) throw new Error('a payout leg holds a status this code does not know');
  return value;
}

function methodOf(value: string): PayoutMethodKind {
  if (value !== 'stellar_wallet') {
    throw new Error('a payout leg holds a method this code does not know');
  }
  return value;
}

function metadataOf(value: unknown): PayoutMetadata {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('a payout row holds metadata that is not an object');
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.some(([, entry]) => typeof entry !== 'string')) {
    throw new Error('a payout row holds metadata that is not text');
  }
  // fromEntries defines each key as its own property, so a key such as
  // __proto__ stays a key and never becomes a prototype.
  return Object.freeze(Object.fromEntries(entries) as Record<string, string>);
}

export function toPayout(row: PayoutRow): Payout {
  const unit = { asset: row.asset, chain: row.chain, scale: row.scale };
  return {
    id: row.id,
    projectId: row.project_id,
    mandateId: row.mandate_id,
    recipientId: row.recipient_id,
    taskId: row.task_id,
    idempotencyKey: row.idempotency_key,
    network: row.network,
    amount: tokenFromRow({ ...unit, amount: row.amount }),
    fee: tokenFromRow({ ...unit, amount: row.fee_amount }),
    status: payoutStatusOf(row.status),
    blockedBy: row.blocked_by,
    onchainPayoutId: bytesHex32(row.onchain_payout_id),
    requestTxHash: row.request_tx_hash === null ? null : bytesHex32(row.request_tx_hash),
    metadata: metadataOf(row.metadata),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    settledAt: row.settled_at,
  };
}

export const legColumns = [
  'id',
  'payout_id',
  'leg_index',
  'payout_method_id',
  'method',
  'destination_address',
  'chain',
  'asset',
  'scale',
  'amount',
  'fee_amount',
  'leg_key',
  'chain_tx_hash',
  'status',
  'created_at',
  'updated_at',
] as const;

export function toLeg(row: {
  id: string;
  payout_id: string;
  leg_index: number;
  payout_method_id: string;
  method: string;
  destination_address: string;
  chain: string;
  asset: string;
  scale: number;
  amount: string;
  fee_amount: string;
  leg_key: Buffer;
  chain_tx_hash: Buffer | null;
  status: string;
  created_at: Date;
  updated_at: Date;
}): PayoutLeg {
  const unit = { asset: row.asset, chain: row.chain, scale: row.scale };
  return {
    id: row.id,
    payoutId: row.payout_id,
    index: row.leg_index,
    payoutMethodId: row.payout_method_id,
    method: methodOf(row.method),
    destination: row.destination_address,
    amount: tokenFromRow({ ...unit, amount: row.amount }),
    fee: tokenFromRow({ ...unit, amount: row.fee_amount }),
    legKey: bytesHex32(row.leg_key),
    txHash: row.chain_tx_hash === null ? null : bytesHex32(row.chain_tx_hash),
    status: legStatusOf(row.status),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function checked(pattern: RegExp, value: string, field: string): string {
  if (!pattern.test(value)) throw new RepositoryInputError(field);
  return value;
}

function checkedMetadata(metadata: PayoutMetadata): string {
  const value: unknown = metadata;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new RepositoryInputError('metadata');
  }
  const entries: [string, unknown][] = Object.entries(value);
  const fits = (text: unknown): boolean =>
    typeof text === 'string' && text.length <= MAX_METADATA_LENGTH;
  if (
    entries.length > MAX_METADATA_KEYS ||
    entries.some(([key, value]) => key.length === 0 || !fits(key) || !fits(value))
  ) {
    throw new RepositoryInputError('metadata');
  }
  return JSON.stringify(Object.fromEntries(entries));
}

const zeroOf = (unit: TokenAmount): TokenAmount => tokenAmount(0n, unit.asset, unit.chain);

// Legs that cannot add up are refused before any row, with the money module's
// own error when units differ. The database checks the same sums at commit.
function checkedLegs(input: NewPayout, fee: TokenAmount): readonly Required<NewPayoutLeg>[] {
  if (input.legs.length < 1 || input.legs.length > MAX_LEGS) {
    throw new InvalidLegsError(`a payout has 1 to ${String(MAX_LEGS)} legs`);
  }
  const legs = input.legs.map((leg) => ({ ...leg, fee: leg.fee ?? zeroOf(input.amount) }));
  if (legs.some((leg) => leg.amount.amount <= 0n)) {
    throw new InvalidLegsError('every leg must be above zero');
  }
  if (!equals(sum(legs.map((leg) => leg.amount)), input.amount)) {
    throw new InvalidLegsError('the legs must add up to the payout amount');
  }
  if (!equals(sum(legs.map((leg) => leg.fee)), fee)) {
    throw new InvalidLegsError('the leg fees must add up to the payout fee');
  }
  return legs;
}

async function legsOf(db: Tx, payoutId: string): Promise<readonly PayoutLeg[]> {
  const rows = await db
    .selectFrom('ujira.payout_legs')
    .select(legColumns)
    .where('payout_id', '=', payoutId)
    .orderBy('leg_index')
    .execute();
  return rows.map(toLeg);
}

async function existingPayout(db: Tx, input: NewPayout, hash: Buffer): Promise<CreatedPayout> {
  const byKey = await db
    .selectFrom('ujira.payouts')
    .select(payoutColumns)
    .where('idempotency_key', '=', input.idempotencyKey)
    .executeTakeFirst();
  if (byKey !== undefined) {
    if (!byKey.request_hash.equals(hash)) throw new PayoutConflictError('IDEMPOTENCY_KEY_REUSED');
    return { created: false, payout: toPayout(byKey), legs: await legsOf(db, byKey.id) };
  }
  const byTask = await db
    .selectFrom('ujira.payouts')
    .select('id')
    .where('mandate_id', '=', input.mandateId)
    .where('task_id', '=', input.taskId)
    .executeTakeFirst();
  throw new PayoutConflictError(
    byTask === undefined ? 'ONCHAIN_PAYOUT_ID_REUSED' : 'TASK_ID_REUSED',
  );
}

export const payouts = {
  // A mandate outside the transaction's project reads as no network, 23502;
  // an amount in another unit than the mandate's fails its key, 23503, as do a
  // recipient not on the mandate and a payout method that is not the
  // recipient's. Nothing is written in any of those cases.
  create: async (db: Tx, input: NewPayout, jobs: PayoutJobQueue): Promise<CreatedPayout> => {
    const key = checked(IDEMPOTENCY_KEY, input.idempotencyKey, 'idempotencyKey');
    const taskId = checked(TASK_ID, input.taskId, 'taskId');
    const hash = hex32Bytes(input.requestHash, 'requestHash');
    const onchainId = hex32Bytes(input.onchainPayoutId, 'onchainPayoutId');
    const blockedBy =
      input.blockedBy === undefined ? undefined : checked(SPEC_ERROR, input.blockedBy, 'blockedBy');
    const metadata = checkedMetadata(input.metadata ?? {});
    const fee = input.fee ?? zeroOf(input.amount);
    const legs = checkedLegs(input, fee);

    const row = await db
      .insertInto('ujira.payouts')
      .values({
        principal_id: CURRENT_PRINCIPAL,
        project_id: CURRENT_PROJECT,
        idempotency_key: key,
        request_hash: hash,
        mandate_id: input.mandateId,
        recipient_id: input.recipientId,
        task_id: taskId,
        onchain_payout_id: onchainId,
        // Read under the same policies, so another project's mandate reads as
        // nothing and the not null check refuses the row.
        network: sql<string>`(select m.network from ujira.mandates as m where m.id = ${input.mandateId}::uuid)`,
        chain: input.amount.chain,
        amount: amountParam(input.amount),
        fee_amount: amountParam(fee),
        asset: input.amount.asset,
        scale: input.amount.scale,
        metadata,
      })
      // Any of the unique keys: a retry, or a conflict to report.
      .onConflict((conflict) => conflict.doNothing())
      .returning(payoutColumns)
      .executeTakeFirst();
    if (row === undefined) return existingPayout(db, input, hash);

    const legRows = await db
      .insertInto('ujira.payout_legs')
      .values(
        legs.map((leg, index) => ({
          principal_id: CURRENT_PRINCIPAL,
          project_id: CURRENT_PROJECT,
          payout_id: row.id,
          recipient_id: row.recipient_id,
          leg_index: index,
          payout_method_id: leg.payoutMethodId,
          method: sql<string>`(select pm.method from ujira.payout_methods as pm where pm.id = ${leg.payoutMethodId}::uuid)`,
          destination_address: sql<string>`(select pm.destination_address from ujira.payout_methods as pm where pm.id = ${leg.payoutMethodId}::uuid)`,
          network: row.network,
          chain: row.chain,
          asset: row.asset,
          scale: row.scale,
          amount: amountParam(leg.amount),
          fee_amount: amountParam(leg.fee),
        })),
      )
      .returning(legColumns)
      .execute();

    let payout = row;
    let written = legRows;
    if (blockedBy !== undefined) {
      payout = await db
        .updateTable('ujira.payouts')
        .set({ status: 'blocked', blocked_by: blockedBy })
        .where('id', '=', row.id)
        .returning(payoutColumns)
        .executeTakeFirstOrThrow();
      written = await db
        .updateTable('ujira.payout_legs')
        .set({ status: 'cancelled' })
        .where('payout_id', '=', row.id)
        .returning(legColumns)
        .execute();
    }

    await jobs.enqueue(
      db,
      payoutJob(blockedBy === undefined ? 'payout.advance' : 'receipt.issue', {
        principalId: payout.principal_id,
        projectId: payout.project_id,
        payoutId: payout.id,
      }),
    );
    return {
      created: true,
      payout: toPayout(payout),
      legs: [...written].sort((a, b) => a.leg_index - b.leg_index).map(toLeg),
    };
  },

  get: async (db: Tx, id: string): Promise<Payout | undefined> => {
    const row = await db
      .selectFrom('ujira.payouts')
      .select(payoutColumns)
      .where('id', '=', id)
      .executeTakeFirst();
    return row === undefined ? undefined : toPayout(row);
  },

  // How an agent asks after its own task.
  findByTask: async (db: Tx, mandateId: string, taskId: string): Promise<Payout | undefined> => {
    const row = await db
      .selectFrom('ujira.payouts')
      .select(payoutColumns)
      .where('mandate_id', '=', mandateId)
      .where('task_id', '=', taskId)
      .executeTakeFirst();
    return row === undefined ? undefined : toPayout(row);
  },

  // Newest first.
  list: async (db: Tx, filter: PayoutFilter, page: PageRequest): Promise<Page<Payout>> => {
    const limit = checkedLimit(page.limit);
    let query = db
      .selectFrom('ujira.payouts')
      .select([...payoutColumns, PAGE_TIME.as('page_time')])
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(limit + 1);
    if (filter.status !== undefined) query = query.where('status', '=', filter.status);
    if (filter.mandateId !== undefined) query = query.where('mandate_id', '=', filter.mandateId);
    if (filter.recipientId !== undefined) {
      query = query.where('recipient_id', '=', filter.recipientId);
    }
    if (filter.createdFrom !== undefined) {
      query = query.where('created_at', '>=', filter.createdFrom);
    }
    if (filter.createdTo !== undefined) query = query.where('created_at', '<', filter.createdTo);
    if (page.after !== undefined) query = query.where(olderThan(page.after));
    const rows = await query.execute();
    const keys = new Map(rows.map((row) => [row.id, pageKey(row)]));
    return pageOf(rows.map(toPayout), limit, (payout) => keys.get(payout.id) ?? '');
  },

  // The payout as it now is, or undefined when it is not found or is no longer
  // in `from`. A move the status machine does not allow throws before any SQL.
  transition: async (db: Tx, id: string, change: PayoutTransition): Promise<Payout | undefined> => {
    assertTransition(change.from, change.to);
    if ((change.to === 'blocked') !== (change.blockedBy !== undefined)) {
      throw new RepositoryInputError('blockedBy');
    }
    const blockedBy =
      change.blockedBy === undefined ? null : checked(SPEC_ERROR, change.blockedBy, 'blockedBy');
    const requestTxHash =
      change.requestTxHash === undefined
        ? undefined
        : hex32Bytes(change.requestTxHash, 'requestTxHash');
    const row = await db
      .updateTable('ujira.payouts')
      .set({
        status: change.to,
        blocked_by: blockedBy,
        ...(requestTxHash === undefined ? {} : { request_tx_hash: requestTxHash }),
      })
      .where('id', '=', id)
      .where('status', '=', change.from)
      .returning(payoutColumns)
      .executeTakeFirst();
    return row === undefined ? undefined : toPayout(row);
  },
};

export const payoutLegs = {
  // In leg order.
  list: legsOf,

  // As payouts.transition, for one leg. Moving to submitted or settled needs
  // the transaction hash, now or from before.
  transition: async (db: Tx, id: string, change: LegTransition): Promise<PayoutLeg | undefined> => {
    assertLegTransition(change.from, change.to);
    const txHash = change.txHash === undefined ? undefined : hex32Bytes(change.txHash, 'txHash');
    const row = await db
      .updateTable('ujira.payout_legs')
      .set({ status: change.to, ...(txHash === undefined ? {} : { chain_tx_hash: txHash }) })
      .where('id', '=', id)
      .where('status', '=', change.from)
      .returning(legColumns)
      .executeTakeFirst();
    return row === undefined ? undefined : toLeg(row);
  },
};

// For the cross-tenant matrix, which requires a case for each method here.
export const payoutRepositories = { payouts, payoutLegs } as const;
