// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The console's view of the network: account balances, friendbot, and
// preparing and sending transactions. Routes only see this port, so tests
// answer it from memory. The Stellar work happens in src/chain; this layer
// only turns its failures into the console's answers.

import {
  StellarNetwork,
  decimalToMinor as chainDecimalToMinor,
  type Account,
  type AccountView,
  type StellarNetworkOptions,
  type Submitted,
  type Transaction,
} from '../chain/stellar/network.js';
import { toApiError } from './errors.js';

export type { AccountView, Submitted } from '../chain/stellar/network.js';

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
  try {
    return chainDecimalToMinor(value, decimals);
  } catch (error) {
    throw toApiError(error);
  }
}

export type StellarChainOptions = StellarNetworkOptions;

async function answered<T>(work: Promise<T>): Promise<T> {
  try {
    return await work;
  } catch (error) {
    throw toApiError(error);
  }
}

export class StellarConsoleChain implements ConsoleChain {
  /** Shared with the chain adapter, so both use one RPC client. */
  readonly network: StellarNetwork;

  constructor(options: StellarChainOptions) {
    this.network = new StellarNetwork(options);
  }

  account(address: string, usdc: { code: string; issuer: string }): Promise<AccountView> {
    return answered(this.network.account(address, usdc));
  }

  loadAccount(address: string): Promise<Account> {
    return answered(this.network.loadAccount(address));
  }

  prepare(tx: Transaction): Promise<Transaction> {
    return answered(this.network.prepare(tx));
  }

  submit(tx: Transaction): Promise<Submitted> {
    return answered(this.network.submit(tx));
  }

  friendbot(address: string): Promise<void> {
    return answered(this.network.friendbot(address));
  }
}
