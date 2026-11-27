// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The figures an overview shows, counted by the database from the payouts
// themselves, so they always agree with the payout list.
//
// A period selects the payouts created in it, the same rule the list's
// createdFrom and createdTo use, so a count here is the length of that list
// with the same filters. One grouped scan gives the counts by status, the
// blocks by rule and the totals paid, so the three come from one snapshot and
// add up together. Approvals waiting are counted apart, as of now: a payout
// asked for last month and still waiting is still waiting.
//
// Totals stay exact. Postgres sums the numeric column and hands the result
// over as text, which the money mapper reads into a bigint.

import { sql, type Kysely } from 'kysely';

import { add, tokenAmount, type TokenAmount } from '../../money/index.js';
import { isPayoutStatus, type PayoutStatus } from '../../payouts/status.js';
import { tokenFromRow } from '../money-mapper.js';
import type { Schema } from '../schema.js';

type Tx = Kysely<Schema>;

export interface StatsPeriod {
  /** Inclusive. */
  readonly from: Date;
  /** Exclusive. */
  readonly to: Date;
}

/** A total in one token, on the network it was paid on. */
export interface NetworkAmount {
  /** The chain adapter's network id, such as stellar:testnet. */
  readonly network: string;
  readonly amount: TokenAmount;
}

export interface PayoutPeriodStats {
  /** Payouts created in the period, by their status now. A status with none is left out. */
  readonly byStatus: Readonly<Partial<Record<PayoutStatus, number>>>;
  /** Blocked payouts created in the period, by the spec error that blocked them. */
  readonly blockedByRule: Readonly<Record<string, number>>;
  /**
   * What the payouts created in the period and now paid add up to, one total
   * per token: every token the project's mandates pay in, at zero when none
   * was paid, and any other token a payout was paid in.
   */
  readonly paid: readonly NetworkAmount[];
  /** Payouts waiting for an approver now, whenever they were created. */
  readonly approvalsWaiting: number;
}

// Counts arrive as int8 text. A project would need more payouts than a double
// holds exactly before this could trip.
function countOf(value: string): number {
  const count = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error('a payout count is not a whole number this code can hold');
  }
  return count;
}

function statusOf(value: string): PayoutStatus {
  if (!isPayoutStatus(value)) {
    throw new Error('a payout row holds a status this code does not know');
  }
  return value;
}

const unitKey = (u: { network: string; asset: string; scale: number }): string =>
  `${u.network}|${u.asset}|${String(u.scale)}`;

const byUnit = (a: NetworkAmount, b: NetworkAmount): number =>
  a.network.localeCompare(b.network, 'en') ||
  a.amount.asset.localeCompare(b.amount.asset, 'en') ||
  a.amount.scale - b.amount.scale;

export const payoutStats = {
  // Every query runs under the transaction's tenant policies, so a project
  // scoped transaction counts its own project and nothing else.
  period: async (db: Tx, period: StatsPeriod): Promise<PayoutPeriodStats> => {
    if (!(period.from.getTime() < period.to.getTime())) {
      throw new RangeError('a stats period must start before it ends');
    }
    const groups = await db
      .selectFrom('ujira.payouts')
      .select(['status', 'blocked_by', 'network', 'chain', 'asset', 'scale'])
      .select([
        sql<string>`count(*)::text`.as('payouts'),
        sql<string>`sum(amount)::text`.as('total'),
      ])
      .where('created_at', '>=', period.from)
      .where('created_at', '<', period.to)
      .groupBy(['status', 'blocked_by', 'network', 'chain', 'asset', 'scale'])
      .execute();

    const units = await db
      .selectFrom('ujira.mandates')
      .select(['network', 'chain', 'asset', 'scale'])
      .distinct()
      .execute();

    const waiting = await db
      .selectFrom('ujira.payouts')
      .select(sql<string>`count(*)::text`.as('payouts'))
      .where('status', '=', 'pending_approval')
      .executeTakeFirstOrThrow();

    const byStatus = new Map<PayoutStatus, number>();
    const blockedByRule = new Map<string, number>();
    const paid = new Map<string, NetworkAmount>();
    for (const unit of units) {
      const zero = tokenFromRow({ ...unit, amount: '0' });
      paid.set(unitKey(unit), { network: unit.network, amount: zero });
    }
    for (const group of groups) {
      const status = statusOf(group.status);
      const count = countOf(group.payouts);
      byStatus.set(status, (byStatus.get(status) ?? 0) + count);
      if (status === 'blocked' && group.blocked_by !== null) {
        blockedByRule.set(group.blocked_by, (blockedByRule.get(group.blocked_by) ?? 0) + count);
      }
      if (status === 'paid') {
        const total = tokenFromRow({ ...group, amount: group.total });
        const key = unitKey(group);
        const before = paid.get(key)?.amount ?? tokenAmount(0n, total.asset, total.chain);
        paid.set(key, { network: group.network, amount: add(before, total) });
      }
    }

    return {
      // fromEntries makes each key an own property, so no key can reach a
      // prototype; the database's format for statuses and rules allows none
      // that could anyway.
      byStatus: Object.freeze(Object.fromEntries(byStatus)),
      blockedByRule: Object.freeze(Object.fromEntries(blockedByRule)),
      paid: Object.freeze([...paid.values()].sort(byUnit)),
      approvalsWaiting: countOf(waiting.payouts),
    };
  },
};

// For a cross-tenant matrix, which requires a case for each method here.
export const payoutStatsRepositories = { payoutStats } as const;
