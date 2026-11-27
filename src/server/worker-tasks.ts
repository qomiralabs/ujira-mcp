// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// Builds the payout tasks the worker role runs, from the environment and the
// worker's database. This is a composition root: it picks the Stellar adapter
// and the keys, and nothing below it knows which chain it talks to.
//
// A payout is requested with the project's own agent key, opened from its
// sealed row under UJIRA_KEY_ENCRYPTION_KEY, which only the worker login can
// read. It is executed with UJIRA_EXECUTOR_SECRET or UJIRA_EXECUTOR_KEY_FILE.

import { StellarAgentAccounts } from '../chain/stellar/agent-accounts.js';
import { StellarChainAdapter } from '../chain/stellar/adapter.js';
import { RpcGateway, TESTNET_RPC_URL } from '../chain/stellar/gateway.js';
import { signerFromEnv } from '../chain/stellar/keys.js';
import {
  StellarNetwork,
  TESTNET_FRIENDBOT_URL,
  TESTNET_HORIZON_URL,
} from '../chain/stellar/network.js';
import {
  TESTNET_FACTORY,
  TESTNET_USDC_CONTRACT,
  TESTNET_USDC_ISSUER,
} from '../chain/stellar/testnet.js';
import type { Database } from '../db/index.js';
import { EngineError } from '../errors.js';
import { createAgentKeyService } from '../keys/agent-keys.js';
import { postgresAgentKeyStore } from '../keys/postgres-store.js';
import { requireSealer } from '../keys/settings.js';
import type { Log } from '../log.js';
import { payoutSigners } from '../payouts/signers.js';
import { PayoutWorkflow } from '../payouts/workflow.js';
import type { PayoutTaskDefinition } from '../worker/index.js';
import { payoutTasks } from '../worker/payout-tasks.js';

type Env = Readonly<Record<string, string | undefined>>;

function set(env: Env, name: string): string | undefined {
  const value = env[name];
  return value === undefined || value === '' ? undefined : value;
}

export function payoutTasksFromEnv(
  env: Env,
  log: Log,
  db: Database,
): readonly PayoutTaskDefinition[] {
  if ((set(env, 'UJIRA_NETWORK') ?? 'testnet') !== 'testnet') {
    throw new EngineError('config_invalid', 'only testnet is supported (UJIRA_NETWORK=testnet)');
  }
  const executor = signerFromEnv(env, 'UJIRA_EXECUTOR');
  if (executor === undefined) {
    throw new EngineError(
      'config_invalid',
      'the worker executes payouts: set UJIRA_EXECUTOR_SECRET or UJIRA_EXECUTOR_KEY_FILE',
    );
  }
  const sealer = requireSealer(env, 'the worker role');
  const rpcUrl = set(env, 'UJIRA_RPC_URL') ?? TESTNET_RPC_URL;
  const network = new StellarNetwork({
    rpcUrl,
    horizonUrl: TESTNET_HORIZON_URL,
    friendbotUrl: TESTNET_FRIENDBOT_URL,
  });
  const adapter = new StellarChainAdapter({
    gateway: new RpcGateway({ rpcUrl, readSource: executor.publicKey }),
    chain: network,
    factory: TESTNET_FACTORY,
    asset: { code: 'USDC', issuer: TESTNET_USDC_ISSUER, contract: TESTNET_USDC_CONTRACT },
  });
  const projectKeys = createAgentKeyService({
    store: postgresAgentKeyStore(db, { accounts: adapter, role: 'worker' }),
    sealer,
    accounts: new StellarAgentAccounts({ network: adapter.network, chain: network }),
    log,
  });
  const signers = payoutSigners({ executor, projectKeys });
  return payoutTasks({ workflow: new PayoutWorkflow({ chain: adapter, signers, log }), log });
}
