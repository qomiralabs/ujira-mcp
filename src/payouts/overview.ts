// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// A project's overview: what it paid in a period, its payouts by status, why
// payouts were blocked, how many wait for an approver, and what each mandate
// holds.
//
// The payout figures come from the database in one project scoped
// transaction, so another project of the same principal never adds to them.
// Balances live on chain only, so each mandate is read through the adapter,
// all under one deadline: a slow network delays the overview by at most that
// long, and a mandate the chain did not answer for shows no balance rather
// than holding the page back or failing it.

import {
  callOptions,
  ChainError,
  type ChainAdapter,
  type MandateStateView,
} from '../chain/adapter.js';
import type { Mandate, NetworkAmount, PayoutPeriodStats, ProjectContext } from '../db/index.js';
import {
  isKnownTimeZone,
  resolvePeriod,
  type Period,
  type PeriodRequest,
} from './overview-period.js';

export { PeriodError, type Period, type PeriodRequest } from './overview-period.js';

/** How many mandates an overview reads balances for; the mandate list has the rest. */
export const OVERVIEW_MANDATE_LIMIT = 50;

/** All balance reads of one overview share this budget. */
export const OVERVIEW_CHAIN_BUDGET_MS = 5_000;

const CHAIN_READS_AT_ONCE = 8;

/** What the store reads for one project, in one transaction. */
export interface OverviewFacts {
  readonly period: Period;
  readonly stats: PayoutPeriodStats;
  /** The first mandates of the project, at most the limit asked for. */
  readonly mandates: readonly Mandate[];
  /** True when the project has more mandates than were read. */
  readonly moreMandates: boolean;
}

export interface OverviewStore {
  /**
   * Reads the project's reporting time zone, has `periodFor` turn it into the
   * period, and counts that period, all in one project scoped transaction.
   */
  read(
    context: ProjectContext,
    periodFor: (timeZone: string) => Period,
    mandateLimit: number,
  ): Promise<OverviewFacts>;
}

export interface MandateBalance {
  readonly mandate: Mandate;
  /** Null when the chain did not answer in time, or the mandate is on a network this server does not read. */
  readonly state: Pick<MandateStateView, 'balance' | 'committed' | 'free'> | null;
}

export interface Overview {
  readonly period: Period;
  readonly paid: readonly NetworkAmount[];
  readonly byStatus: PayoutPeriodStats['byStatus'];
  readonly blockedByRule: PayoutPeriodStats['blockedByRule'];
  readonly approvalsWaiting: number;
  readonly mandates: readonly MandateBalance[];
  readonly moreMandates: boolean;
}

export interface OverviewService {
  overview(
    context: ProjectContext,
    request: PeriodRequest,
    correlationId: string,
  ): Promise<Overview>;
}

export interface OverviewServiceOptions {
  readonly store: OverviewStore;
  readonly chain: Pick<ChainAdapter, 'network' | 'readMandate'>;
  readonly log: (line: string) => void;
  readonly now?: () => Date;
  readonly chainBudgetMs?: number;
}

// Runs the work over the items, a few at a time, in their order.
async function inTurn<T, R>(
  items: readonly T[],
  atOnce: number,
  work: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  const lane = async (): Promise<void> => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await work(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(atOnce, items.length) }, lane));
  return results;
}

export function createOverviewService(o: OverviewServiceOptions): OverviewService {
  const now = o.now ?? (() => new Date());
  const budgetMs = o.chainBudgetMs ?? OVERVIEW_CHAIN_BUDGET_MS;

  // A zone the database accepted but this runtime cannot place times in
  // would otherwise fail every overview; UTC is reported in its place, and
  // the answer says which zone it used.
  function zoneFor(timeZone: string, correlationId: string): string {
    if (isKnownTimeZone(timeZone)) return timeZone;
    o.log(`event=overview_time_zone_unknown correlationId=${correlationId} fallback=UTC`);
    return 'UTC';
  }

  async function balances(
    mandates: readonly Mandate[],
    correlationId: string,
  ): Promise<MandateBalance[]> {
    // One deadline for every read, so the overview waits at most this long.
    const options = callOptions(correlationId, budgetMs);
    return inTurn(mandates, CHAIN_READS_AT_ONCE, async (mandate) => {
      if (mandate.network !== o.chain.network) return { mandate, state: null };
      try {
        const { state } = await o.chain.readMandate(mandate.contractAddress, options);
        return {
          mandate,
          state: { balance: state.balance, committed: state.committed, free: state.free },
        };
      } catch (error) {
        if (!(error instanceof ChainError)) throw error;
        o.log(
          `event=overview_mandate_unread correlationId=${correlationId} mandateId=${mandate.id} code=${error.code}`,
        );
        return { mandate, state: null };
      }
    });
  }

  return {
    async overview(context, request, correlationId) {
      const at = now();
      const facts = await o.store.read(
        context,
        (timeZone) => resolvePeriod(request, zoneFor(timeZone, correlationId), at),
        OVERVIEW_MANDATE_LIMIT,
      );
      return {
        period: facts.period,
        paid: facts.stats.paid,
        byStatus: facts.stats.byStatus,
        blockedByRule: facts.stats.blockedByRule,
        approvalsWaiting: facts.stats.approvalsWaiting,
        mandates: await balances(facts.mandates, correlationId),
        moreMandates: facts.moreMandates,
      };
    },
  };
}
