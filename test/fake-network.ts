// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// Accounts, preparing and sending, in memory, behind the port the Stellar
// adapter uses for whole transactions. With FakeMandateRpc it lets tests
// outside src/chain run the real adapter without a network.

import { Account, type Transaction } from '@stellar/stellar-sdk';

import { ChainError } from '../src/chain/adapter.js';
import type { AccountFacts, StellarNetworkPort, Submitted } from '../src/chain/stellar/network.js';

export class FakeNetwork implements StellarNetworkPort {
  facts = new Map<string, AccountFacts>();
  submitted: Transaction[] = [];
  answers: Partial<Submitted>[] = [];
  // Every call that reaches the network fails as an outage while set.
  down = false;
  // Every call that reaches the network never answers while set.
  silent = false;
  calls: string[] = [];

  private gate<T>(what: string, answer: () => T): Promise<T> {
    this.calls.push(what);
    if (this.silent) return new Promise<T>(() => undefined);
    if (this.down) return Promise.reject(new ChainError('UNAVAILABLE', 'the fake network is down'));
    return Promise.resolve(answer());
  }

  account() {
    return this.gate('account', () => ({ exists: true, xlm: '100', usdc: null }));
  }
  accountFacts(address: string): Promise<AccountFacts> {
    return this.gate(
      'accountFacts',
      () => this.facts.get(address) ?? { exists: false, trustlines: [], memoRequired: false },
    );
  }
  loadAccount(address: string): Promise<Account> {
    return this.gate('loadAccount', () => new Account(address, '100'));
  }
  prepare(tx: Transaction): Promise<Transaction> {
    return this.gate('prepare', () => tx);
  }
  submit(tx: Transaction): Promise<Submitted> {
    return this.gate('submit', () => {
      this.submitted.push(tx);
      return {
        hash: Buffer.from(tx.hash()).toString('hex'),
        status: 'SUCCESS' as const,
        ...this.answers.shift(),
      };
    });
  }
  friendbot(): Promise<void> {
    return this.gate('friendbot', () => undefined);
  }
  latestLedger(): Promise<number> {
    return this.gate('latestLedger', () => 4242);
  }
}
