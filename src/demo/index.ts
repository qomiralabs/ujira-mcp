// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The testnet demo, composed in one place: the faucet and test recipients,
// the recycler, the public demo MCP at /mcp and the SDP rail. Only an entry
// point builds it, and only when demoFeatures says the demo runs; product
// code never imports from here, which a lint rule enforces.

import type { MandateContract } from '../chain/adapter.js';
import type { Settings } from '../config.js';
import type { ConsoleExtension, ConsoleParts } from '../console/index.js';
import type { Env } from '../console/settings.js';
import { EngineError } from '../errors.js';
import type { PayoutEngine } from '../engine/engine.js';
import type { McpBinding } from '../mcp/http.js';
import type { HttpSettings } from '../mcp/public.js';
import type { PayoutRail } from '../rails/rail.js';
import { demoConsole, type DemoSdp } from './console.js';
import { publicMcp } from './public-mcp.js';
import { Recycler } from './recycler.js';
import { SdpClient, SdpRail } from './sdp.js';
import {
  loadDemoSettings,
  testWalletsPath,
  type DemoSettings,
  type SdpSettings,
} from './settings.js';
import { TestWalletStore } from './wallets.js';

export interface Demo {
  readonly settings: DemoSettings;
  /** Rails the public demo mandate offers next to the wallet rail. */
  rails(mandate: MandateContract): PayoutRail[];
  /** The demo's part of the console, built on the console's own chain and registry. */
  console(parts: ConsoleParts): ConsoleExtension;
  /** The /mcp binding over the public demo mandate. */
  publicMcp(engine: PayoutEngine, http: HttpSettings): (client: string) => McpBinding;
  /** Starts the recycler, when there is a treasury for it to refill. */
  start(): void;
  stop(): void;
  /** One log line saying what runs, with no key or address in it. */
  summary(): string;
}

function sdpClient(sdp: SdpSettings): SdpClient {
  return new SdpClient({
    baseUrl: sdp.url,
    auth: { kind: 'api_key', apiKey: sdp.apiKey },
    ...(sdp.tenant === undefined ? {} : { tenant: sdp.tenant }),
  });
}

export function createDemo(o: {
  readonly base: Settings;
  readonly env?: Env;
  readonly log: (line: string) => void;
}): Demo {
  const { base, log } = o;
  const settings = loadDemoSettings(o.env ?? process.env, base);
  const sdp = settings.sdp;
  const client = sdp === undefined ? undefined : sdpClient(sdp);
  let recycler: Recycler | undefined;

  return {
    settings,
    rails(mandate) {
      if (sdp === undefined || client === undefined) return [];
      return [
        new SdpRail({
          client,
          distributionAccount: sdp.distributionAccount,
          asset: { code: base.assetCode, issuer: sdp.assetIssuer },
          recipients: sdp.recipients,
          payToDistribution: (p) => mandate.execute(base.executor, p.payoutId),
        }),
      ];
    },
    console(parts) {
      if (sdp !== undefined && sdp.assetIssuer !== parts.settings.usdc.issuer) {
        throw new EngineError(
          'config_invalid',
          'the SDP asset issuer must be the USDC issuer the console uses (UJIRA_USDC_ISSUER)',
        );
      }
      // Test wallets are only worth keeping when there is a treasury to send their money back to.
      const wallets =
        settings.treasury === undefined
          ? undefined
          : TestWalletStore.open(testWalletsPath(parts.settings));
      const consoleSdp: DemoSdp | undefined =
        sdp === undefined || client === undefined
          ? undefined
          : { client, distributionAccount: sdp.distributionAccount, assetIssuer: sdp.assetIssuer };
      if (wallets !== undefined && settings.treasury !== undefined) {
        recycler = new Recycler({
          wallets,
          chain: parts.chain,
          usdc: parts.settings.usdc,
          treasury: settings.treasury.publicKey,
          log,
        });
      }
      return demoConsole({
        demo: settings,
        console: parts.settings,
        http: parts.http,
        chain: parts.chain,
        ledger: parts.registry,
        executor: base.executor,
        ...(consoleSdp === undefined ? {} : { sdp: consoleSdp }),
        ...(wallets === undefined ? {} : { wallets }),
        log,
      });
    },
    publicMcp(engine, http) {
      return publicMcp({
        engine,
        http,
        assetCode: base.assetCode,
        recipients: [...base.recipientRefs.keys()],
      });
    },
    start() {
      recycler?.start(settings.recycleIntervalSeconds * 1000);
    },
    stop() {
      recycler?.stop();
    },
    summary() {
      const recycling =
        recycler === undefined ? 'off' : `every ${String(settings.recycleIntervalSeconds)}s`;
      return `demo on: faucet ${settings.treasury === undefined ? 'off' : 'on'}, sdp ${sdp === undefined ? 'off' : 'on'}, recycler ${recycling}`;
    },
  };
}
