// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// Builds the console from the environment and the demo server's wiring, so
// both share one gateway, one receipt log and the same keys.

import { callOptions } from '../chain/adapter.js';
import { StellarChainAdapter } from '../chain/stellar/adapter.js';
import { signerFromEnv } from '../chain/stellar/keys.js';
import { TESTNET_FACTORY } from '../chain/stellar/testnet.js';
import { StellarEntryKeeper } from '../chain/stellar/ttl.js';
import type { Settings, Wiring } from '../config.js';
import { EngineError } from '../errors.js';
import type { ExtraRoutes } from '../mcp/http.js';
import type { HttpSettings } from '../mcp/public.js';
import { SdpClient } from '../rails/sdp.js';
import { MandateKeepAlive, loadKeepAliveSettings } from '../worker/keep-alive.js';
import { createConsole } from './app.js';
import { StellarConsoleChain } from './chain.js';
import { Recycler } from './recycler.js';
import { ConsoleRegistry } from './registry.js';
import {
  loadConsoleSettings,
  registryPath,
  testWalletsPath,
  type ConsoleSettings,
} from './settings.js';
import { TestWalletStore } from './wallets.js';

export { createConsole } from './app.js';
export { loadConsoleSettings } from './settings.js';

type Env = Readonly<Record<string, string | undefined>>;

/**
 * The demo mandate and every console mandate, kept alive through the console's
 * network and paid by the fee sponsor when one is configured.
 */
function keepAliveFrom(
  base: Settings,
  settings: ConsoleSettings,
  registry: ConsoleRegistry,
  adapter: StellarChainAdapter,
  chain: StellarConsoleChain,
  log: (line: string) => void,
  env: Env,
): MandateKeepAlive | undefined {
  const keep = loadKeepAliveSettings(env);
  if (!keep.enabled) return undefined;
  const payer = signerFromEnv(env, 'UJIRA_FEE_SPONSOR');
  const demoRecipients = [...base.recipientRefs].map(([destination, recipientRef]) => ({
    destination,
    recipientRef,
  }));
  return new MandateKeepAlive({
    keeper: new StellarEntryKeeper({ network: chain.network, passphrase: adapter.passphrase }),
    mandates: () => [
      { contract: base.mandateId, recipients: demoRecipients },
      ...registry.all().map((m) => ({
        contract: m.id,
        recipients: m.recipients.map((r) => ({
          destination: r.address,
          recipientRef: r.recipientRef,
        })),
      })),
    ],
    status: async (contract) => {
      const { config, state } = await adapter.readMandate(
        contract,
        callOptions(`keepalive:${contract}`),
      );
      return { active: !state.revoked && !state.expired, asset: config.asset };
    },
    shared: [...new Set([settings.factory, TESTNET_FACTORY])],
    ...(payer === undefined ? {} : { payer }),
    settings: keep,
    log,
  });
}

export function consoleFromEnv(
  base: Settings,
  wiring: Wiring,
  http: HttpSettings,
  log: (line: string) => void,
  env: Env = process.env,
): {
  routes: ExtraRoutes;
  settings: ConsoleSettings;
  recycler?: Recycler;
  keepAlive?: MandateKeepAlive;
} {
  const settings = loadConsoleSettings(env);
  const sdp = base.sdp;
  if (sdp !== undefined && sdp.assetIssuer !== settings.usdc.issuer) {
    throw new EngineError(
      'config_invalid',
      'the SDP asset issuer must be the USDC issuer the console uses (UJIRA_USDC_ISSUER)',
    );
  }
  const chain = new StellarConsoleChain({
    rpcUrl: base.rpcUrl,
    horizonUrl: settings.horizonUrl,
    friendbotUrl: settings.friendbotUrl,
  });
  // The console's mandates use its own factory and USDC, over the one gateway the demo uses.
  const adapter = new StellarChainAdapter({
    gateway: wiring.gateway,
    chain: chain.network,
    factory: settings.factory,
    asset: settings.usdc,
  });
  const registry = ConsoleRegistry.open(registryPath(settings));
  const keepAlive = keepAliveFrom(base, settings, registry, adapter, chain, log, env);
  // Test wallets are only worth keeping when there is a treasury to send their money back to.
  const wallets =
    settings.treasury === undefined ? undefined : TestWalletStore.open(testWalletsPath(settings));
  const routes = createConsole({
    settings,
    http,
    agent: base.agent,
    executor: base.executor,
    adapter,
    receipts: wiring.receipts,
    registry,
    chain,
    ...(wallets === undefined ? {} : { wallets }),
    ...(keepAlive === undefined ? {} : { warnings: (id: string) => keepAlive.warningsFor(id) }),
    ...(sdp === undefined
      ? {}
      : {
          sdp: {
            client: new SdpClient({
              baseUrl: sdp.url,
              auth: { kind: 'api_key', apiKey: sdp.apiKey },
              ...(sdp.tenant === undefined ? {} : { tenant: sdp.tenant }),
            }),
            distributionAccount: sdp.distributionAccount,
            assetIssuer: sdp.assetIssuer,
          },
        }),
    log,
  });
  const extras = keepAlive === undefined ? {} : { keepAlive };
  if (wallets === undefined || settings.treasury === undefined) {
    return { routes, settings, ...extras };
  }
  const recycler = new Recycler({
    wallets,
    chain,
    usdc: settings.usdc,
    treasury: settings.treasury.publicKey,
    log,
  });
  return { routes, settings, recycler, ...extras };
}
