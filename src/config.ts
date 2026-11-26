// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// Settings come from the environment, and keys only from the environment or
// files it names. Nothing a tool caller sends can change a key or the
// mandate the engine works for.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { z } from 'zod';

import type { MandateContract, TxSigner } from './chain/adapter.js';
import { StellarChainAdapter } from './chain/stellar/adapter.js';
import { RpcGateway, TESTNET_RPC_URL, type SorobanGateway } from './chain/stellar/gateway.js';
import { signerFromEnv } from './chain/stellar/keys.js';
import {
  StellarNetwork,
  TESTNET_FRIENDBOT_URL,
  TESTNET_HORIZON_URL,
  type StellarNetworkPort,
} from './chain/stellar/network.js';
import {
  TESTNET_FACTORY,
  TESTNET_USDC_CONTRACT,
  TESTNET_USDC_ISSUER,
} from './chain/stellar/testnet.js';
import { PayoutEngine } from './engine/engine.js';
import { EngineError } from './errors.js';
import { accountAddress, contractAddress, hex32, type Hex32 } from './ids.js';
import type { PayoutRail } from './rails/rail.js';
import { WalletRail } from './rails/wallet.js';
import { ReceiptLog } from './receipts/log.js';

export interface Settings {
  readonly network: 'testnet';
  readonly rpcUrl: string;
  readonly mandateId: string;
  readonly assetCode: string;
  readonly recipientRefs: ReadonlyMap<string, Hex32>;
  readonly agent: TxSigner;
  readonly executor: TxSigner;
  readonly receiptsPath: string;
  /** The asset issuer the mandate file names, if it names one. */
  readonly assetIssuer?: string;
  /** Recipient names to wallets, from the mandate file's named recipients. */
  readonly namedRecipients: Readonly<Record<string, string>>;
}

/** The parts of a mandate file this package reads; anything else in it is ignored. */
const mandateFile = z.object({
  network: z.literal('testnet').optional(),
  mandate: contractAddress,
  asset: z
    .object({ code: z.string().min(1).max(12), issuer: accountAddress.optional() })
    .optional(),
  recipients: z
    .array(z.object({ recipient_ref: hex32, destination: z.string(), name: z.string().optional() }))
    .default([]),
});

type Env = Readonly<Record<string, string | undefined>>;

function set(env: Env, name: string): string | undefined {
  const value = env[name];
  return value === undefined || value === '' ? undefined : value;
}

function parseMandate(text: string, name: string): z.output<typeof mandateFile> {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new EngineError('config_invalid', `${name} cannot be read as JSON`, { cause: error });
  }
  const parsed = mandateFile.safeParse(json);
  if (!parsed.success) {
    throw new EngineError('config_invalid', `${name} is missing the mandate address`);
  }
  return parsed.data;
}

function readMandateFile(path: string): z.output<typeof mandateFile> {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    throw new EngineError('config_invalid', 'UJIRA_MANDATE_FILE cannot be read as JSON', {
      cause: error,
    });
  }
  return parseMandate(text, 'UJIRA_MANDATE_FILE');
}

/**
 * The mandate facts from a file, or inline for a host where mounting a file
 * is harder than setting a variable. Both at once is refused, since one
 * would silently win.
 */
function mandateFacts(env: Env): z.output<typeof mandateFile> | undefined {
  const file = set(env, 'UJIRA_MANDATE_FILE');
  const inline = set(env, 'UJIRA_MANDATE_JSON');
  if (file !== undefined && inline !== undefined) {
    throw new EngineError(
      'config_invalid',
      'set UJIRA_MANDATE_FILE or UJIRA_MANDATE_JSON, not both',
    );
  }
  if (inline !== undefined) return parseMandate(inline, 'UJIRA_MANDATE_JSON');
  return file === undefined ? undefined : readMandateFile(file);
}

export function loadSettings(env: Env = process.env): Settings {
  const network = set(env, 'UJIRA_NETWORK') ?? 'testnet';
  if (network !== 'testnet') {
    throw new EngineError('config_invalid', 'only testnet is supported (UJIRA_NETWORK=testnet)');
  }

  const fromFile = mandateFacts(env);
  const mandateId = set(env, 'UJIRA_MANDATE_ID') ?? fromFile?.mandate;
  if (mandateId === undefined || !contractAddress.safeParse(mandateId).success) {
    throw new EngineError(
      'config_invalid',
      'set UJIRA_MANDATE_ID to the mandate contract (C...), or UJIRA_MANDATE_FILE or UJIRA_MANDATE_JSON to its facts',
    );
  }

  const agent = signerFromEnv(env, 'UJIRA_AGENT');
  if (agent === undefined) {
    throw new EngineError(
      'config_invalid',
      'set UJIRA_AGENT_SECRET or UJIRA_AGENT_KEY_FILE to the agent key',
    );
  }
  // Without its own key the agent executes, which the mandate allows.
  const executor = signerFromEnv(env, 'UJIRA_EXECUTOR') ?? agent;

  const recipientRefs = new Map<string, Hex32>();
  const namedRecipients: Record<string, string> = {};
  for (const r of fromFile?.recipients ?? []) {
    recipientRefs.set(r.destination, r.recipient_ref);
    if (r.name !== undefined) namedRecipients[r.name] = r.destination;
  }
  const assetIssuer = fromFile?.asset?.issuer;

  return {
    network: 'testnet',
    rpcUrl: set(env, 'UJIRA_RPC_URL') ?? TESTNET_RPC_URL,
    mandateId,
    assetCode: set(env, 'UJIRA_ASSET_CODE') ?? fromFile?.asset?.code ?? 'USDC',
    recipientRefs,
    agent,
    executor,
    receiptsPath:
      set(env, 'UJIRA_RECEIPTS_FILE') ??
      join(set(env, 'UJIRA_DATA_DIR') ?? join(homedir(), '.ujira-mcp'), 'receipts.json'),
    ...(assetIssuer === undefined ? {} : { assetIssuer }),
    namedRecipients,
  };
}

/**
 * Whether the testnet demo runs in this process: the faucet, test
 * recipients, the recycler, the public demo MCP and the SDP rail. Off unless
 * asked for, and never on a network other than testnet, since the demo pays
 * from keys and accounts UJIRA itself holds.
 */
export function demoFeatures(env: Env = process.env): boolean {
  const flag = set(env, 'UJIRA_DEMO_FEATURES') ?? 'off';
  if (flag !== 'on' && flag !== 'off') {
    throw new EngineError('config_invalid', 'UJIRA_DEMO_FEATURES must be on or off');
  }
  if (flag === 'off') return false;
  if (set(env, 'UJIRA_NETWORK') !== 'testnet') {
    throw new EngineError(
      'config_invalid',
      'UJIRA_DEMO_FEATURES=on runs only with UJIRA_NETWORK=testnet',
    );
  }
  return true;
}

export interface Wiring {
  readonly engine: PayoutEngine;
  readonly mandate: MandateContract;
  readonly adapter: StellarChainAdapter;
  /** Shared by every adapter in the process; only composition code builds on it. */
  readonly gateway: SorobanGateway;
  /** One log per process: its writes are serialized in memory, so a second one on the same file would race. */
  readonly receipts: ReceiptLog;
}

/**
 * Builds the engine from settings. The wallet rail is always there; any
 * other rail, such as the demo's, is passed in by whoever builds it.
 */
export function createEngine(
  settings: Settings,
  options: {
    gateway?: SorobanGateway;
    network?: StellarNetworkPort;
    extraRails?: (mandate: MandateContract) => readonly PayoutRail[];
    now?: () => Date;
  } = {},
): Wiring {
  const gateway =
    options.gateway ??
    new RpcGateway({ rpcUrl: settings.rpcUrl, readSource: settings.agent.publicKey });
  const adapter = new StellarChainAdapter({
    gateway,
    chain:
      options.network ??
      new StellarNetwork({
        rpcUrl: settings.rpcUrl,
        horizonUrl: TESTNET_HORIZON_URL,
        friendbotUrl: TESTNET_FRIENDBOT_URL,
      }),
    factory: TESTNET_FACTORY,
    asset: { code: 'USDC', issuer: TESTNET_USDC_ISSUER, contract: TESTNET_USDC_CONTRACT },
  });
  const mandate = adapter.mandate(settings.mandateId);
  const rails: PayoutRail[] = [new WalletRail(mandate, settings.executor)];
  rails.push(...(options.extraRails?.(mandate) ?? []));
  const receipts = new ReceiptLog(settings.receiptsPath);
  const engine = new PayoutEngine({
    mandate,
    agent: settings.agent,
    rails,
    receipts,
    assetCode: settings.assetCode,
    network: settings.network,
    recipientRefs: settings.recipientRefs,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  return { engine, mandate, adapter, gateway, receipts };
}
