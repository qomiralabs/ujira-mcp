// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The network outside contract calls: account balances from Horizon,
// friendbot, and preparing and sending whole transactions through RPC.
// Every call has a timeout, and no answer body is passed on as it came.
// Failures are ChainError, with the console's older codes as the reason.

import {
  rpc,
  type Account,
  type FeeBumpTransaction,
  type Transaction,
  type xdr,
} from '@stellar/stellar-sdk';
import { z } from 'zod';

import { contractCodeIn, mandateErrorName } from '../../errors.js';
import { ChainError, type ChainErrorCode } from '../adapter.js';
import { contractCodeInEvents, withTimeout } from './gateway.js';
import { MAX_OPERATIONS, recordFromHorizon, type TransactionRecord } from './history.js';

export type { Account, FeeBumpTransaction, Transaction, xdr } from '@stellar/stellar-sdk';

export const TESTNET_HORIZON_URL = 'https://horizon-testnet.stellar.org';
export const TESTNET_FRIENDBOT_URL = 'https://friendbot.stellar.org';

export interface AccountView {
  readonly exists: boolean;
  /** Display only, as Horizon writes it. */
  readonly xlm: string | null;
  /** Minor units; null when the account has no USDC trustline. */
  readonly usdc: bigint | null;
}

/** What a payer needs to know before sending to an account. */
export interface AccountFacts {
  readonly exists: boolean;
  /** Issued assets the account holds a trustline for, as CODE:ISSUER. */
  readonly trustlines: readonly string[];
  /** The account asks senders for a memo (SEP-29), as exchanges do. */
  readonly memoRequired: boolean;
}

export interface Submitted {
  readonly hash: string;
  readonly status: 'SUCCESS' | 'FAILED';
  readonly returnValue?: xdr.ScVal;
  /** For a failed contract call, the contract's reason, such as mandate_paused. */
  readonly reason?: string;
  /** Stroops the fee source paid, as the result says; for a fee bump, the sponsor. */
  readonly feeCharged?: bigint;
}

export interface LedgerEntriesRead {
  readonly latestLedger: number;
  readonly entries: readonly {
    readonly key: xdr.LedgerKey;
    readonly val: xdr.LedgerEntryData;
    /** Testnet RPC answers 0 for an archived entry; a missing value reads the same. */
    readonly liveUntilLedgerSeq: number;
  }[];
}

/** The network as the adapter and the console use it; tests answer it from memory. */
export interface StellarNetworkPort {
  account(address: string, usdc: { code: string; issuer: string }): Promise<AccountView>;
  accountFacts(address: string): Promise<AccountFacts>;
  /** The account with its current sequence, ready to build on. */
  loadAccount(address: string): Promise<Account>;
  /** Simulates and assembles, so the result is ready to sign. */
  prepare(tx: Transaction): Promise<Transaction>;
  /** Sends a signed transaction, or a fee bump around one, and waits until it is final. */
  submit(tx: Transaction | FeeBumpTransaction): Promise<Submitted>;
  /** Funds a new account with test XLM; succeeds when it is already funded. */
  friendbot(address: string): Promise<void>;
  latestLedger(): Promise<number>;
  /**
   * A transaction from the full history, or null when the network never had
   * it. Optional, so a port that only sends need not keep history; receipts
   * cannot be checked without it.
   */
  transactionRecord?(hash: string): Promise<TransactionRecord | null>;
}

const fail = (code: ChainErrorCode, reason: string, message: string, cause?: unknown) =>
  new ChainError(code, message, { reason, ...(cause === undefined ? {} : { cause }) });

/** A Horizon decimal amount as minor units, with integer math only. */
export function decimalToMinor(value: string, decimals = 7): bigint {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(value);
  if (match === null) {
    throw fail('UNAVAILABLE', 'horizon_unavailable', 'Horizon sent an amount that is not a number');
  }
  const frac = (match[2] ?? '').padEnd(decimals, '0');
  if (frac.length > decimals) {
    throw fail(
      'UNAVAILABLE',
      'horizon_unavailable',
      'Horizon sent more decimals than the asset has',
    );
  }
  return BigInt(match[1] ?? '0') * 10n ** BigInt(decimals) + BigInt(frac === '' ? '0' : frac);
}

/**
 * An account's XLM in stroops, or null when the account does not exist.
 * `usdc` is only there because the account read names the asset it looks for.
 */
export async function xlmStroops(
  network: Pick<StellarNetworkPort, 'account'>,
  address: string,
  usdc: { code: string; issuer: string },
): Promise<bigint | null> {
  const view = await network.account(address, usdc);
  return !view.exists || view.xlm === null ? null : decimalToMinor(view.xlm);
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
  data: z.record(z.string(), z.string()).optional(),
});

type HorizonAccount = z.output<typeof horizonAccount>;

/** SEP-29: the data entry an account sets to say incoming payments need a memo. */
const MEMO_REQUIRED_KEY = 'config.memo_required';
/** "1", base64 encoded, as Horizon returns data values. */
const MEMO_REQUIRED_VALUE = 'MQ==';

export interface StellarNetworkOptions {
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

function unavailable(what: string, cause: unknown): ChainError {
  if (cause instanceof ChainError) return cause;
  return fail(
    'UNAVAILABLE',
    'network_unavailable',
    `The Stellar network did not answer to ${what}`,
    cause,
  );
}

export class StellarNetwork implements StellarNetworkPort {
  private readonly server: rpc.Server;
  private readonly o: StellarNetworkOptions;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;

  constructor(options: StellarNetworkOptions) {
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

  /** The account as Horizon has it, or null when it does not exist. */
  private async horizon(address: string): Promise<HorizonAccount | null> {
    const res = await this.get(`${this.o.horizonUrl}/accounts/${address}`, 'read the account');
    if (res.status === 404) return null;
    if (!res.ok) {
      throw fail('UNAVAILABLE', 'horizon_unavailable', `Horizon answered HTTP ${res.status}`);
    }
    const parsed = horizonAccount.safeParse(await res.json().catch(() => undefined));
    if (!parsed.success) {
      throw fail('UNAVAILABLE', 'horizon_unavailable', 'Horizon answered in an unexpected shape');
    }
    return parsed.data;
  }

  async account(address: string, usdc: { code: string; issuer: string }): Promise<AccountView> {
    const found = await this.horizon(address);
    if (found === null) return { exists: false, xlm: null, usdc: null };
    const native = found.balances.find((b) => b.asset_type === 'native');
    const line = found.balances.find(
      (b) => b.asset_code === usdc.code && b.asset_issuer === usdc.issuer,
    );
    return {
      exists: true,
      xlm: native?.balance ?? null,
      usdc: line === undefined ? null : decimalToMinor(line.balance),
    };
  }

  async accountFacts(address: string): Promise<AccountFacts> {
    const found = await this.horizon(address);
    if (found === null) return { exists: false, trustlines: [], memoRequired: false };
    const trustlines = found.balances.flatMap((b) =>
      b.asset_code === undefined || b.asset_issuer === undefined
        ? []
        : [`${b.asset_code}:${b.asset_issuer}`],
    );
    return {
      exists: true,
      trustlines,
      memoRequired: found.data?.[MEMO_REQUIRED_KEY] === MEMO_REQUIRED_VALUE,
    };
  }

  async loadAccount(address: string): Promise<Account> {
    try {
      return await withTimeout(this.server.getAccount(address), this.timeoutMs, 'load the account');
    } catch (error) {
      if (error instanceof Error && /not found/i.test(error.message)) {
        throw fail(
          'INVALID_ADDRESS',
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
        throw new ChainError(
          'CONTRACT_REFUSED',
          `The contract would refuse this: ${reason} (#${code})`,
          { reason, specError: reason.toUpperCase() },
        );
      }
      const first = (sim.error.split('\n')[0] ?? '').slice(0, 200);
      throw fail('TX_FAILED', 'simulation_failed', `The network would refuse this: ${first}`);
    }
    if (rpc.Api.isSimulationRestore(sim)) {
      throw fail(
        'UNAVAILABLE',
        'restore_needed',
        'Contract state must be restored first; try again later',
      );
    }
    return rpc.assembleTransaction(tx, sim).build();
  }

  async submit(tx: Transaction | FeeBumpTransaction): Promise<Submitted> {
    const hash = Buffer.from(tx.hash()).toString('hex');
    for (let attempt = 1; ; attempt++) {
      let sent: rpc.Api.SendTransactionResponse;
      try {
        sent = await withTimeout(this.server.sendTransaction(tx), this.timeoutMs, 'send');
      } catch (error) {
        throw new ChainError(
          'TIMEOUT',
          `The transaction may or may not have reached the network; look up ${hash} before sending it again`,
          { reason: 'submission_unknown', txHash: hash, cause: error },
        );
      }
      if (sent.status === 'PENDING' || sent.status === 'DUPLICATE') break;
      if (sent.status === 'TRY_AGAIN_LATER' && attempt < 4) {
        await sleep((this.o.pollIntervalMs ?? 1_500) * attempt);
        continue;
      }
      const result = sent.errorResult?.result.type ?? sent.status;
      throw fail(
        'TX_FAILED',
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
          feeCharged: got.resultXdr.feeCharged,
          ...(got.returnValue === undefined ? {} : { returnValue: got.returnValue }),
        };
      }
      if (got.status === rpc.Api.GetTransactionStatus.FAILED) {
        const code = contractCodeInEvents(got.diagnosticEventsXdr ?? []);
        return {
          hash,
          status: 'FAILED',
          feeCharged: got.resultXdr.feeCharged,
          ...(code === undefined ? {} : { reason: mandateErrorName(code) }),
        };
      }
      await sleep(this.o.pollIntervalMs ?? 1_500);
    }
    throw new ChainError('TIMEOUT', `The transaction ${hash} was not final in time`, {
      reason: 'submission_unknown',
      txHash: hash,
    });
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
    throw fail(
      'UNAVAILABLE',
      'friendbot_failed',
      `Friendbot could not fund the account (HTTP ${res.status})`,
    );
  }

  /** Entries by key, archived ones included; a key the network never held is left out. */
  async ledgerEntries(keys: readonly xdr.LedgerKey[]): Promise<LedgerEntriesRead> {
    try {
      const got = await withTimeout(
        this.server.getLedgerEntries(...keys),
        this.timeoutMs,
        'read ledger entries',
      );
      return {
        latestLedger: got.latestLedger,
        entries: got.entries.map((e) => ({
          key: e.key,
          val: e.val,
          liveUntilLedgerSeq: e.liveUntilLedgerSeq ?? 0,
        })),
      };
    } catch (error) {
      throw unavailable('read ledger entries', error);
    }
  }

  async transactionRecord(hash: string): Promise<TransactionRecord | null> {
    if (!/^[0-9a-f]{64}$/.test(hash)) throw new RangeError('hash must be 64 lower case hex digits');
    const base = `${this.o.horizonUrl}/transactions/${hash}`;
    const tx = await this.get(base, 'read the transaction');
    if (tx.status === 404) return null;
    if (!tx.ok)
      throw fail('UNAVAILABLE', 'horizon_unavailable', `Horizon answered HTTP ${tx.status}`);
    const txBody: unknown = await tx.json().catch(() => undefined);
    const ops = await this.get(
      `${base}/operations?limit=${String(MAX_OPERATIONS)}`,
      'read the operations',
    );
    if (!ops.ok) {
      throw fail('UNAVAILABLE', 'horizon_unavailable', `Horizon answered HTTP ${ops.status}`);
    }
    const opsBody: unknown = await ops.json().catch(() => undefined);
    return recordFromHorizon(txBody, opsBody);
  }

  async latestLedger(): Promise<number> {
    try {
      // getHealth, not getLatestLedger: the latter decodes the ledger header,
      // and this SDK cannot read the header testnet writes today.
      const got = await withTimeout(this.server.getHealth(), this.timeoutMs, 'latest ledger');
      return got.latestLedger;
    } catch (error) {
      throw unavailable('read the latest ledger', error);
    }
  }
}
