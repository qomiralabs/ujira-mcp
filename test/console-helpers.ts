// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// A console wired to memory: the mandate is FakeMandateRpc, the network is
// FakeChain, and the registry lives in a temporary directory. The demo's
// part of it is on unless a test turns it off, as on ujira.co.

import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  Account,
  Address,
  Keypair,
  TransactionBuilder,
  type Transaction,
  type xdr,
} from '@stellar/stellar-sdk';

import { StellarChainAdapter } from '../src/chain/stellar/adapter.js';
import { TESTNET_PASSPHRASE, type TxSigner } from '../src/chain/stellar/gateway.js';
import { signerFrom } from '../src/chain/stellar/keys.js';
import type { AccountFacts, StellarNetworkPort } from '../src/chain/stellar/network.js';
import { createConsole } from '../src/console/app.js';
import type { AccountView, ConsoleChain, Submitted } from '../src/console/chain.js';
import { ApiError } from '../src/console/errors.js';
import { ConsoleRegistry } from '../src/console/registry.js';
import {
  TESTNET_FACTORY,
  TESTNET_USDC_CONTRACT,
  TESTNET_USDC_ISSUER,
  type ConsoleLimits,
  type ConsoleSettings,
} from '../src/console/settings.js';
import { demoConsole, type DemoSdp } from '../src/demo/console.js';
import { publicMcp } from '../src/demo/public-mcp.js';
import type { DemoLimits, DemoSettings } from '../src/demo/settings.js';
import { TestWalletStore } from '../src/demo/wallets.js';
import { createHttpServer } from '../src/mcp/http.js';
import { DEFAULT_MAX_AMOUNT, type HttpSettings } from '../src/mcp/public.js';
import { FakeMandateRpc, MANDATE, UNIT, agent, executor } from './fake-rpc.js';
import { setup } from './helpers.js';

export function keypair(seed: string): Keypair {
  return Keypair.fromRawEd25519Seed(createHash('sha256').update(seed).digest());
}

export const owner = keypair('owner');
export const treasuryKey = keypair('treasury');
export const treasury: TxSigner = signerFrom(treasuryKey);

export class FakeChain implements ConsoleChain, StellarNetworkPort {
  accounts = new Map<string, AccountView>();
  prepared: Transaction[] = [];
  submitted: Transaction[] = [];
  funded: string[] = [];
  /** What the next submits answer, in order; then SUCCESS with no value. */
  answers: Partial<Submitted>[] = [];
  /** Runs after a submit lands, as the chain's own effect would. */
  onSubmit: ((tx: Transaction) => void) | undefined;

  account(address: string): Promise<AccountView> {
    return Promise.resolve(this.accounts.get(address) ?? { exists: false, xlm: null, usdc: null });
  }

  loadAccount(address: string): Promise<Account> {
    if (this.accounts.get(address)?.exists !== true) {
      return Promise.reject(new ApiError(400, 'account_not_found', 'no account'));
    }
    return Promise.resolve(new Account(address, '100'));
  }

  prepare(tx: Transaction): Promise<Transaction> {
    this.prepared.push(tx);
    return Promise.resolve(tx);
  }

  submit(tx: Transaction): Promise<Submitted> {
    this.submitted.push(tx);
    const answer = this.answers.shift() ?? {};
    this.onSubmit?.(tx);
    return Promise.resolve({
      hash: Buffer.from(tx.hash()).toString('hex'),
      status: 'SUCCESS',
      ...answer,
    });
  }

  friendbot(address: string): Promise<void> {
    this.funded.push(address);
    if (!this.accounts.has(address)) {
      this.accounts.set(address, { exists: true, xlm: '10000.0000000', usdc: null });
    }
    return Promise.resolve();
  }

  accountFacts(address: string): Promise<AccountFacts> {
    const view = this.accounts.get(address);
    return Promise.resolve({
      exists: view?.exists === true,
      trustlines: view === undefined || view.usdc === null ? [] : [`USDC:${TESTNET_USDC_ISSUER}`],
      memoRequired: false,
    });
  }

  latestLedger(): Promise<number> {
    return Promise.resolve(1);
  }
}

export function consoleSettings(
  over: Partial<ConsoleSettings> = {},
  limits: Partial<ConsoleLimits> = {},
) {
  const dataDir = mkdtempSync(join(tmpdir(), 'ujira-console-'));
  const consoleDir = join(dataDir, 'ui');
  mkdirSync(join(consoleDir, 'assets'), { recursive: true });
  writeFileSync(join(consoleDir, 'index.html'), '<!doctype html><title>UJIRA Console</title>');
  writeFileSync(join(consoleDir, 'assets', 'app.js'), 'console.log(1)');
  writeFileSync(join(consoleDir, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  writeFileSync(join(dataDir, 'secret.txt'), 'outside the console');
  const siteDir = join(dataDir, 'site');
  mkdirSync(join(siteDir, 'assets'), { recursive: true });
  mkdirSync(join(siteDir, 'data'), { recursive: true });
  writeFileSync(join(siteDir, 'index.html'), '<!doctype html><title>UJIRA website</title>');
  writeFileSync(join(siteDir, 'instaward.html'), '<!doctype html><title>UJIRA proof</title>');
  writeFileSync(join(siteDir, '404.html'), '<!doctype html><title>Page not found</title>');
  writeFileSync(join(siteDir, '.env'), 'hidden');
  writeFileSync(join(siteDir, 'assets', 'sky.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
  writeFileSync(join(siteDir, 'data', 'page.json'), '{"mcp_url":"https://ujira.co/mcp"}');
  const settings: ConsoleSettings = {
    dataDir,
    consoleDir,
    siteDir,
    horizonUrl: 'https://horizon-testnet.stellar.org',
    friendbotUrl: 'https://friendbot.stellar.org',
    publicRpcUrl: 'https://soroban-testnet.stellar.org',
    factory: TESTNET_FACTORY,
    usdc: { code: 'USDC', issuer: TESTNET_USDC_ISSUER, contract: TESTNET_USDC_CONTRACT },
    ...over,
    limits: {
      apiCallsPerMinute: 1_000,
      mandatePayoutsPerHour: 20,
      ...limits,
    },
  };
  return settings;
}

export function demoSettings(
  over: Partial<DemoSettings> = {},
  limits: Partial<DemoLimits> = {},
): DemoSettings {
  return {
    treasury,
    faucetAmount: 50n * UNIT,
    faucetCooldownSeconds: 600,
    recycleIntervalSeconds: 300,
    faucetFloor: 100n * UNIT,
    sdpProofUrl: 'https://qomiralabs.github.io/ujira-demo/instaward.html',
    ...over,
    limits: { faucetPerHour: 2, testRecipientsPerHour: 2, friendbotPerHour: 2, ...limits },
  };
}

export function httpSettings(): HttpSettings {
  return {
    port: 0,
    host: '127.0.0.1',
    maxBodyBytes: 16 * 1024,
    requestTimeoutMs: 10_000,
    allowedOrigins: ['https://claude.ai', 'https://claude.com'],
    clientIp: { trustProxy: true },
    limits: { maxAmount: DEFAULT_MAX_AMOUNT, payoutsPerHour: 5, toolCallsPerMinute: 120 },
  };
}

export interface World {
  base: string;
  server: Server;
  rpc: FakeMandateRpc;
  chain: FakeChain;
  registry: ConsoleRegistry;
  settings: ConsoleSettings;
  lines: string[];
  wallets: TestWalletStore | undefined;
}

export async function startConsole(
  options: {
    settings?: ConsoleSettings;
    /** The demo's settings, or false for a server with UJIRA_DEMO_FEATURES off. */
    demo?: DemoSettings | false;
    sdp?: DemoSdp;
    register?: boolean;
    keypairs?: Keypair[];
    /** false runs without a test wallet store, as a server without a treasury does. */
    wallets?: boolean;
  } = {},
): Promise<World> {
  const world = setup();
  const settings = options.settings ?? consoleSettings();
  const demo = options.demo === false ? undefined : (options.demo ?? demoSettings());
  const registry = ConsoleRegistry.open(join(settings.dataDir, 'console-registry.json'));
  const wallets =
    options.wallets === false || demo === undefined
      ? undefined
      : TestWalletStore.open(join(settings.dataDir, 'test-wallets.json'));
  if (options.register !== false) {
    await registry.addMandate({
      id: MANDATE,
      principal: owner.publicKey(),
      createdAt: '2026-11-13T10:00:00.000Z',
      createTx: 'a'.repeat(64),
    });
  }
  const chain = new FakeChain();
  chain.accounts.set(owner.publicKey(), { exists: true, xlm: '10000.0000000', usdc: 1000n * UNIT });
  chain.accounts.set(treasury.publicKey, { exists: true, xlm: '10000.0000000', usdc: 900n * UNIT });
  const lines: string[] = [];
  const keys = [...(options.keypairs ?? [])];
  const http = httpSettings();
  const now = () => Number(world.rpc.now) * 1000;
  const log = (line: string) => lines.push(line);
  const extension =
    demo === undefined
      ? undefined
      : demoConsole({
          demo,
          console: settings,
          http,
          chain,
          ledger: registry,
          executor,
          ...(options.sdp === undefined ? {} : { sdp: options.sdp }),
          ...(wallets === undefined ? {} : { wallets }),
          now,
          log,
          newKeypair: () => keys.shift() ?? Keypair.random(),
        });
  const routes = createConsole({
    settings,
    http,
    agent,
    executor,
    adapter: new StellarChainAdapter({
      gateway: world.rpc,
      chain,
      factory: settings.factory,
      asset: settings.usdc,
    }),
    receipts: world.receipts,
    registry,
    chain,
    ...(extension === undefined ? {} : { extension }),
    now,
    log,
  });
  const server = createHttpServer({
    settings: http,
    log,
    extra: routes,
    ...(demo === undefined
      ? {}
      : {
          publicMcp: publicMcp({ engine: world.engine, http, assetCode: 'USDC', recipients: [] }),
        }),
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    server,
    rpc: world.rpc,
    chain,
    registry,
    settings,
    lines,
    wallets,
  };
}

export function stop(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.closeAllConnections();
    server.close(() => {
      resolve();
    });
  });
}

export async function api(
  base: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${base}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

/** Signs a server-built XDR as a wallet would. */
export function sign(envelope: string, key: Keypair): string {
  const tx = TransactionBuilder.fromXdr(envelope, TESTNET_PASSPHRASE) as Transaction;
  tx.sign(key);
  return tx.toXdr();
}

export function errorCode(json: Record<string, unknown>): unknown {
  return (json['error'] as { code?: unknown } | undefined)?.code;
}

export const mandateAddress = (id: string): xdr.ScVal => Address.fromString(id).toScVal();
