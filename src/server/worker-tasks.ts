// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// Builds the payout tasks the worker role runs, from the environment. This is
// a composition root: it picks the Stellar adapter and the keys, and nothing
// below it knows which chain it talks to.
//
// The executor key is UJIRA_EXECUTOR_SECRET or UJIRA_EXECUTOR_KEY_FILE. The
// agent key is the shared one, UJIRA_AGENT_SECRET or UJIRA_AGENT_KEY_FILE,
// which signs only for mandates that name it; a project's own key plugs in
// through the signers' projectKeys. Without its own key the agent executes,
// which the mandate allows, as the console engine has always done.

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
import { EngineError } from '../errors.js';
import type { Log } from '../log.js';
import { payoutSigners, type ProjectKeySigner } from '../payouts/signers.js';
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
  options: { readonly projectKeys?: ProjectKeySigner } = {},
): readonly PayoutTaskDefinition[] {
  if ((set(env, 'UJIRA_NETWORK') ?? 'testnet') !== 'testnet') {
    throw new EngineError('config_invalid', 'only testnet is supported (UJIRA_NETWORK=testnet)');
  }
  const sharedAgent = signerFromEnv(env, 'UJIRA_AGENT');
  const executor = signerFromEnv(env, 'UJIRA_EXECUTOR') ?? sharedAgent;
  if (executor === undefined) {
    throw new EngineError(
      'config_invalid',
      'the worker runs payouts: set UJIRA_EXECUTOR_SECRET or UJIRA_EXECUTOR_KEY_FILE',
    );
  }
  const rpcUrl = set(env, 'UJIRA_RPC_URL') ?? TESTNET_RPC_URL;
  const adapter = new StellarChainAdapter({
    gateway: new RpcGateway({ rpcUrl, readSource: executor.publicKey }),
    chain: new StellarNetwork({
      rpcUrl,
      horizonUrl: TESTNET_HORIZON_URL,
      friendbotUrl: TESTNET_FRIENDBOT_URL,
    }),
    factory: TESTNET_FACTORY,
    asset: { code: 'USDC', issuer: TESTNET_USDC_ISSUER, contract: TESTNET_USDC_CONTRACT },
  });
  const signers = payoutSigners({
    executor,
    ...(sharedAgent === undefined ? {} : { sharedAgent }),
    ...(options.projectKeys === undefined ? {} : { projectKeys: options.projectKeys }),
  });
  return payoutTasks({ workflow: new PayoutWorkflow({ chain: adapter, signers, log }), log });
}
