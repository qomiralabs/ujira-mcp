// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The alert lines and the watches that write them. Each alert reaches the
// JSON sink at level error with `alert` set to its name.

import { createHash } from 'node:crypto';

import { Keypair } from '@stellar/stellar-sdk';
import { describe, expect, it } from 'vitest';

import { ChainError } from '../src/chain/adapter.js';
import { xlmStroops } from '../src/chain/stellar/network.js';
import { loadSettings } from '../src/config.js';
import { ALERT_EVENTS, logRecord } from '../src/log.js';
import { watchedAccounts } from '../src/server/observability.js';
import {
  BalanceWatch,
  EXECUTOR_LOW_STROOPS,
  FEE_SPONSOR_LOW_STROOPS,
  HeartbeatWatch,
  deadLetterLine,
  lowBalanceLine,
  reconcileStaleLine,
  type WatchedAccount,
} from '../src/worker/alerts.js';
import { Heartbeats, RECONCILE_MAX_AGE_MS, WORKER_MAX_AGE_MS } from '../src/worker/heartbeat.js';
import { MANDATE, agent, executor, testSigner } from './fake-rpc.js';

const TIME = new Date('2026-11-27T10:00:00.000Z');
const record = (line: string) => logRecord(line, 'test', TIME);

const PAYOUT = 'ab'.repeat(32);

describe('alert lines', () => {
  it('writes each alert at level error, named in `alert`', () => {
    const lines = [
      deadLetterLine({
        principalId: 'p-1',
        projectId: 'j-1',
        payoutId: PAYOUT,
        task: 'payout.execute',
        attempts: 10,
        error: new ChainError('TIMEOUT', 'the RPC did not answer at https://rpc.internal'),
      }),
      lowBalanceLine('fee_sponsor_low', {
        account: executor.publicKey,
        balanceStroops: 10n,
        thresholdStroops: 20n,
      }),
      lowBalanceLine('executor_low', {
        account: executor.publicKey,
        balanceStroops: 10n,
        thresholdStroops: 20n,
      }),
      reconcileStaleLine({ lastRunAt: null, ageSeconds: 400, maxAgeSeconds: 360 }),
    ];
    const records = lines.map(record);
    expect(records.map((r) => r['alert'])).toEqual([...ALERT_EVENTS]);
    for (const r of records) expect(r['level']).toBe('error');
    expect(records[0]).toMatchObject({
      principalId: 'p-1',
      projectId: 'j-1',
      payoutId: PAYOUT,
      task: 'payout.execute',
      attempts: 10,
      error: 'TIMEOUT',
    });
    expect(lines[0]).not.toContain('rpc.internal');
    expect(records[2]).toMatchObject({ exists: 'true', balanceStroops: 10, thresholdStroops: 20 });
    expect(records[3]).toMatchObject({ lastRunAt: 'never', ageSeconds: 400, maxAgeSeconds: 360 });
  });

  it('says when a watched account does not exist at all', () => {
    expect(
      lowBalanceLine('executor_low', {
        account: executor.publicKey,
        balanceStroops: null,
        thresholdStroops: 1n,
      }),
    ).toBe(
      `event=executor_low account=${executor.publicKey} exists=false balanceStroops=0 thresholdStroops=1`,
    );
  });
});

describe('the balance watch', () => {
  const sponsor = testSigner('sponsor').publicKey;
  const accounts: WatchedAccount[] = [
    { alert: 'executor_low', account: executor.publicKey, thresholdStroops: 100n },
    { alert: 'fee_sponsor_low', account: sponsor, thresholdStroops: 100n },
  ];

  it('alerts for an account under its threshold or missing, and not for one at or over it', async () => {
    const lines: string[] = [];
    const balances = new Map<string, bigint | null>([
      [executor.publicKey, 99n],
      [sponsor, 100n],
    ]);
    const watch = new BalanceWatch({
      accounts,
      balance: (a) => Promise.resolve(balances.get(a) ?? null),
      log: (l) => lines.push(l),
    });
    await watch.runOnce();
    expect(lines).toEqual([
      `event=executor_low account=${executor.publicKey} exists=true balanceStroops=99 thresholdStroops=100`,
    ]);
    balances.set(sponsor, null);
    lines.length = 0;
    await watch.runOnce();
    expect(lines.map((l) => record(l)['alert'])).toEqual(['executor_low', 'fee_sponsor_low']);
  });

  it('logs a failed read by code, not as an alert, and still checks the other accounts', async () => {
    const lines: string[] = [];
    const watch = new BalanceWatch({
      accounts,
      balance: (a) =>
        a === executor.publicKey
          ? Promise.reject(new ChainError('UNAVAILABLE', 'horizon at https://h.internal is down'))
          : Promise.resolve(0n),
      log: (l) => lines.push(l),
    });
    await watch.runOnce();
    expect(lines[0]).toBe('event=balance_check_failed check=executor_low error=UNAVAILABLE');
    expect(record(lines[1] ?? '')['alert']).toBe('fee_sponsor_low');
  });

  it('starts and stops without holding the process, and not at all with nothing to watch', () => {
    const watch = new BalanceWatch({
      accounts,
      balance: () => Promise.resolve(0n),
      log: () => undefined,
    });
    watch.start(60_000);
    watch.start(60_000);
    watch.stop();
    const none = new BalanceWatch({
      accounts: [],
      balance: () => Promise.resolve(0n),
      log: () => undefined,
    });
    none.start();
    none.stop();
  });

  it('reads XLM in stroops with integer math, and null for an account that does not exist', async () => {
    const usdc = { code: 'USDC', issuer: executor.publicKey };
    const network = (exists: boolean, xlm: string | null) => ({
      account: () => Promise.resolve({ exists, xlm, usdc: null }),
    });
    expect(await xlmStroops(network(true, '12.3456789'), agent.publicKey, usdc)).toBe(123_456_789n);
    expect(await xlmStroops(network(true, '0.1'), agent.publicKey, usdc)).toBe(1_000_000n);
    expect(await xlmStroops(network(false, null), agent.publicKey, usdc)).toBeNull();
  });

  it('watches the executor always and the fee sponsor when one is configured', () => {
    const secret = (seed: string) =>
      Keypair.fromRawEd25519Seed(createHash('sha256').update(seed).digest());
    const agentKey = secret('watch-agent');
    const sponsorKey = secret('watch-sponsor');
    const settings = loadSettings({
      UJIRA_MANDATE_ID: MANDATE,
      UJIRA_AGENT_SECRET: agentKey.secret(),
    });
    const executorWatch = {
      alert: 'executor_low',
      account: agentKey.publicKey(),
      thresholdStroops: EXECUTOR_LOW_STROOPS,
    };
    expect(watchedAccounts(settings, {})).toEqual([executorWatch]);
    expect(watchedAccounts(settings, { UJIRA_FEE_SPONSOR_SECRET: sponsorKey.secret() })).toEqual([
      executorWatch,
      {
        alert: 'fee_sponsor_low',
        account: sponsorKey.publicKey(),
        thresholdStroops: FEE_SPONSOR_LOW_STROOPS,
      },
    ]);
  });
});

describe('the heartbeat watch', () => {
  it('writes reconcile_stale while the sweep is late, and a line when the worker is', async () => {
    let t = 0;
    const heartbeats = new Heartbeats(() => t);
    const lines: string[] = [];
    const watch = new HeartbeatWatch({ heartbeats, log: (l) => lines.push(l) });

    await watch.runOnce();
    expect(lines).toEqual([]);

    heartbeats.expect('reconcile', RECONCILE_MAX_AGE_MS);
    heartbeats.expect('worker', WORKER_MAX_AGE_MS);
    t = RECONCILE_MAX_AGE_MS + 1_000;
    await watch.runOnce();
    expect(lines).toEqual([
      'event=reconcile_stale lastRunAt=never ageSeconds=361 maxAgeSeconds=360',
      'event=worker_heartbeat_stale level=error lastAt=never ageSeconds=361 maxAgeSeconds=60',
    ]);
    expect(record(lines[0] ?? '')).toMatchObject({ level: 'error', alert: 'reconcile_stale' });

    heartbeats.beat('reconcile');
    heartbeats.beat('worker');
    lines.length = 0;
    await watch.runOnce();
    expect(lines).toEqual([]);

    watch.start(60_000);
    watch.stop();
  });
});
