// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// Composes what the server reports about itself: the deep health check, the
// heartbeats the worker and the reconcile sweep beat, and the watches that
// write the executor_low, fee_sponsor_low and reconcile_stale alert lines.
// The entry point builds it once and starts and stops it with the server.

import { signerFromEnv } from '../chain/stellar/keys.js';
import { xlmStroops } from '../chain/stellar/network.js';
import { TESTNET_USDC_ISSUER } from '../chain/stellar/testnet.js';
import type { Settings, Wiring } from '../config.js';
import type { Log } from '../log.js';
import {
  BalanceWatch,
  EXECUTOR_LOW_STROOPS,
  FEE_SPONSOR_LOW_STROOPS,
  HeartbeatWatch,
  type WatchedAccount,
} from '../worker/alerts.js';
import { Heartbeats } from '../worker/heartbeat.js';
import { DeepHealth, databaseProbeFromEnv, type HealthReport } from './health.js';

type Env = Readonly<Record<string, string | undefined>>;

export interface Observability {
  /** For the worker and the reconcile sweep to beat. */
  readonly heartbeats: Heartbeats;
  readonly deepHealth: () => Promise<HealthReport>;
  start(): void;
  stop(): Promise<void>;
}

export interface ObservabilityFromEnv {
  readonly env: Env;
  readonly settings: Settings;
  readonly wiring: Pick<Wiring, 'adapter' | 'network'>;
  readonly log: Log;
}

/** The accounts whose XLM pays for UJIRA's own transactions, with their thresholds. */
export function watchedAccounts(settings: Settings, env: Env): WatchedAccount[] {
  const accounts: WatchedAccount[] = [
    {
      alert: 'executor_low',
      account: settings.executor.publicKey,
      thresholdStroops: EXECUTOR_LOW_STROOPS,
    },
  ];
  const sponsor = signerFromEnv(env, 'UJIRA_FEE_SPONSOR');
  if (sponsor !== undefined) {
    accounts.push({
      alert: 'fee_sponsor_low',
      account: sponsor.publicKey,
      thresholdStroops: FEE_SPONSOR_LOW_STROOPS,
    });
  }
  return accounts;
}

export function observabilityFromEnv(o: ObservabilityFromEnv): Observability {
  const heartbeats = new Heartbeats();
  const database = databaseProbeFromEnv(o.env);
  const health = new DeepHealth({
    ...(database.probe === undefined ? {} : { database: database.probe }),
    rpc: (call) => o.wiring.adapter.health(call),
    heartbeats,
    log: o.log,
  });
  const usdc = { code: 'USDC', issuer: TESTNET_USDC_ISSUER };
  const balances = new BalanceWatch({
    accounts: watchedAccounts(o.settings, o.env),
    balance: (account) => xlmStroops(o.wiring.network, account, usdc),
    log: o.log,
  });
  const late = new HeartbeatWatch({ heartbeats, log: o.log });
  return {
    heartbeats,
    deepHealth: () => health.check(),
    start() {
      balances.start();
      late.start();
    },
    async stop() {
      balances.stop();
      late.stop();
      await database.close();
    },
  };
}
