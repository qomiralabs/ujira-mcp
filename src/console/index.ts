// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// Builds the console from the environment and the demo server's wiring, so
// both share one gateway, one receipt log and the same keys.

import { StellarChainAdapter } from '../chain/stellar/adapter.js';
import type { Settings, Wiring } from '../config.js';
import type { ExtraRoutes } from '../mcp/http.js';
import type { HttpSettings } from '../mcp/public.js';
import { createConsole } from './app.js';
import { StellarConsoleChain, type ConsoleChain } from './chain.js';
import type { ConsoleExtension } from './extension.js';
import { ConsoleRegistry } from './registry.js';
import { loadConsoleSettings, registryPath, type ConsoleSettings } from './settings.js';

export { createConsole } from './app.js';
export type { ConsoleExtension } from './extension.js';
export { loadConsoleSettings } from './settings.js';

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
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Builds the extension once the console's chain and registry exist. */
  readonly extend?: (parts: ConsoleParts) => ConsoleExtension;
}

export function consoleFromEnv(o: ConsoleFromEnv): {
  routes: ExtraRoutes;
  settings: ConsoleSettings;
} {
  const settings = loadConsoleSettings(o.env ?? process.env);
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
    log: o.log,
  });
  return { routes, settings };
}
