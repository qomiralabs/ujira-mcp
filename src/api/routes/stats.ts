// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// GET /v1/stats/overview, the dashboard's front page in numbers.
//
// It takes a dashboard session, as the overview is a screen a person reads; a
// platform reads the same facts from the payout list with its key. The tenant
// is the session's project and nothing in the query can name another one.
//
// Amounts leave as strings of integer minor units beside their asset, network
// and scale, the same shape as every other /v1 amount.

import { z } from 'zod';

import {
  PeriodError,
  type MandateBalance,
  type Overview,
  type OverviewService,
} from '../../payouts/overview.js';
import { payoutStatus } from '../../payouts/status.js';
import type { Authenticate, SessionAccess } from '../authenticate.js';
import { ApiError } from '../errors.js';
import { defineRoute, type Route } from '../route.js';

/** Any member of the project may read it, viewers included. */
export const OVERVIEW_ACCESS: SessionAccess = { via: 'session', permission: 'read' };

const instant = z.iso.datetime({ offset: true });

const overviewQuery = z
  .object({
    from: instant.optional(),
    to: instant.optional(),
  })
  .strict();

const count = z.int().nonnegative();

const amountSchema = z
  .object({
    amount: z.string().regex(/^(?:0|[1-9][0-9]{0,38})$/),
    asset: z.string(),
    network: z.string(),
    scale: z.int().nonnegative(),
  })
  .strict();

const mandateSchema = z
  .object({
    id: z.uuid(),
    contractId: z.string(),
    name: z.string(),
    // Null when the chain did not answer in time.
    state: z
      .object({ balance: amountSchema, committed: amountSchema, free: amountSchema })
      .strict()
      .nullable(),
  })
  .strict();

export const overviewSchema = z
  .object({
    period: z
      .object({ from: z.iso.datetime(), to: z.iso.datetime(), timeZone: z.string() })
      .strict(),
    paid: z.array(amountSchema),
    byStatus: z.partialRecord(payoutStatus, count),
    blockedByRule: z.record(z.string(), count),
    approvalsWaiting: count,
    mandates: z.array(mandateSchema),
    moreMandates: z.boolean(),
  })
  .strict();

export interface StatsRouteOptions {
  readonly overview: OverviewService;
  readonly authenticate: Authenticate;
}

interface Unit {
  readonly network: string;
  readonly asset: string;
  readonly scale: number;
}

function amountWire(amount: bigint, unit: Unit): z.input<typeof amountSchema> {
  return {
    amount: amount.toString(),
    asset: unit.asset,
    network: unit.network,
    scale: unit.scale,
  };
}

function mandateWire({ mandate, state }: MandateBalance): z.input<typeof mandateSchema> {
  return {
    id: mandate.id,
    contractId: mandate.contractAddress,
    name: mandate.name,
    state:
      state === null
        ? null
        : {
            balance: amountWire(state.balance, mandate),
            committed: amountWire(state.committed, mandate),
            free: amountWire(state.free, mandate),
          },
  };
}

export function overviewWire(overview: Overview): z.input<typeof overviewSchema> {
  return {
    period: {
      from: overview.period.from.toISOString(),
      to: overview.period.to.toISOString(),
      timeZone: overview.period.timeZone,
    },
    paid: overview.paid.map(({ network, amount }) =>
      amountWire(amount.amount, { network, asset: amount.asset, scale: amount.scale }),
    ),
    byStatus: { ...overview.byStatus },
    blockedByRule: { ...overview.blockedByRule },
    approvalsWaiting: overview.approvalsWaiting,
    mandates: overview.mandates.map(mandateWire),
    moreMandates: overview.moreMandates,
  };
}

export function statsRoutes(o: StatsRouteOptions): Route[] {
  const reader = o.authenticate(OVERVIEW_ACCESS);

  const overview = defineRoute({
    method: 'get',
    path: '/v1/stats/overview',
    operationId: 'getOverview',
    summary: "The project's payouts and mandates at a glance",
    description:
      'Counts the payouts created in the period from `from` (inclusive) to `to` (exclusive): by status, blocked by rule, and what those now paid add up to, per token. ' +
      "Left out, the period is the last 7 days of the principal's reporting time zone, today included; with only `from`, it ends tonight; with only `to`, it starts 7 local days before. " +
      'Approvals waiting counts every payout waiting for an approver now. Mandate balances are read from the chain for the first 50 mandates; a state of null means the chain did not answer in time.',
    tags: ['stats'],
    query: overviewQuery,
    response: overviewSchema,
    // An API key is refused with FORBIDDEN, whatever scopes it holds.
    errors: ['SESSION_INVALID', 'FORBIDDEN', 'NOT_FOUND', 'DB_UNAVAILABLE'],
    handler: async ({ query }, c) => {
      const caller = await reader(c);
      const tenant = { principalId: caller.principalId, projectId: caller.projectId };
      try {
        const answer = await o.overview.overview(
          tenant,
          {
            from: query.from === undefined ? undefined : new Date(query.from),
            to: query.to === undefined ? undefined : new Date(query.to),
          },
          c.get('requestId'),
        );
        return overviewWire(answer);
      } catch (error) {
        if (!(error instanceof PeriodError)) throw error;
        const path = error.problem === 'from_not_before_to' ? 'query.from' : 'query.to';
        throw new ApiError('INVALID_REQUEST', error.message, {
          details: [{ path, issue: error.problem }],
        });
      }
    },
  });

  return [overview];
}
