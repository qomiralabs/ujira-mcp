// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The console's view of the network: account balances from Horizon,
// friendbot, and building, simulating and sending transactions through RPC.
// Routes only see this port, so tests answer it from memory. Every call has
// a timeout, and no answer body is passed on as it came.

import { rpc, type Account, type Transaction, type xdr } from '@stellar/stellar-sdk';
import { z } from 'zod';

import { contractCodeIn, mandateErrorName } from '../errors.js';
import { contractCodeInEvents, withTimeout } from '../stellar/gateway.js';
import { ApiError } from './errors.js';

export interface AccountView {
  readonly exists: boolean;
  /** Display only, as Horizon writes it. */
  readonly xlm: string | null;
  /** Minor units; null when the account has no USDC trustline. */
  readonly usdc: bigint | null;
}

export interface Submitted {
  readonly hash: string;
  readonly status: 'SUCCESS' | 'FAILED';
  readonly returnValue?: xdr.ScVal;
  /** For a failed contract call, the contract's reason, such as mandate_paused. */
  readonly reason?: string;
}

export interface ConsoleChain {
  account(address: string, usdc: { code: string; issuer: string }): Promise<AccountView>;
  /** The account with its current sequence, ready to build on. */
  loadAccount(address: string): Promise<Account>;
  /** Simulates and assembles, so the result is ready to sign. */
  prepare(tx: Transaction): Promise<Transaction>;
  /** Sends a signed transaction and waits until it is final. */
  submit(tx: Transaction): Promise<Submitted>;
  /** Funds a new account with test XLM; succeeds when it is already funded. */
  friendbot(address: string): Promise<void>;
}

/** A Horizon decimal amount as minor units, with integer math only. */
export function decimalToMinor(value: string, decimals = 7): bigint {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(value);
  if (match === null)
    throw new ApiError(502, 'horizon_unavailable', 'Horizon sent an amount that is not a number');
  const frac = (match[2] ?? '').padEnd(decimals, '0');
  if (frac.length > decimals) {
    throw new ApiError(502, 'horizon_unavailable', 'Horizon sent more decimals than the asset has');
  }
  return BigInt(match[1] ?? '0') * 10n ** BigInt(decimals) + BigInt(frac === '' ? '0' : frac);
}

const horizonAccount = z.object({
  balances: z.array(
    z.object({
      asset_type: z.string(),
      balance: z.string(),
      asset_code: z.string().optional(),
      asset_issuer: z.string().optional(),
    }),
  ),
});

export interface StellarChainOptions {
  readonly rpcUrl: string;
  readonly horizonUrl: string;
  readonly friendbotUrl: string;
  readonly timeoutMs?: number;
  readonly confirmTimeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly fetch?: typeof fetch;
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

function unavailable(what: string, cause: unknown): ApiError {
  if (cause instanceof ApiError) return cause;
  return new ApiError(502, 'network_unavailable', `The Stellar network did not answer to ${what}`, {
    cause,
  });
}

export class StellarConsoleChain implements ConsoleChain {
  private readonly server: rpc.Server;
  private readonly o: StellarChainOptions;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;

  constructor(options: StellarChainOptions) {
    this.o = options;
    this.server = new rpc.Server(options.rpcUrl, {
      allowHttp: options.rpcUrl.startsWith('http://localhost'),
    });
    this.timeoutMs = options.timeoutMs ?? 20_000;
    this.fetchFn = options.fetch ?? fetch;
  }

  private async get(url: string, what: string, timeoutMs = this.timeoutMs): Promise<Response> {
    try {
      return await this.fetchFn(url, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw unavailable(what, error);
    }
  }

  async account(address: string, usdc: { code: string; issuer: string }): Promise<AccountView> {
    const res = await this.get(`${this.o.horizonUrl}/accounts/${address}`, 'read the account');
    if (res.status === 404) return { exists: false, xlm: null, usdc: null };
    if (!res.ok) {
      throw new ApiError(502, 'horizon_unavailable', `Horizon answered HTTP ${res.status}`);
    }
    const parsed = horizonAccount.safeParse(await res.json().catch(() => undefined));
    if (!parsed.success) {
      throw new ApiError(502, 'horizon_unavailable', 'Horizon answered in an unexpected shape');
    }
    const native = parsed.data.balances.find((b) => b.asset_type === 'native');
    const line = parsed.data.balances.find(
      (b) => b.asset_code === usdc.code && b.asset_issuer === usdc.issuer,
    );
    return {
      exists: true,
      xlm: native?.balance ?? null,
      usdc: line === undefined ? null : decimalToMinor(line.balance),
    };
  }

  async loadAccount(address: string): Promise<Account> {
    try {
      return await withTimeout(this.server.getAccount(address), this.timeoutMs, 'load the account');
    } catch (error) {
      if (error instanceof Error && /not found/i.test(error.message)) {
        throw new ApiError(
          400,
          'account_not_found',
          'That account does not exist on testnet yet; get test XLM first',
        );
      }
      throw unavailable('load the account', error);
    }
  }

  async prepare(tx: Transaction): Promise<Transaction> {
    let sim: rpc.Api.SimulateTransactionResponse;
    try {
      sim = await withTimeout(this.server.simulateTransaction(tx), this.timeoutMs, 'simulate');
    } catch (error) {
      throw unavailable('simulate the transaction', error);
    }
    if (rpc.Api.isSimulationError(sim)) {
      const code = contractCodeIn(sim.error);
      if (code !== undefined) {
        const reason = mandateErrorName(code);
        throw new ApiError(400, reason, `The contract would refuse this: ${reason} (#${code})`);
      }
      const first = (sim.error.split('\n')[0] ?? '').slice(0, 200);
      throw new ApiError(400, 'simulation_failed', `The network would refuse this: ${first}`);
    }
    if (rpc.Api.isSimulationRestore(sim)) {
      throw new ApiError(
        409,
        'restore_needed',
        'Contract state must be restored first; try again later',
      );
    }
    return rpc.assembleTransaction(tx, sim).build();
  }

  async submit(tx: Transaction): Promise<Submitted> {
    const hash = Buffer.from(tx.hash()).toString('hex');
    for (let attempt = 1; ; attempt++) {
      let sent: rpc.Api.SendTransactionResponse;
      try {
        sent = await withTimeout(this.server.sendTransaction(tx), this.timeoutMs, 'send');
      } catch (error) {
        throw new ApiError(
          504,
          'submission_unknown',
          `The transaction may or may not have reached the network; look up ${hash} before sending it again`,
          { cause: error },
        );
      }
      if (sent.status === 'PENDING' || sent.status === 'DUPLICATE') break;
      if (sent.status === 'TRY_AGAIN_LATER' && attempt < 4) {
        await sleep((this.o.pollIntervalMs ?? 1_500) * attempt);
        continue;
      }
      const result = sent.errorResult?.result.type ?? sent.status;
      throw new ApiError(
        400,
        'tx_rejected',
        `The network did not accept the transaction (${result})`,
      );
    }
    return this.confirm(hash);
  }

  private async confirm(hash: string): Promise<Submitted> {
    const deadline = Date.now() + (this.o.confirmTimeoutMs ?? 90_000);
    while (Date.now() < deadline) {
      let got: rpc.Api.GetTransactionResponse;
      try {
        got = await withTimeout(this.server.getTransaction(hash), this.timeoutMs, 'look up');
      } catch {
        await sleep(this.o.pollIntervalMs ?? 1_500);
        continue;
      }
      if (got.status === rpc.Api.GetTransactionStatus.SUCCESS) {
        return {
          hash,
          status: 'SUCCESS',
          ...(got.returnValue === undefined ? {} : { returnValue: got.returnValue }),
        };
      }
      if (got.status === rpc.Api.GetTransactionStatus.FAILED) {
        const code = contractCodeInEvents(got.diagnosticEventsXdr ?? []);
        return {
          hash,
          status: 'FAILED',
          ...(code === undefined ? {} : { reason: mandateErrorName(code) }),
        };
      }
      await sleep(this.o.pollIntervalMs ?? 1_500);
    }
    throw new ApiError(504, 'submission_unknown', `The transaction ${hash} was not final in time`);
  }

  async friendbot(address: string): Promise<void> {
    const res = await this.get(
      `${this.o.friendbotUrl}/?addr=${encodeURIComponent(address)}`,
      'reach friendbot',
      60_000,
    );
    if (res.ok) return;
    // Friendbot refuses an account it already funded, which is the state we wanted.
    const existing = await this.account(address, { code: 'XLM', issuer: '' });
    if (existing.exists) return;
    throw new ApiError(
      502,
      'friendbot_failed',
      `Friendbot could not fund the account (HTTP ${res.status})`,
    );
  }
}
