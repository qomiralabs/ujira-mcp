// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The overview service on a store in memory and a chain that answers as each
// test needs: the period is placed in the principal's zone, the store's
// figures pass through untouched, and the mandate balances are read under one
// deadline, a few at a time, with a mandate the chain did not answer for
// shown as unread rather than failing the overview.

import { describe, expect, it } from 'vitest';

import { ChainError, type CallOptions, type MandateStateView } from '../chain/adapter.js';
import type { Mandate, PayoutPeriodStats, ProjectContext } from '../db/index.js';
import { tokenAmount } from '../money/index.js';
import {
  createOverviewService,
  OVERVIEW_MANDATE_LIMIT,
  PeriodError,
  type OverviewFacts,
  type OverviewStore,
  type Period,
} from './overview.js';

const TENANT: ProjectContext = {
  principalId: '7d0c2f3e-6a51-4c1e-9a7e-0b1f5c0f6a10',
  projectId: '1f4b2b8e-2a8d-4f0f-8c55-6f0e3e2c9b21',
};
const NOW = new Date('2026-11-27T10:00:00.000Z');

const STATS: PayoutPeriodStats = {
  byStatus: { paid: 12, pending_approval: 1, blocked: 2 },
  blockedByRule: { DAILY_CAP_EXCEEDED: 2 },
  paid: [{ network: 'stellar:testnet', amount: tokenAmount(1_225_000_000n, 'USDC', 'stellar') }],
  approvalsWaiting: 1,
};

function mandate(n: number, network = 'stellar:testnet'): Mandate {
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    projectId: TENANT.projectId,
    name: `Mandate ${String(n)}`,
    network,
    contractAddress: `C${String(n).padStart(55, 'A')}`,
    asset: 'USDC',
    scale: 7,
    agentKeyId: null,
    agentAddress: `G${'A'.repeat(55)}`,
    principalWallet: `G${'B'.repeat(55)}`,
    createdTxHash: null,
    createdAt: NOW,
  };
}

function state(balance: bigint): MandateStateView {
  return {
    spent: 0n,
    pending: 0n,
    committed: balance / 4n,
    balance,
    free: balance - balance / 4n,
    paused: false,
    revoked: false,
    expired: false,
  };
}

interface StoreCall {
  readonly context: ProjectContext;
  readonly period: Period;
  readonly limit: number;
}

function memoryStore(o: {
  readonly timeZone?: string;
  readonly mandates?: readonly Mandate[];
  readonly more?: boolean;
}): OverviewStore & { readonly calls: StoreCall[] } {
  const calls: StoreCall[] = [];
  return {
    calls,
    read: (context, periodFor, limit) => {
      try {
        const period = periodFor(o.timeZone ?? 'UTC');
        calls.push({ context, period, limit });
        const facts: OverviewFacts = {
          period,
          stats: STATS,
          mandates: o.mandates ?? [],
          moreMandates: o.more ?? false,
        };
        return Promise.resolve(facts);
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error('store failed'));
      }
    },
  };
}

type Reader = (contract: string, o: CallOptions) => Promise<{ state: MandateStateView }>;

function chainOf(read: Reader) {
  const seen: { contract: string; options: CallOptions }[] = [];
  return {
    seen,
    chain: {
      network: 'stellar:testnet' as const,
      readMandate: async (contract: string, options: CallOptions) => {
        seen.push({ contract, options });
        const { state: s } = await read(contract, options);
        // The service only uses the state; the config is never read.
        return { config: undefined as never, state: s };
      },
    },
  };
}

describe('the overview service', () => {
  it("counts the period in the principal's zone and passes the figures through", async () => {
    const store = memoryStore({ timeZone: 'Africa/Lagos' });
    const { chain } = chainOf(() => Promise.reject(new Error('not called')));
    const service = createOverviewService({ store, chain, log: () => undefined, now: () => NOW });
    const overview = await service.overview(TENANT, {}, 'req-1');
    expect(store.calls).toEqual([
      {
        context: TENANT,
        period: {
          from: new Date('2026-11-20T23:00:00.000Z'),
          to: new Date('2026-11-27T23:00:00.000Z'),
          timeZone: 'Africa/Lagos',
        },
        limit: OVERVIEW_MANDATE_LIMIT,
      },
    ]);
    expect(overview).toEqual({
      period: store.calls[0]?.period,
      paid: STATS.paid,
      byStatus: STATS.byStatus,
      blockedByRule: STATS.blockedByRule,
      approvalsWaiting: 1,
      mandates: [],
      moreMandates: false,
    });
  });

  it('keeps a period the caller names', async () => {
    const store = memoryStore({ timeZone: 'Africa/Lagos' });
    const { chain } = chainOf(() => Promise.reject(new Error('not called')));
    const service = createOverviewService({ store, chain, log: () => undefined, now: () => NOW });
    const from = new Date('2026-11-01T00:00:00.000Z');
    const to = new Date('2026-11-26T00:00:00.000Z');
    const overview = await service.overview(TENANT, { from, to }, 'req-2');
    expect(overview.period).toEqual({ from, to, timeZone: 'Africa/Lagos' });
  });

  it('refuses a period that ends before it starts, with no figures counted', async () => {
    const store = memoryStore({});
    const { chain } = chainOf(() => Promise.reject(new Error('not called')));
    const service = createOverviewService({ store, chain, log: () => undefined, now: () => NOW });
    const at = new Date('2026-11-01T00:00:00.000Z');
    await expect(service.overview(TENANT, { from: at, to: at }, 'req-3')).rejects.toBeInstanceOf(
      PeriodError,
    );
    expect(store.calls).toEqual([]);
  });

  it('falls back to UTC, and says so, for a zone this runtime cannot place', async () => {
    const lines: string[] = [];
    const store = memoryStore({ timeZone: 'Mars/Olympus' });
    const { chain } = chainOf(() => Promise.reject(new Error('not called')));
    const service = createOverviewService({
      store,
      chain,
      log: (line) => lines.push(line),
      now: () => NOW,
    });
    const overview = await service.overview(TENANT, {}, 'req-4');
    expect(overview.period.timeZone).toBe('UTC');
    expect(overview.period.to).toEqual(new Date('2026-11-28T00:00:00.000Z'));
    expect(lines).toEqual(['event=overview_time_zone_unknown correlationId=req-4 fallback=UTC']);
  });

  it('defaults to the clock when no clock is given', async () => {
    const store = memoryStore({});
    const { chain } = chainOf(() => Promise.reject(new Error('not called')));
    const service = createOverviewService({ store, chain, log: () => undefined });
    const before = Date.now();
    const overview = await service.overview(TENANT, {}, 'req-5');
    expect(overview.period.to.getTime()).toBeGreaterThan(before);
  });
});

describe('mandate balances', () => {
  it('reads each mandate on this network, in order, and skips the rest', async () => {
    const mandates = [mandate(1), mandate(2, 'stellar:pubnet'), mandate(3)];
    const store = memoryStore({ mandates, more: true });
    const balances = new Map([
      [mandates[0]?.contractAddress, 400_000_000n],
      [mandates[2]?.contractAddress, 20_000_000n],
    ]);
    const { chain, seen } = chainOf((contract) =>
      Promise.resolve({ state: state(balances.get(contract) ?? 0n) }),
    );
    const service = createOverviewService({ store, chain, log: () => undefined, now: () => NOW });
    const overview = await service.overview(TENANT, {}, 'req-6');
    expect(seen.map((s) => s.contract)).toEqual([
      mandates[0]?.contractAddress,
      mandates[2]?.contractAddress,
    ]);
    expect(seen.every((s) => s.options.correlationId === 'req-6')).toBe(true);
    expect(overview.mandates).toEqual([
      {
        mandate: mandates[0],
        state: { balance: 400_000_000n, committed: 100_000_000n, free: 300_000_000n },
      },
      { mandate: mandates[1], state: null },
      {
        mandate: mandates[2],
        state: { balance: 20_000_000n, committed: 5_000_000n, free: 15_000_000n },
      },
    ]);
    expect(overview.moreMandates).toBe(true);
  });

  it('shows a mandate the chain did not answer for as unread, and logs only its id and the code', async () => {
    const lines: string[] = [];
    const mandates = [mandate(1), mandate(2)];
    const store = memoryStore({ mandates });
    const { chain } = chainOf((contract) =>
      contract === mandates[0]?.contractAddress
        ? Promise.reject(new ChainError('TIMEOUT', 'the chain did not answer'))
        : Promise.resolve({ state: state(8n) }),
    );
    const service = createOverviewService({
      store,
      chain,
      log: (line) => lines.push(line),
      now: () => NOW,
    });
    const overview = await service.overview(TENANT, {}, 'req-7');
    expect(overview.mandates.map((m) => m.state)).toEqual([
      null,
      { balance: 8n, committed: 2n, free: 6n },
    ]);
    expect(lines).toEqual([
      `event=overview_mandate_unread correlationId=req-7 mandateId=${mandates[0]?.id ?? ''} code=TIMEOUT`,
    ]);
    expect(lines.join('\n')).not.toContain(mandates[0]?.contractAddress);
  });

  it('lets an error that is not the chain saying no reach the caller', async () => {
    const store = memoryStore({ mandates: [mandate(1)] });
    const { chain } = chainOf(() => Promise.reject(new TypeError('a bug')));
    const service = createOverviewService({ store, chain, log: () => undefined, now: () => NOW });
    await expect(service.overview(TENANT, {}, 'req-8')).rejects.toBeInstanceOf(TypeError);
  });

  it('reads at most eight at once, all under one deadline', async () => {
    const mandates = Array.from({ length: 20 }, (_, i) => mandate(i + 1));
    const store = memoryStore({ mandates });
    let running = 0;
    let most = 0;
    const { chain, seen } = chainOf(async () => {
      running += 1;
      most = Math.max(most, running);
      await new Promise((resolve) => setTimeout(resolve, 1));
      running -= 1;
      return { state: state(1n) };
    });
    const service = createOverviewService({
      store,
      chain,
      log: () => undefined,
      now: () => NOW,
      chainBudgetMs: 60_000,
    });
    const overview = await service.overview(TENANT, {}, 'req-9');
    expect(overview.mandates).toHaveLength(20);
    expect(most).toBe(8);
    expect(new Set(seen.map((s) => s.options.signal)).size).toBe(1);
  });

  it('gives the reads a deadline that runs out', async () => {
    const store = memoryStore({ mandates: [mandate(1)] });
    const { chain, seen } = chainOf(
      (_contract, options) =>
        new Promise((_resolve, reject) => {
          options.signal.addEventListener('abort', () => {
            reject(new ChainError('TIMEOUT', 'the chain did not answer'));
          });
        }),
    );
    const service = createOverviewService({
      store,
      chain,
      log: () => undefined,
      now: () => NOW,
      chainBudgetMs: 20,
    });
    const overview = await service.overview(TENANT, {}, 'req-10');
    expect(overview.mandates[0]?.state).toBeNull();
    expect(seen[0]?.options.signal.aborted).toBe(true);
  });
});
