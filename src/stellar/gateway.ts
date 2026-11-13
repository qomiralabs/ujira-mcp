// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The only module that talks to Stellar RPC. Everything above it works with
// the SorobanGateway port, so tests answer it from memory and nothing else in
// the package needs to know how a transaction is built, simulated or sent.

import {
  Account,
  BASE_FEE,
  Contract,
  Networks,
  TransactionBuilder,
  rpc,
  type Transaction,
  type xdr,
} from '@stellar/stellar-sdk';

import { ContractRefusedError, EngineError, contractCodeIn } from '../errors.js';

export const TESTNET_RPC_URL = 'https://soroban-testnet.stellar.org';
export const TESTNET_PASSPHRASE = Networks.TESTNET;

/** Holds a key and signs with it; the key itself never leaves. */
export interface TxSigner {
  readonly publicKey: string;
  sign(tx: Transaction): void;
}

export interface InvokeResult {
  readonly txHash: string;
  readonly ledger: number;
  readonly returnValue: xdr.ScVal | undefined;
}

export type SimulateResult =
  | { readonly ok: true; readonly returnValue: xdr.ScVal }
  | { readonly ok: false; readonly error: ContractRefusedError };

export type TxLookup =
  | { readonly status: 'SUCCESS' | 'FAILED'; readonly ledger: number }
  | { readonly status: 'NOT_FOUND' };

export interface SorobanGateway {
  /** A read only call: simulated, never sent. Throws ContractRefusedError on a contract error. */
  read(contractId: string, method: string, args: readonly xdr.ScVal[]): Promise<xdr.ScVal>;
  /**
   * Simulates a state changing call as `source` would send it, without
   * sending. A contract refusal comes back as a value, since it is an answer.
   */
  simulate(
    contractId: string,
    method: string,
    args: readonly xdr.ScVal[],
    source: string,
  ): Promise<SimulateResult>;
  /** Simulates, signs with `signer`, sends and waits for the result. */
  invoke(
    contractId: string,
    method: string,
    args: readonly xdr.ScVal[],
    signer: TxSigner,
  ): Promise<InvokeResult>;
  /** What the network says about a transaction hash. */
  transaction(hash: string): Promise<TxLookup>;
}

export interface RpcGatewayOptions {
  readonly rpcUrl?: string;
  readonly networkPassphrase?: string;
  /** Any existing account; read only simulations need a source. */
  readonly readSource: string;
  /** Per RPC call. */
  readonly timeoutMs?: number;
  /** How long to wait for a sent transaction to land. */
  readonly confirmTimeoutMs?: number;
  readonly pollIntervalMs?: number;
}

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_CONFIRM_MS = 90_000;
const DEFAULT_POLL_MS = 1_500;
/** Retries of a send the network asked us to try again later. */
const SEND_ATTEMPTS = 4;
/** Inclusion fee in stroops, above the base so a busy testnet still takes it. */
const INCLUSION_FEE = String(Number(BASE_FEE) * 100);
const TX_TIMEOUT_SECONDS = 120;

export function withTimeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new EngineError('rpc_timeout', `${what} timed out after ${ms} ms`));
    }, ms);
  });
  return Promise.race([work, timeout]).finally(() => {
    clearTimeout(timer);
  });
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

function refusal(method: string, error: string, txHash?: string): EngineError {
  const code = contractCodeIn(error);
  if (code !== undefined) return new ContractRefusedError(method, code, txHash);
  // The host error text can be long and holds nothing secret, but only its
  // first line is useful to a caller.
  const first = error.split('\n')[0] ?? 'unknown';
  return new EngineError('tx_failed', `${method} failed in simulation: ${first.slice(0, 200)}`);
}

/** A gateway over a real Stellar RPC server. Testnet unless told otherwise. */
export class RpcGateway implements SorobanGateway {
  private readonly server: rpc.Server;
  private readonly passphrase: string;
  private readonly readSource: string;
  private readonly timeoutMs: number;
  private readonly confirmMs: number;
  private readonly pollMs: number;

  constructor(options: RpcGatewayOptions) {
    const url = options.rpcUrl ?? TESTNET_RPC_URL;
    this.server = new rpc.Server(url, { allowHttp: url.startsWith('http://localhost') });
    this.passphrase = options.networkPassphrase ?? TESTNET_PASSPHRASE;
    this.readSource = options.readSource;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.confirmMs = options.confirmTimeoutMs ?? DEFAULT_CONFIRM_MS;
    this.pollMs = options.pollIntervalMs ?? DEFAULT_POLL_MS;
  }

  private build(
    source: Account,
    contractId: string,
    method: string,
    args: readonly xdr.ScVal[],
  ): Transaction {
    return new TransactionBuilder(source, {
      fee: INCLUSION_FEE,
      networkPassphrase: this.passphrase,
    })
      .addOperation(new Contract(contractId).call(method, ...args))
      .setTimeout(TX_TIMEOUT_SECONDS)
      .build();
  }

  private async rpcCall<T>(work: () => Promise<T>, what: string): Promise<T> {
    try {
      return await withTimeout(work(), this.timeoutMs, what);
    } catch (error) {
      if (error instanceof EngineError) throw error;
      throw new EngineError('rpc_unavailable', `${what} failed: ${errorName(error)}`, {
        cause: error,
      });
    }
  }

  private async simulateRaw(tx: Transaction, method: string) {
    return this.rpcCall(() => this.server.simulateTransaction(tx), `simulate ${method}`);
  }

  async read(contractId: string, method: string, args: readonly xdr.ScVal[]) {
    const result = await this.simulate(contractId, method, args, this.readSource);
    if (!result.ok) throw result.error;
    return result.returnValue;
  }

  async simulate(
    contractId: string,
    method: string,
    args: readonly xdr.ScVal[],
    source: string,
  ): Promise<SimulateResult> {
    const tx = this.build(new Account(source, '0'), contractId, method, args);
    const sim = await this.simulateRaw(tx, method);
    if (rpc.Api.isSimulationError(sim)) {
      const error = refusal(method, sim.error);
      if (error instanceof ContractRefusedError) return { ok: false, error };
      throw error;
    }
    const retval = sim.result?.retval;
    if (retval === undefined) {
      throw new EngineError('rpc_unavailable', `simulate ${method} returned no value`);
    }
    return { ok: true, returnValue: retval };
  }

  async invoke(
    contractId: string,
    method: string,
    args: readonly xdr.ScVal[],
    signer: TxSigner,
  ): Promise<InvokeResult> {
    const account = await this.rpcCall(
      () => this.server.getAccount(signer.publicKey),
      'load the signing account',
    );
    const tx = this.build(account, contractId, method, args);
    const sim = await this.simulateRaw(tx, method);
    if (rpc.Api.isSimulationError(sim)) throw refusal(method, sim.error);
    const prepared = rpc.assembleTransaction(tx, sim).build();
    signer.sign(prepared);
    const hash = Buffer.from(prepared.hash()).toString('hex');

    for (let attempt = 1; ; attempt++) {
      const sent = await this.rpcCall(
        () => this.server.sendTransaction(prepared),
        `send ${method}`,
      ).catch((error: unknown) => {
        // A send whose answer was lost may still have reached the network,
        // so the caller must look the hash up before trying anything else.
        throw new EngineError('submission_unknown', `send ${method} lost its answer (${hash})`, {
          cause: error,
        });
      });
      if (sent.status === 'PENDING' || sent.status === 'DUPLICATE') break;
      if (sent.status === 'TRY_AGAIN_LATER' && attempt < SEND_ATTEMPTS) {
        await sleep(this.pollMs * attempt);
        continue;
      }
      throw new EngineError('tx_failed', `${method} was not accepted (${sent.status}, ${hash})`);
    }
    return this.confirm(hash, method);
  }

  private async confirm(hash: string, method: string): Promise<InvokeResult> {
    const deadline = Date.now() + this.confirmMs;
    while (Date.now() < deadline) {
      const got = await this.rpcCall(() => this.server.getTransaction(hash), `look up ${method}`);
      if (got.status === rpc.Api.GetTransactionStatus.SUCCESS) {
        return { txHash: hash, ledger: got.ledger, returnValue: got.returnValue };
      }
      if (got.status === rpc.Api.GetTransactionStatus.FAILED) {
        const code = contractCodeInEvents(got.diagnosticEventsXdr ?? []);
        if (code !== undefined) throw new ContractRefusedError(method, code, hash);
        throw new EngineError('tx_failed', `${method} failed on chain (${hash})`);
      }
      await sleep(this.pollMs);
    }
    throw new EngineError('submission_unknown', `${method} not confirmed in time (${hash})`);
  }

  async transaction(hash: string): Promise<TxLookup> {
    const got = await this.rpcCall(() => this.server.getTransaction(hash), 'look up a transaction');
    if (got.status === rpc.Api.GetTransactionStatus.NOT_FOUND) return { status: 'NOT_FOUND' };
    return { status: got.status, ledger: got.ledger };
  }
}

/**
 * The contract error a failed transaction's diagnostic events carry, if any.
 * Events are read as JSON, where a contract error is a number under
 * `contract`; an address under that key is a string and never matches.
 */
export function contractCodeInEvents(events: readonly { toJson(): unknown }[]): number | undefined {
  for (const event of events) {
    const text = JSON.stringify(event.toJson());
    const match = /"contract"\s*:\s*(\d+)/.exec(text) ?? /Error\(Contract, #(\d+)\)/.exec(text);
    if (match?.[1] !== undefined) return Number(match[1]);
  }
  return undefined;
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'non-error';
}
