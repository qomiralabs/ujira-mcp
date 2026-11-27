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
import type { ExtraRoutes } from '../mcp/http.js';
import type { HttpSettings } from '../mcp/public.js';
import { MandateKeepAlive, loadKeepAliveSettings } from '../worker/keep-alive.js';
import { createConsole } from './app.js';
import { StellarConsoleChain, type ConsoleChain } from './chain.js';
import type { ConsoleExtension } from './extension.js';
import { ConsoleRegistry } from './registry.js';
import { loadConsoleSettings, registryPath, type ConsoleSettings } from './settings.js';

export { createConsole } from './app.js';
export type { ConsoleExtension } from './extension.js';
export { loadConsoleSettings } from './settings.js';

type Env = Readonly<Record<string, string | undefined>>;

/** What the console is built on, for whoever extends it. */
export interface ConsoleParts {
  readonly settings: ConsoleSettings;
  readonly http: HttpSettings;
  readonly chain: ConsoleChain;
  readonly registry: ConsoleRegistry;
}

export interface ConsoleFromEnv {
  readonly base: Settings;
  readonly wiring: Wiring;
  readonly http: HttpSettings;
  readonly log: (line: string) => void;
  readonly env?: Env;
  /** Builds the extension once the console's chain and registry exist. */
  readonly extend?: (parts: ConsoleParts) => ConsoleExtension;
}

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

export function consoleFromEnv(o: ConsoleFromEnv): {
  routes: ExtraRoutes;
  settings: ConsoleSettings;
  keepAlive?: MandateKeepAlive;
} {
  const env = o.env ?? process.env;
  const settings = loadConsoleSettings(env);
  const chain = new StellarConsoleChain({
    rpcUrl: o.base.rpcUrl,
    horizonUrl: settings.horizonUrl,
    friendbotUrl: settings.friendbotUrl,
  });
  // The console's mandates use its own factory and USDC, over the one gateway the demo uses.
  const adapter = new StellarChainAdapter({
    gateway: o.wiring.gateway,
    chain: chain.network,
    factory: settings.factory,
    asset: settings.usdc,
  });
  const registry = ConsoleRegistry.open(registryPath(settings));
  const keepAlive = keepAliveFrom(o.base, settings, registry, adapter, chain, o.log, env);
  const extension = o.extend?.({ settings, http: o.http, chain, registry });
  const routes = createConsole({
    settings,
    http: o.http,
    agent: o.base.agent,
    executor: o.base.executor,
    adapter,
    receipts: o.wiring.receipts,
    registry,
    chain,
    ...(extension === undefined ? {} : { extension }),
    ...(keepAlive === undefined ? {} : { warnings: (id: string) => keepAlive.warningsFor(id) }),
    log: o.log,
  });
  return { routes, settings, ...(keepAlive === undefined ? {} : { keepAlive }) };
}
