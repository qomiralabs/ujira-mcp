// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// Console settings, from the environment only. The demo's faucet and SDP
// settings are read in src/demo, and only when the demo runs.

import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { z } from 'zod';

import { TESTNET_RPC_URL } from '../chain/stellar/gateway.js';
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

export interface ConsoleLimits {
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
  readonly limits: ConsoleLimits;
}

export type Env = Readonly<Record<string, string | undefined>>;

export function value(env: Env, name: string): string | undefined {
  const v = env[name]?.trim();
  return v === undefined || v === '' ? undefined : v;
}

export function whole(env: Env, name: string, fallback: number, min: number, max: number): number {
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

export function amount(env: Env, name: string, fallback: bigint): bigint {
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
export function urlOrPath(env: Env, name: string, fallback: string): string {
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
    limits: {
      apiCallsPerMinute: whole(env, 'UJIRA_API_CALLS_PER_MINUTE', 240, 1, 100_000),
      mandatePayoutsPerHour: whole(env, 'UJIRA_MANDATE_PAYOUTS_PER_HOUR', 30, 1, 10_000),
    },
  };
}

/** Where the registry lives inside the data directory. */
export function registryPath(settings: Pick<ConsoleSettings, 'dataDir'>): string {
  return join(settings.dataDir, 'console-registry.json');
}
