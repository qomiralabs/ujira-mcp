// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// Console settings, from the environment only. The treasury key is read
// here into a signer and goes nowhere else.

import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { z } from 'zod';

import type { TxSigner } from '../chain/adapter.js';
import { TESTNET_RPC_URL } from '../chain/stellar/gateway.js';
import { signerFromEnv } from '../chain/stellar/keys.js';
import { TESTNET_FRIENDBOT_URL, TESTNET_HORIZON_URL } from '../chain/stellar/network.js';
import {
  TESTNET_FACTORY,
  TESTNET_USDC_CONTRACT,
  TESTNET_USDC_ISSUER,
} from '../chain/stellar/testnet.js';
import { EngineError } from '../errors.js';
import { accountAddress, contractAddress } from '../ids.js';
import { minorUnits } from '../money.js';

export {
  TESTNET_FACTORY,
  TESTNET_USDC_CONTRACT,
  TESTNET_USDC_ISSUER,
} from '../chain/stellar/testnet.js';
export { TESTNET_FRIENDBOT_URL, TESTNET_HORIZON_URL } from '../chain/stellar/network.js';
/** The proof page is served by this same server, so a path keeps visitors on its origin. */
export const SDP_PROOF_URL = '/instaward';

export interface ConsoleLimits {
  /** Faucet claims an hour from one caller address. */
  readonly faucetPerHour: number;
  /** Test recipient wallets an hour from one caller address. */
  readonly testRecipientsPerHour: number;
  /** Friendbot calls an hour from one caller address. */
  readonly friendbotPerHour: number;
  /** API calls a minute from one caller address. */
  readonly apiCallsPerMinute: number;
  /** Payout requests an hour on one mandate, from the console and its MCP URL together. */
  readonly mandatePayoutsPerHour: number;
}

export interface ConsoleSettings {
  readonly dataDir: string;
  /** The built dashboard app, served under /app. */
  readonly consoleDir: string;
  /** The marketing site and the Instaward page, served at the root. */
  readonly siteDir: string;
  /** Pages asked for on any other host redirect to this one, such as ujira.co. */
  readonly canonicalHost?: string;
  readonly publicOrigin?: string;
  readonly horizonUrl: string;
  readonly friendbotUrl: string;
  /** The RPC URL browsers are told about; the server's own may be private. */
  readonly publicRpcUrl: string;
  readonly factory: string;
  readonly usdc: { readonly code: 'USDC'; readonly issuer: string; readonly contract: string };
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
  readonly limits: ConsoleLimits;
}

type Env = Readonly<Record<string, string | undefined>>;

function value(env: Env, name: string): string | undefined {
  const v = env[name]?.trim();
  return v === undefined || v === '' ? undefined : v;
}

function whole(env: Env, name: string, fallback: number, min: number, max: number): number {
  const raw = value(env, name);
  if (raw === undefined) return fallback;
  const parsed = z
    .string()
    .regex(/^\d{1,10}$/)
    .transform(Number)
    .pipe(z.number().int().min(min).max(max))
    .safeParse(raw);
  if (!parsed.success) {
    throw new EngineError('config_invalid', `${name} must be a whole number from ${min} to ${max}`);
  }
  return parsed.data;
}

function amount(env: Env, name: string, fallback: bigint): bigint {
  const raw = value(env, name);
  if (raw === undefined) return fallback;
  const parsed = minorUnits.safeParse(raw);
  if (!parsed.success) {
    throw new EngineError(
      'config_invalid',
      `${name} must be a positive whole number of minor units`,
    );
  }
  return parsed.data;
}

function url(env: Env, name: string, fallback: string): string {
  const raw = value(env, name) ?? fallback;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error('scheme');
  } catch {
    throw new EngineError('config_invalid', `${name} must be an http or https URL`);
  }
  return raw.replace(/\/+$/, '');
}

function strkey(env: Env, name: string, fallback: string, schema: z.ZodType<string>): string {
  const raw = value(env, name) ?? fallback;
  if (!schema.safeParse(raw).success) {
    throw new EngineError('config_invalid', `${name} is not a valid Stellar address`);
  }
  return raw;
}

/** An absolute http(s) URL, or a path on this server such as /instaward. */
function urlOrPath(env: Env, name: string, fallback: string): string {
  const raw = value(env, name) ?? fallback;
  // Two slashes would be another host, and a backslash reads as one in browsers.
  if (raw.startsWith('/')) {
    if (raw.startsWith('//') || raw.includes('\\') || /\s/.test(raw)) {
      throw new EngineError('config_invalid', `${name} must be an http or https URL or a path`);
    }
    return raw;
  }
  return url(env, name, fallback);
}

/** A host name with an optional port, such as ujira.co; no scheme, no path. */
const HOST =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*(?::\d{1,5})?$/;

function host(env: Env, name: string): string | undefined {
  const raw = value(env, name)?.toLowerCase();
  if (raw === undefined) return undefined;
  if (raw.length > 259 || !HOST.test(raw)) {
    throw new EngineError('config_invalid', `${name} must be a host name such as ujira.co`);
  }
  return raw;
}

/** A folder next to the package, from both src/console and dist/console. */
function packageDir(...parts: string[]): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', ...parts);
}

export function loadConsoleSettings(env: Env = process.env): ConsoleSettings {
  const receipts = value(env, 'UJIRA_RECEIPTS_FILE');
  // A host that already mounts a volume for receipts keeps the registry next to them.
  const dataDir = resolve(
    value(env, 'UJIRA_DATA_DIR') ?? (receipts === undefined ? 'data' : dirname(receipts)),
  );
  const origin = value(env, 'UJIRA_PUBLIC_ORIGIN');
  let publicOrigin: string | undefined;
  if (origin !== undefined) {
    try {
      publicOrigin = new URL(origin).origin;
    } catch {
      throw new EngineError(
        'config_invalid',
        'UJIRA_PUBLIC_ORIGIN must be an origin such as https://example.com',
      );
    }
  }
  const treasury = signerFromEnv(env, 'UJIRA_TREASURY');
  const faucetAmount = amount(env, 'UJIRA_FAUCET_AMOUNT', 500_000_000n);
  const canonicalHost = host(env, 'UJIRA_CANONICAL_HOST');
  return {
    dataDir,
    consoleDir: resolve(value(env, 'UJIRA_CONSOLE_DIR') ?? packageDir('console', 'dist')),
    siteDir: resolve(value(env, 'UJIRA_SITE_DIR') ?? packageDir('site')),
    ...(canonicalHost === undefined ? {} : { canonicalHost }),
    ...(publicOrigin === undefined ? {} : { publicOrigin }),
    horizonUrl: url(env, 'UJIRA_HORIZON_URL', TESTNET_HORIZON_URL),
    friendbotUrl: url(env, 'UJIRA_FRIENDBOT_URL', TESTNET_FRIENDBOT_URL),
    publicRpcUrl: url(env, 'UJIRA_PUBLIC_RPC_URL', TESTNET_RPC_URL),
    factory: strkey(env, 'UJIRA_FACTORY', TESTNET_FACTORY, contractAddress),
    usdc: {
      code: 'USDC',
      issuer: strkey(env, 'UJIRA_USDC_ISSUER', TESTNET_USDC_ISSUER, accountAddress),
      contract: strkey(env, 'UJIRA_USDC_CONTRACT', TESTNET_USDC_CONTRACT, contractAddress),
    },
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
      apiCallsPerMinute: whole(env, 'UJIRA_API_CALLS_PER_MINUTE', 240, 1, 100_000),
      mandatePayoutsPerHour: whole(env, 'UJIRA_MANDATE_PAYOUTS_PER_HOUR', 30, 1, 10_000),
    },
  };
}

/** Where the registry lives inside the data directory. */
export function registryPath(settings: Pick<ConsoleSettings, 'dataDir'>): string {
  return join(settings.dataDir, 'console-registry.json');
}

/** The test recipients' keys, kept apart from the registry. */
export function testWalletsPath(settings: Pick<ConsoleSettings, 'dataDir'>): string {
  return join(settings.dataDir, 'test-wallets.json');
}
