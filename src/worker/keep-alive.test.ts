// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ChainError,
  type EntryKeeper,
  type KeepAliveTarget,
  type KeptEntry,
  type KeptEntryKind,
  type TxSigner,
} from '../chain/adapter.js';
import {
  MandateKeepAlive,
  loadKeepAliveSettings,
  type KeepAliveOptions,
  type KeepAliveSettings,
  type MandateStatus,
} from './keep-alive.js';

const DAY = 17_280;
const MIN_PERSISTENT_TTL = 7 * DAY;
const M1 = 'CDEEDQ64YS6XHBTWC3QLS5JWOLI3LSO46VDDZE66FW6CZGHZNRDV4GZW';
const M2 = 'CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA';
const FACTORY = 'CB4AYBA5NVQPVPNOWUCSZQK6ZIGOF7KSCS6SF6UV6D2OKPDXLHEPD4V7';
const USDC = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA';
const REF = 'a5af47dc553b19356f6fd85bdabb3be0256fb70fbc800ce3d3100508609b76a7';
const DEST = 'GDWQCLVZKFKKIQGXOSRZRLOBJ4V5J6UQ2L5D3RC4Y3IGEJXFZ4VJFPLX';

const payer: TxSigner = {
  publicKey: 'GD3XRLSLLSHDWCYVIVDKAZ2AQPBFCPV35HJGWGGYKVAWCYJKWWBRVRMK',
  sign: () => undefined,
};

const settings: KeepAliveSettings = {
  enabled: true,
  thresholdLedgers: 20 * DAY,
  extendToLedgers: 60 * DAY,
  maxMandatesPerRun: 200,
  maxTransactionsPerRun: 50,
  keysPerTransaction: 25,
  intervalSeconds: 86_400,
};

type Row = { kind: KeptEntryKind; state: KeptEntry['state']; ledgersLeft: number };

/** Entries by contract, changed by what is sent, as the network would change them. */
class FakeKeeper implements EntryKeeper {
  readonly maxExtendLedgers = 3_110_399;
  rows = new Map<string, Map<string, Row>>();
  reads: KeepAliveTarget[] = [];
  sent: { action: 'extend' | 'restore'; ids: string[]; ledgers?: number }[] = [];
  failNext: Error[] = [];
  private n = 0;

  set(contract: string, rows: Record<string, Row>) {
    this.rows.set(contract, new Map(Object.entries(rows)));
  }

  private row(id: string): Row {
    for (const rows of this.rows.values()) {
      const row = rows.get(id);
      if (row !== undefined) return row;
    }
    throw new Error(`unknown entry ${id}`);
  }

  private hash(): string {
    this.n += 1;
    return this.n.toString(16).padStart(64, '0');
  }

  entries(target: KeepAliveTarget) {
    this.reads.push(target);
    const rows = this.rows.get(target.contract);
    if (rows === undefined) return Promise.reject(new ChainError('UNAVAILABLE', 'no answer'));
    const entries = [...rows].map(([id, r]): KeptEntry => ({ id, ...r }));
    return Promise.resolve({ latestLedger: 5_932_880, entries });
  }

  private take(): void {
    const next = this.failNext.shift();
    if (next !== undefined) throw next;
  }

  extend(ids: readonly string[], ledgers: number) {
    this.take();
    this.sent.push({ action: 'extend', ids: [...ids], ledgers });
    for (const id of ids) {
      const row = this.row(id);
      if (row.state !== 'live') throw new Error('extending an archived entry fails on chain');
      row.ledgersLeft = Math.max(row.ledgersLeft, ledgers);
    }
    return Promise.resolve({ txHash: this.hash() });
  }

  restore(ids: readonly string[]) {
    this.take();
    this.sent.push({ action: 'restore', ids: [...ids] });
    for (const id of ids)
      Object.assign(this.row(id), { state: 'live', ledgersLeft: MIN_PERSISTENT_TTL });
    return Promise.resolve({ txHash: this.hash() });
  }
}

const live = (kind: KeptEntryKind, days: number): Row => ({
  kind,
  state: 'live',
  ledgersLeft: Math.floor(days * DAY),
});
const archived = (kind: KeptEntryKind): Row => ({ kind, state: 'archived', ledgersLeft: 0 });

/** The demo mandate as testnet had it on 2026-11-26. */
function demo(keeper: FakeKeeper, contract = M1) {
  keeper.set(contract, {
    [`${contract}:instance`]: live('instance', 19.1),
    [`${contract}:code`]: live('code', 25.1),
    [`${contract}:balance`]: live('balance', 18.1),
    [`${contract}:allowed`]: archived('allowed'),
    [`${contract}:daily`]: archived('daily'),
  });
}

/** `payer: null` builds one with no payer, as a server without a fee sponsor runs. */
function world(
  over: Partial<Omit<KeepAliveOptions, 'payer'>> & { payer?: TxSigner | null } = {},
  status?: (c: string) => MandateStatus,
) {
  const keeper = new FakeKeeper();
  const lines: string[] = [];
  const { payer: chosen, ...rest } = over;
  const keepAlive = new MandateKeepAlive({
    keeper,
    mandates: () => [{ contract: M1, recipients: [{ recipientRef: REF, destination: DEST }] }],
    status: (c) => Promise.resolve(status?.(c) ?? { active: true, asset: USDC }),
    ...(chosen === null ? {} : { payer: chosen ?? payer }),
    settings,
    log: (line) => lines.push(line),
    ...rest,
  });
  return { keeper, lines, keepAlive };
}

describe('MandateKeepAlive', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('extends only the entries under the threshold, paid by the payer', async () => {
    const { keeper, lines, keepAlive } = world();
    keeper.set(M1, {
      i: live('instance', 19.1),
      c: live('code', 25.1),
      b: live('balance', 18.1),
    });

    const run = await keepAlive.runOnce();

    expect(keeper.sent).toEqual([{ action: 'extend', ids: ['i', 'b'], ledgers: 60 * DAY }]);
    expect(run).toMatchObject({ checked: 1, extended: 2, restored: 0, archived: 0, deferred: 0 });
    expect(run.transactions).toHaveLength(1);
    expect(keeper.reads[0]).toEqual({
      contract: M1,
      asset: USDC,
      recipients: [{ recipientRef: REF, destination: DEST }],
    });
    expect(lines).toContain(
      `event=mandate_entry_extended contract=${M1} kinds=instance,balance count=2 ledgers=${String(60 * DAY)} tx=${run.transactions[0] ?? ''}`,
    );
    expect(keepAlive.warningsFor(M1)).toEqual([]);
  });

  it('reports archived entries, restores them, then extends them past the minimum', async () => {
    const { keeper, lines, keepAlive } = world();
    demo(keeper);

    const run = await keepAlive.runOnce();

    expect(lines).toContain(
      `event=mandate_entry_archived contract=${M1} kinds=allowed,daily count=2`,
    );
    expect(keeper.sent.map((s) => [s.action, s.ids])).toEqual([
      ['restore', [`${M1}:allowed`, `${M1}:daily`]],
      ['extend', [`${M1}:instance`, `${M1}:balance`, `${M1}:allowed`, `${M1}:daily`]],
    ]);
    expect(run).toMatchObject({ archived: 2, restored: 2, extended: 4 });
    expect(keepAlive.warningsFor(M1)).toEqual([]);
  });

  it('without a payer only reads, logs, and leaves the mandate a warning', async () => {
    const { keeper, lines, keepAlive } = world({ payer: null });
    demo(keeper);

    const run = await keepAlive.runOnce();

    expect(keeper.sent).toEqual([]);
    expect(run).toMatchObject({ archived: 2, restored: 0, extended: 0, deferred: 4 });
    expect(lines.some((l) => l.startsWith('event=mandate_entry_archived'))).toBe(true);
    expect(lines.at(-1)).toMatch(/^event=mandate_keepalive_run .* payer=none$/);
    expect(keepAlive.warningsFor(M1)).toEqual([
      expect.objectContaining({ code: 'ledger_entries_archived', kinds: ['allowed', 'daily'] }),
    ]);
  });

  it('sends nothing on a second run, since the first left every entry above the threshold', async () => {
    const { keeper, keepAlive } = world();
    demo(keeper);
    await keepAlive.runOnce();
    const sent = keeper.sent.length;

    const again = await keepAlive.runOnce();

    expect(keeper.sent).toHaveLength(sent);
    expect(again).toMatchObject({ checked: 1, archived: 0, extended: 0, transactions: [] });
  });

  it('shares a run in flight instead of starting a second one', async () => {
    const { keeper, keepAlive } = world();
    demo(keeper);
    const [a, b] = [keepAlive.runOnce(), keepAlive.runOnce()];
    expect(a).toBe(b);
    await a;
    expect(keeper.reads).toHaveLength(1);
    expect(keeper.sent).toHaveLength(2);
  });

  it('reads at most the configured mandates a run and gives each its turn', async () => {
    const ids = [M1, M2, 'CA1', 'CA2', 'CA3'];
    const { keeper, keepAlive } = world({
      mandates: () => ids.map((contract) => ({ contract, recipients: [] })),
      settings: { ...settings, maxMandatesPerRun: 2 },
    });
    for (const id of ids) keeper.set(id, { [`${id}:i`]: live('instance', 30) });

    const seen: string[][] = [];
    for (let i = 0; i < 3; i++) {
      keeper.reads = [];
      await keepAlive.runOnce();
      seen.push(keeper.reads.map((r) => r.contract));
    }

    expect(seen).toEqual([
      [M1, M2],
      ['CA1', 'CA2'],
      ['CA3', M1],
    ]);
  });

  it('sends at most the configured transactions a run and defers the rest', async () => {
    const { keeper, lines, keepAlive } = world({
      mandates: () => [M1, M2].map((contract) => ({ contract, recipients: [] })),
      settings: { ...settings, maxTransactionsPerRun: 1 },
    });
    keeper.set(M1, { a: live('instance', 1) });
    keeper.set(M2, { b: live('instance', 1) });

    const run = await keepAlive.runOnce();

    expect(keeper.sent).toEqual([{ action: 'extend', ids: ['a'], ledgers: 60 * DAY }]);
    expect(run).toMatchObject({ extended: 1, deferred: 1 });
    expect(lines.at(-1)).toContain('deferred=1');
    // The next run picks up what this one left.
    await keepAlive.runOnce();
    expect(keeper.sent.map((s) => s.ids)).toEqual([['a'], ['b']]);
  });

  it('splits a large footprint into transactions of the configured size', async () => {
    const { keeper, keepAlive } = world({ settings: { ...settings, keysPerTransaction: 2 } });
    keeper.set(
      M1,
      Object.fromEntries(['a', 'b', 'c', 'd', 'e'].map((id) => [id, live('allowed', 3)])),
    );
    await keepAlive.runOnce();
    expect(keeper.sent.map((s) => s.ids)).toEqual([['a', 'b'], ['c', 'd'], ['e']]);
  });

  it('keeps the shared factory alive with no asset and no recipients', async () => {
    const { keeper, keepAlive } = world({ shared: [FACTORY], mandates: () => [] });
    keeper.set(FACTORY, { f: live('instance', 2), g: live('code', 25) });
    await keepAlive.runOnce();
    expect(keeper.reads).toEqual([{ contract: FACTORY, asset: null, recipients: [] }]);
    expect(keeper.sent).toEqual([{ action: 'extend', ids: ['f'], ledgers: 60 * DAY }]);
  });

  it('passes over revoked or expired mandates and drops their warning', async () => {
    let active = true;
    const { keeper, keepAlive } = world({ payer: null }, () => ({ active, asset: USDC }));
    demo(keeper);
    await keepAlive.runOnce();
    expect(keepAlive.warningsFor(M1)).toHaveLength(1);

    active = false;
    keeper.reads = [];
    const run = await keepAlive.runOnce();

    expect(run).toMatchObject({ inactive: 1, checked: 0 });
    expect(keeper.reads).toEqual([]);
    expect(keepAlive.warningsFor(M1)).toEqual([]);
  });

  it('merges a mandate listed twice and carries on past one that fails', async () => {
    const { keeper, lines, keepAlive } = world({
      mandates: () => [
        { contract: 'CBROKEN', recipients: [] },
        { contract: M1, recipients: [{ recipientRef: REF, destination: DEST }] },
        { contract: M1, recipients: [{ recipientRef: REF, destination: M2 }] },
      ],
    });
    keeper.set(M1, { i: live('instance', 30) });

    const run = await keepAlive.runOnce();

    expect(run).toMatchObject({ failed: 1, checked: 1 });
    expect(lines).toContain('event=mandate_keepalive_failed contract=CBROKEN error=UNAVAILABLE');
    expect(keeper.reads.find((r) => r.contract === M1)?.recipients).toHaveLength(2);
  });

  it('counts a mandate it cannot read the status of as failed', async () => {
    const { keeper, lines, keepAlive } = world({
      status: () => Promise.reject(new Error('boom')),
    });
    demo(keeper);
    const run = await keepAlive.runOnce();
    expect(run).toMatchObject({ failed: 1, checked: 0 });
    expect(lines).toContain(`event=mandate_keepalive_failed contract=${M1} error=internal_error`);
  });

  it('stops sending for the run once a send times out, and logs the hash to look up', async () => {
    const { keeper, lines, keepAlive } = world({
      mandates: () => [M1, M2].map((contract) => ({ contract, recipients: [] })),
    });
    keeper.set(M1, { a: live('instance', 1) });
    keeper.set(M2, { b: live('instance', 1) });
    keeper.failNext.push(new ChainError('TIMEOUT', 'lost', { txHash: 'f'.repeat(64) }));

    const run = await keepAlive.runOnce();

    expect(keeper.sent).toEqual([]);
    expect(run).toMatchObject({ failed: 1, deferred: 2, checked: 2 });
    expect(lines).toContain(
      `event=mandate_entry_extend_failed contract=${M1} count=1 error=TIMEOUT tx=${'f'.repeat(64)}`,
    );
  });

  it('carries on to the next mandate after a refused transaction', async () => {
    const { keeper, lines, keepAlive } = world({
      mandates: () => [M1, M2].map((contract) => ({ contract, recipients: [] })),
    });
    keeper.set(M1, { a: archived('instance') });
    keeper.set(M2, { b: live('instance', 1) });
    keeper.failNext.push(new ChainError('TX_FAILED', 'refused'));

    const run = await keepAlive.runOnce();

    expect(keeper.sent).toEqual([{ action: 'extend', ids: ['b'], ledgers: 60 * DAY }]);
    expect(run).toMatchObject({ failed: 1, extended: 1, restored: 0 });
    expect(lines).toContain(
      `event=mandate_entry_restore_failed contract=${M1} count=1 error=TX_FAILED`,
    );
    expect(keepAlive.warningsFor(M1)).toEqual([expect.objectContaining({ kinds: ['instance'] })]);
  });

  it('refuses an extension the network would not allow', () => {
    expect(
      () => world({ settings: { ...settings, extendToLedgers: 3_110_400 } }).keepAlive,
    ).toThrow(/UJIRA_KEEPALIVE_EXTEND_TO_LEDGERS/);
  });

  it('runs soon after start and then every interval, and not at all when off', async () => {
    vi.useFakeTimers();
    const { keeper, keepAlive } = world({ settings: { ...settings, intervalSeconds: 3_600 } });
    keeper.set(M1, { i: live('instance', 30) });
    keepAlive.start(1_000);
    keepAlive.start(1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(keeper.reads).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(keeper.reads).toHaveLength(2);
    keepAlive.stop();
    await vi.advanceTimersByTimeAsync(10 * 3_600_000);
    expect(keeper.reads).toHaveLength(2);

    const off = world({ settings: { ...settings, enabled: false } });
    off.keepAlive.start(0);
    await vi.advanceTimersByTimeAsync(10 * 3_600_000);
    expect(off.keeper.reads).toEqual([]);
  });
});

describe('loadKeepAliveSettings', () => {
  it('defaults to on, twenty days, sixty days, daily, with bounded runs', () => {
    expect(loadKeepAliveSettings({})).toEqual({
      enabled: true,
      thresholdLedgers: 345_600,
      extendToLedgers: 1_036_800,
      maxMandatesPerRun: 200,
      maxTransactionsPerRun: 50,
      keysPerTransaction: 25,
      intervalSeconds: 86_400,
    });
  });

  it('reads every setting from the environment', () => {
    expect(
      loadKeepAliveSettings({
        UJIRA_KEEPALIVE: 'off',
        UJIRA_KEEPALIVE_THRESHOLD_LEDGERS: '100',
        UJIRA_KEEPALIVE_EXTEND_TO_LEDGERS: '200',
        UJIRA_KEEPALIVE_MANDATES_PER_RUN: '3',
        UJIRA_KEEPALIVE_TRANSACTIONS_PER_RUN: '4',
        UJIRA_KEEPALIVE_KEYS_PER_TRANSACTION: '5',
        UJIRA_KEEPALIVE_INTERVAL_SECONDS: '600',
        UNRELATED: 'x',
      }),
    ).toEqual({
      enabled: false,
      thresholdLedgers: 100,
      extendToLedgers: 200,
      maxMandatesPerRun: 3,
      maxTransactionsPerRun: 4,
      keysPerTransaction: 5,
      intervalSeconds: 600,
    });
    expect(loadKeepAliveSettings({ UJIRA_KEEPALIVE_THRESHOLD_LEDGERS: '' }).thresholdLedgers).toBe(
      345_600,
    );
  });

  it('refuses values out of range and an extension not above the threshold', () => {
    for (const env of [
      { UJIRA_KEEPALIVE: 'yes' },
      { UJIRA_KEEPALIVE_THRESHOLD_LEDGERS: '1.5' },
      { UJIRA_KEEPALIVE_THRESHOLD_LEDGERS: '-1' },
      { UJIRA_KEEPALIVE_EXTEND_TO_LEDGERS: '3110400' },
      { UJIRA_KEEPALIVE_KEYS_PER_TRANSACTION: '0' },
      { UJIRA_KEEPALIVE_INTERVAL_SECONDS: '59' },
      { UJIRA_KEEPALIVE_THRESHOLD_LEDGERS: '500', UJIRA_KEEPALIVE_EXTEND_TO_LEDGERS: '500' },
    ]) {
      expect(() => loadKeepAliveSettings(env), JSON.stringify(env)).toThrow(
        expect.objectContaining({ code: 'config_invalid' }) as Error,
      );
    }
  });
});
