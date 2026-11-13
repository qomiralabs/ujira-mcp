// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// Builds the console from the environment and the demo server's wiring, so
// both share one gateway, one receipt log and the same keys.

import type { Settings, Wiring } from '../config.js';
import { EngineError } from '../errors.js';
import type { ExtraRoutes } from '../mcp/http.js';
import type { HttpSettings } from '../mcp/public.js';
import { SdpClient } from '../rails/sdp.js';
import { createConsole } from './app.js';
import { StellarConsoleChain } from './chain.js';
import { ConsoleRegistry } from './registry.js';
import { loadConsoleSettings, registryPath, type ConsoleSettings } from './settings.js';

export { createConsole } from './app.js';
export { loadConsoleSettings } from './settings.js';

export function consoleFromEnv(
  base: Settings,
  wiring: Wiring,
  http: HttpSettings,
  log: (line: string) => void,
  env: Readonly<Record<string, string | undefined>> = process.env,
): { routes: ExtraRoutes; settings: ConsoleSettings } {
  const settings = loadConsoleSettings(env);
  const sdp = base.sdp;
  if (sdp !== undefined && sdp.assetIssuer !== settings.usdc.issuer) {
    throw new EngineError(
      'config_invalid',
      'the SDP asset issuer must be the USDC issuer the console uses (UJIRA_USDC_ISSUER)',
    );
  }
  const routes = createConsole({
    settings,
    http,
    agent: base.agent,
    executor: base.executor,
    gateway: wiring.gateway,
    receipts: wiring.receipts,
    registry: ConsoleRegistry.open(registryPath(settings)),
    chain: new StellarConsoleChain({
      rpcUrl: base.rpcUrl,
      horizonUrl: settings.horizonUrl,
      friendbotUrl: settings.friendbotUrl,
    }),
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
  return { routes, settings };
}
