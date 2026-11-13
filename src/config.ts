// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// Settings come from the environment, and keys only from the environment or
// files it names. Nothing a tool caller sends can change a key or the
// mandate the engine works for.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { z } from 'zod';

import { PayoutEngine } from './engine/engine.js';
import { EngineError } from './errors.js';
import { accountAddress, contractAddress, hex32, type Hex32 } from './ids.js';
import { MandateClient } from './mandate/client.js';
import type { PayoutRail } from './rails/rail.js';
import { SdpClient, SdpRail } from './rails/sdp.js';
import { UsdcRail } from './rails/usdc.js';
import { ReceiptLog } from './receipts/log.js';
import {
  RpcGateway,
  TESTNET_RPC_URL,
  type SorobanGateway,
  type TxSigner,
} from './stellar/gateway.js';
import { signerFromEnv } from './stellar/keys.js';

export interface Settings {
  readonly network: 'testnet';
  readonly rpcUrl: string;
  readonly mandateId: string;
  readonly assetCode: string;
  readonly recipientRefs: ReadonlyMap<string, Hex32>;
  readonly agent: TxSigner;
  readonly executor: TxSigner;
  readonly receiptsPath: string;
  /** Set when UJIRA_SDP_URL is: the SDP rail is then offered next to USDC. */
  readonly sdp?: SdpSettings;
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

function readMandateFile(path: string): z.output<typeof mandateFile> {
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new EngineError('config_invalid', 'UJIRA_MANDATE_FILE cannot be read as JSON', {
      cause: error,
    });
  }
  const parsed = mandateFile.safeParse(json);
  if (!parsed.success) {
    throw new EngineError('config_invalid', 'UJIRA_MANDATE_FILE is missing the mandate address');
  }
  return parsed.data;
}

export function loadSettings(env: Env = process.env): Settings {
  const network = set(env, 'UJIRA_NETWORK') ?? 'testnet';
  if (network !== 'testnet') {
    throw new EngineError('config_invalid', 'only testnet is supported (UJIRA_NETWORK=testnet)');
  }

  const file = set(env, 'UJIRA_MANDATE_FILE');
  const fromFile = file === undefined ? undefined : readMandateFile(file);
  const mandateId = set(env, 'UJIRA_MANDATE_ID') ?? fromFile?.mandate;
  if (mandateId === undefined || !contractAddress.safeParse(mandateId).success) {
    throw new EngineError(
      'config_invalid',
      'set UJIRA_MANDATE_ID to the mandate contract (C...) or UJIRA_MANDATE_FILE to its file',
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
  for (const r of fromFile?.recipients ?? []) recipientRefs.set(r.destination, r.recipient_ref);
  const sdp = sdpSettings(env, fromFile);

  return {
    network: 'testnet',
    rpcUrl: set(env, 'UJIRA_RPC_URL') ?? TESTNET_RPC_URL,
    mandateId,
    assetCode: set(env, 'UJIRA_ASSET_CODE') ?? fromFile?.asset?.code ?? 'USDC',
    recipientRefs,
    agent,
    executor,
    receiptsPath: set(env, 'UJIRA_RECEIPTS_FILE') ?? join(homedir(), '.ujira-mcp', 'receipts.json'),
    ...(sdp === undefined ? {} : { sdp }),
  };
}

function sdpSettings(
  env: Env,
  fromFile: z.output<typeof mandateFile> | undefined,
): SdpSettings | undefined {
  const url = set(env, 'UJIRA_SDP_URL');
  if (url === undefined) return undefined;
  const apiKey = set(env, 'UJIRA_SDP_API_KEY');
  const distributionAccount = set(env, 'UJIRA_SDP_DISTRIBUTION');
  const assetIssuer = set(env, 'UJIRA_SDP_ASSET_ISSUER') ?? fromFile?.asset?.issuer;
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
  const recipients: Record<string, string> = {};
  for (const r of fromFile?.recipients ?? []) {
    if (r.name !== undefined) recipients[r.name] = r.destination;
  }
  const tenant = set(env, 'UJIRA_SDP_TENANT');
  return {
    url,
    apiKey,
    distributionAccount,
    assetIssuer,
    recipients,
    ...(tenant === undefined ? {} : { tenant }),
  };
}

function sdpRail(settings: Settings, sdp: SdpSettings, mandate: MandateClient): SdpRail {
  return new SdpRail({
    client: new SdpClient({
      baseUrl: sdp.url,
      auth: { kind: 'api_key', apiKey: sdp.apiKey },
      ...(sdp.tenant === undefined ? {} : { tenant: sdp.tenant }),
    }),
    distributionAccount: sdp.distributionAccount,
    asset: { code: settings.assetCode, issuer: sdp.assetIssuer },
    recipients: sdp.recipients,
    payToDistribution: (p) => mandate.execute(settings.executor, p.payoutId),
  });
}

export interface Wiring {
  readonly engine: PayoutEngine;
  readonly mandate: MandateClient;
  readonly gateway: SorobanGateway;
}

/**
 * Builds the engine from settings. USDC is always there, SDP when the
 * settings name one, and any other rail is passed in by whoever builds it.
 */
export function createEngine(
  settings: Settings,
  options: {
    gateway?: SorobanGateway;
    extraRails?: (mandate: MandateClient) => readonly PayoutRail[];
    now?: () => Date;
  } = {},
): Wiring {
  const gateway =
    options.gateway ??
    new RpcGateway({ rpcUrl: settings.rpcUrl, readSource: settings.agent.publicKey });
  const mandate = new MandateClient(gateway, settings.mandateId);
  const rails: PayoutRail[] = [new UsdcRail(mandate, settings.executor)];
  if (settings.sdp !== undefined) rails.push(sdpRail(settings, settings.sdp, mandate));
  rails.push(...(options.extraRails?.(mandate) ?? []));
  const engine = new PayoutEngine({
    mandate,
    agent: settings.agent,
    rails,
    receipts: new ReceiptLog(settings.receiptsPath),
    assetCode: settings.assetCode,
    network: settings.network,
    recipientRefs: settings.recipientRefs,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  return { engine, mandate, gateway };
}
