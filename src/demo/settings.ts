// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The demo's settings, read only when the demo runs. The treasury key is read
// here into a signer and goes nowhere else, and the SDP API key goes only to
// the SDP client.

import { join } from 'node:path';

import type { TxSigner } from '../chain/adapter.js';
import { signerFromEnv } from '../chain/stellar/keys.js';
import type { Settings } from '../config.js';
import {
  amount,
  urlOrPath,
  value,
  whole,
  type ConsoleSettings,
  type Env,
} from '../console/settings.js';
import { EngineError } from '../errors.js';
import { accountAddress } from '../ids.js';

/** The proof page is served by this same server, so a path keeps visitors on its origin. */
export const SDP_PROOF_URL = '/instaward';

export interface DemoLimits {
  /** Faucet claims an hour from one caller address. */
  readonly faucetPerHour: number;
  /** Test recipient wallets an hour from one caller address. */
  readonly testRecipientsPerHour: number;
  /** Friendbot calls an hour from one caller address. */
  readonly friendbotPerHour: number;
}

export interface SdpSettings {
  readonly url: string;
  readonly apiKey: string;
  readonly tenant?: string;
  readonly distributionAccount: string;
  readonly assetIssuer: string;
  /** Handle to wallet, from the mandate file's named recipients. */
  readonly recipients: Readonly<Record<string, string>>;
}

export interface DemoSettings {
  readonly treasury?: TxSigner;
  /** The faucet tops a wallet up to this many minor units. */
  readonly faucetAmount: bigint;
  /** The least time between two top ups of one wallet. */
  readonly faucetCooldownSeconds: number;
  /** How often test recipients send what they received back to the treasury. */
  readonly recycleIntervalSeconds: number;
  /** The faucet stops once the treasury would drop below this. */
  readonly faucetFloor: bigint;
  readonly sdpProofUrl: string;
  readonly limits: DemoLimits;
  /** Set when UJIRA_SDP_URL is: the SDP rail is then offered next to the wallet rail. */
  readonly sdp?: SdpSettings;
}

/** Only the mandate file facts are read from the base settings. */
type MandateFacts = Pick<Settings, 'assetIssuer' | 'namedRecipients'>;

export function loadDemoSettings(env: Env, base: MandateFacts): DemoSettings {
  const treasury = signerFromEnv(env, 'UJIRA_TREASURY');
  const faucetAmount = amount(env, 'UJIRA_FAUCET_AMOUNT', 500_000_000n);
  const sdp = sdpSettings(env, base);
  return {
    ...(treasury === undefined ? {} : { treasury }),
    faucetAmount,
    faucetCooldownSeconds: whole(env, 'UJIRA_FAUCET_COOLDOWN_SECONDS', 600, 0, 7 * 86_400),
    recycleIntervalSeconds: whole(env, 'UJIRA_RECYCLE_INTERVAL_SECONDS', 300, 10, 86_400),
    // Two claims' worth stays back by default, so a drained faucet still leaves the operator's own demos funded.
    faucetFloor: amount(env, 'UJIRA_FAUCET_FLOOR', faucetAmount * 2n),
    sdpProofUrl: urlOrPath(env, 'UJIRA_SDP_PROOF_URL', SDP_PROOF_URL),
    limits: {
      faucetPerHour: whole(env, 'UJIRA_FAUCET_PER_HOUR', 3, 1, 10_000),
      testRecipientsPerHour: whole(env, 'UJIRA_TEST_RECIPIENTS_PER_HOUR', 10, 1, 10_000),
      friendbotPerHour: whole(env, 'UJIRA_FRIENDBOT_PER_HOUR', 10, 1, 10_000),
    },
    ...(sdp === undefined ? {} : { sdp }),
  };
}

function sdpSettings(env: Env, base: MandateFacts): SdpSettings | undefined {
  const url = value(env, 'UJIRA_SDP_URL');
  if (url === undefined) return undefined;
  const apiKey = value(env, 'UJIRA_SDP_API_KEY');
  const distributionAccount = value(env, 'UJIRA_SDP_DISTRIBUTION');
  const assetIssuer = value(env, 'UJIRA_SDP_ASSET_ISSUER') ?? base.assetIssuer;
  if (apiKey === undefined) {
    throw new EngineError('config_invalid', 'UJIRA_SDP_URL is set, so set UJIRA_SDP_API_KEY too');
  }
  if (distributionAccount === undefined || !accountAddress.safeParse(distributionAccount).success) {
    throw new EngineError('config_invalid', 'set UJIRA_SDP_DISTRIBUTION to the SDP account (G...)');
  }
  if (assetIssuer === undefined) {
    throw new EngineError(
      'config_invalid',
      'set UJIRA_SDP_ASSET_ISSUER, or name the asset issuer in the mandate file',
    );
  }
  const tenant = value(env, 'UJIRA_SDP_TENANT');
  return {
    url,
    apiKey,
    distributionAccount,
    assetIssuer,
    recipients: base.namedRecipients,
    ...(tenant === undefined ? {} : { tenant }),
  };
}

/** The test recipients' keys, kept apart from the registry. */
export function testWalletsPath(settings: Pick<ConsoleSettings, 'dataDir'>): string {
  return join(settings.dataDir, 'test-wallets.json');
}
