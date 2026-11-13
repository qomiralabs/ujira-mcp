// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// A console wired to memory: the mandate is FakeMandateRpc, the network is
// FakeChain, and the registry lives in a temporary directory.

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

import { createConsole } from '../src/console/app.js';
import type { AccountView, ConsoleChain, Submitted } from '../src/console/chain.js';
import { ApiError } from '../src/console/errors.js';
import type { ConsoleSdp } from '../src/console/mandates.js';
import { ConsoleRegistry } from '../src/console/registry.js';
import {
  TESTNET_FACTORY,
  TESTNET_USDC_CONTRACT,
  TESTNET_USDC_ISSUER,
  type ConsoleLimits,
  type ConsoleSettings,
} from '../src/console/settings.js';
import { createHttpServer } from '../src/mcp/http.js';
import { DEFAULT_MAX_AMOUNT, type HttpSettings } from '../src/mcp/public.js';
import { TESTNET_PASSPHRASE, type TxSigner } from '../src/stellar/gateway.js';
import { signerFrom } from '../src/stellar/keys.js';
import { FakeMandateRpc, MANDATE, UNIT, agent, executor } from './fake-rpc.js';
import { setup } from './helpers.js';

export function keypair(seed: string): Keypair {
  return Keypair.fromRawEd25519Seed(createHash('sha256').update(seed).digest());
}

export const owner = keypair('owner');
export const treasuryKey = keypair('treasury');
export const treasury: TxSigner = signerFrom(treasuryKey);

export class FakeChain implements ConsoleChain {
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
  writeFileSync(join(dataDir, 'secret.txt'), 'outside the console');
  const settings: ConsoleSettings = {
    dataDir,
    consoleDir,
    horizonUrl: 'https://horizon-testnet.stellar.org',
    friendbotUrl: 'https://friendbot.stellar.org',
    publicRpcUrl: 'https://soroban-testnet.stellar.org',
    factory: TESTNET_FACTORY,
    usdc: { code: 'USDC', issuer: TESTNET_USDC_ISSUER, contract: TESTNET_USDC_CONTRACT },
    treasury,
    faucetAmount: 50n * UNIT,
    faucetFloor: 100n * UNIT,
    sdpProofUrl: 'https://qomiralabs.github.io/ujira-demo/instaward.html',
    ...over,
    limits: {
      faucetPerHour: 2,
      testRecipientsPerHour: 2,
      friendbotPerHour: 2,
      apiCallsPerMinute: 1_000,
      mandatePayoutsPerHour: 20,
      ...limits,
    },
  };
  return settings;
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
}

export async function startConsole(
  options: {
    settings?: ConsoleSettings;
    sdp?: ConsoleSdp;
    register?: boolean;
    keypairs?: Keypair[];
  } = {},
): Promise<World> {
  const world = setup();
  const settings = options.settings ?? consoleSettings();
  const registry = ConsoleRegistry.open(join(settings.dataDir, 'console-registry.json'));
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
  const routes = createConsole({
    settings,
    http,
    agent,
    executor,
    gateway: world.rpc,
    receipts: world.receipts,
    registry,
    chain,
    ...(options.sdp === undefined ? {} : { sdp: options.sdp }),
    now: () => Number(world.rpc.now) * 1000,
    log: (line) => lines.push(line),
    newKeypair: () => keys.shift() ?? Keypair.random(),
  });
  const server = createHttpServer({
    engine: world.engine,
    settings: http,
    assetCode: 'USDC',
    log: (line) => lines.push(line),
    extra: routes,
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
