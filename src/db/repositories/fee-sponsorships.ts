// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The fee sponsor's daily cap per principal. Each method runs inside a
// transaction that db.tenant() opened and takes no tenant id: the principal and
// the project come from the context, so a project can only ever charge its own
// principal's cap and move its own reservations.
//
// Every method locks the principal's day row before it touches a sponsorship,
// in that order, so two requests of one principal queue rather than deadlock,
// and no two of them can both pass the cap on totals read before the other
// wrote.

import { sql, type Kysely } from 'kysely';

import type { Schema } from '../schema.js';
import { RepositoryInputError, hex32Bytes } from './values.js';

type Tx = Kysely<Schema>;

const CURRENT_PRINCIPAL = sql<string>`ujira.current_principal_id()`;

const DAY = /^\d{4}-\d{2}-\d{2}$/;
// The network keeps fees as a signed 64 bit integer, and so do the columns.
const INT64_MAX = (1n << 63n) - 1n;

export interface NewSponsoredFee {
  // The principal signed transaction inside the fee bump, as 64 hex digits.
  readonly innerTxHash: string;
  // The UTC day it counts against, as YYYY-MM-DD.
  readonly day: string;
  // The most the sponsor can be charged for it, in stroops.
  readonly maxFee: bigint;
  // What the principal may use in one day, in stroops.
  readonly dailyCap: bigint;
}

export type SponsoredFeeReservation =
  // Counted against the day: the transaction may be sent.
  | { readonly kind: 'reserved'; readonly used: bigint }
  // Already counted by an earlier attempt with the same envelope, which may be
  // sent again at no extra cost to the cap.
  | { readonly kind: 'replay'; readonly used: bigint }
  // It would take the day past the cap. Nothing was written.
  | { readonly kind: 'capped'; readonly used: bigint };

export interface SettledFee {
  readonly innerTxHash: string;
  // What the network took, in stroops. Above the reservation it is held to it,
  // since the bump's own maximum is what the network can charge at most.
  readonly charged: bigint;
}

function day(value: string): string {
  if (!DAY.test(value)) throw new RepositoryInputError('day');
  return value;
}

function stroops(value: bigint, field: string, min: bigint): bigint {
  if (value < min || value > INT64_MAX) throw new RepositoryInputError(field);
  return value;
}

// Locks the day row and returns its total. A day that has no row yet gets one,
// which the lock then covers like any other.
async function lockDay(db: Tx, on: string): Promise<bigint> {
  await sql`
    insert into ujira.fee_sponsor_days (principal_id, day)
      values (${CURRENT_PRINCIPAL}, ${on}::date)
      on conflict (principal_id, day) do nothing
  `.execute(db);
  const head = await sql<{ used: string }>`
    select used_stroops::text as used
      from ujira.fee_sponsor_days
     where principal_id = ${CURRENT_PRINCIPAL} and day = ${on}::date
       for update
  `.execute(db);
  const used = head.rows[0]?.used;
  // The insert above made the row if it was missing, so only a broken policy
  // could hide it.
  if (used === undefined) throw new Error('the fee sponsor day row is out of reach');
  return BigInt(used);
}

async function addToDay(db: Tx, on: string, delta: bigint): Promise<void> {
  await sql`
    update ujira.fee_sponsor_days
       set used_stroops = used_stroops + ${delta.toString()}::bigint
     where principal_id = ${CURRENT_PRINCIPAL} and day = ${on}::date
  `.execute(db);
}

interface Held {
  readonly status: string;
  readonly day: string;
  readonly maxFee: bigint;
}

async function held(db: Tx, hash: Buffer): Promise<Held | undefined> {
  const found = await sql<{ status: string; day: string; max_fee: string }>`
    select status, day::text as day, max_fee_stroops::text as max_fee
      from ujira.fee_sponsorships
     where inner_tx_hash = ${hash}
  `.execute(db);
  const row = found.rows[0];
  return row === undefined
    ? undefined
    : { status: row.status, day: row.day, maxFee: BigInt(row.max_fee) };
}

// Moves an open reservation to settled or released, and gives back to its day
// whatever it held beyond the charge. False when there is no open reservation
// for the hash in this project.
async function close(
  db: Tx,
  hash: Buffer,
  to: 'settled' | 'released',
  charged: bigint,
): Promise<boolean> {
  const open = await held(db, hash);
  if (open?.status !== 'reserved') return false;
  await lockDay(db, open.day);
  const kept = charged < open.maxFee ? charged : open.maxFee;
  const moved = await sql<{ id: string }>`
    update ujira.fee_sponsorships
       set status = ${to}, charged_stroops = ${kept.toString()}::bigint
     where inner_tx_hash = ${hash} and status = 'reserved'
    returning id
  `.execute(db);
  // Another attempt closed it between the read and the lock.
  if (moved.rows.length === 0) return false;
  await addToDay(db, open.day, kept - open.maxFee);
  return true;
}

export const feeSponsorships = {
  // Counts a sponsored transaction against its principal's day, or says why
  // not. The same envelope twice counts once.
  reserve: async (db: Tx, input: NewSponsoredFee): Promise<SponsoredFeeReservation> => {
    const hash = hex32Bytes(input.innerTxHash, 'innerTxHash');
    const on = day(input.day);
    const maxFee = stroops(input.maxFee, 'maxFee', 1n);
    const cap = stroops(input.dailyCap, 'dailyCap', 0n);
    const used = await lockDay(db, on);
    const existing = await held(db, hash);
    if (existing !== undefined && existing.status !== 'released') {
      return { kind: 'replay', used };
    }
    if (used + maxFee > cap) return { kind: 'capped', used };
    if (existing === undefined) {
      await sql`
        insert into ujira.fee_sponsorships (
          principal_id, project_id, inner_tx_hash, day, max_fee_stroops
        ) values (
          ${CURRENT_PRINCIPAL}, ujira.current_project_id(), ${hash}, ${on}::date,
          ${maxFee.toString()}::bigint
        )
      `.execute(db);
    } else {
      await sql`
        update ujira.fee_sponsorships
           set status = 'reserved', day = ${on}::date,
               max_fee_stroops = ${maxFee.toString()}::bigint, charged_stroops = null
         where inner_tx_hash = ${hash} and status = 'released'
      `.execute(db);
    }
    await addToDay(db, on, maxFee);
    return { kind: 'reserved', used: used + maxFee };
  },

  // Records what the network charged for a reserved transaction it took.
  settle: async (db: Tx, input: SettledFee): Promise<boolean> => {
    const hash = hex32Bytes(input.innerTxHash, 'innerTxHash');
    return close(db, hash, 'settled', stroops(input.charged, 'charged', 0n));
  },

  // Frees a reservation whose transaction the network never took, so it cost
  // nothing and the day gets its room back.
  release: async (db: Tx, input: { readonly innerTxHash: string }): Promise<boolean> => {
    return close(db, hex32Bytes(input.innerTxHash, 'innerTxHash'), 'released', 0n);
  },
};

// For the cross-tenant matrix, which requires a case for each method listed here.
export const feeSponsorshipRepositories = { feeSponsorships } as const;
