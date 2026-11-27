// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

import { Account, Keypair, Networks, Operation, TransactionBuilder } from '@stellar/stellar-sdk';
import { describe, expect, it, vi } from 'vitest';

import { callOptions, ChainError, type CallOptions } from '../adapter.js';
import { StellarAgentAccounts } from './agent-accounts.js';
import type { AccountFacts } from './network.js';

function chain(exists = true) {
  return {
    friendbot: vi.fn<(address: string) => Promise<void>>(() => Promise.resolve()),
    accountFacts: vi.fn<(address: string) => Promise<AccountFacts>>(() =>
      Promise.resolve({ exists, trustlines: [], memoRequired: false }),
    ),
  };
}

function chainError(work: () => unknown): ChainError {
  try {
    work();
  } catch (error) {
    if (error instanceof ChainError) return error;
    throw error;
  }
  throw new Error('expected a ChainError');
}

const testnet = (c = chain()) => new StellarAgentAccounts({ network: 'stellar:testnet', chain: c });

describe('StellarAgentAccounts', () => {
  it('makes a fresh ed25519 key whose secret is the raw seed of its account', () => {
    const accounts = testnet();
    const one = accounts.generate();
    const two = accounts.generate();
    expect(one.publicKey).toMatch(/^G[A-Z2-7]{55}$/);
    expect(one.secret).toHaveLength(32);
    expect(Keypair.fromRawEd25519Seed(Buffer.from(one.secret)).publicKey()).toBe(one.publicKey);
    expect(one.publicKey).not.toBe(two.publicKey);
  });

  it('signs as the account the secret belongs to, and only that account', () => {
    const accounts = testnet();
    const key = accounts.generate();
    const signer = accounts.signer(key.secret, key.publicKey);
    expect(signer.publicKey).toBe(key.publicKey);

    const tx = new TransactionBuilder(new Account(key.publicKey, '1'), {
      fee: '100',
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(Operation.bumpSequence({ bumpTo: '2' }))
      .setTimeout(30)
      .build();
    signer.sign(tx);
    const signature = tx.signatures[0];
    expect(signature).toBeDefined();
    expect(
      Keypair.fromPublicKey(key.publicKey).verify(
        tx.hash(),
        signature?.signature ?? Buffer.alloc(0),
      ),
    ).toBe(true);
    const other = accounts.generate();
    expect(
      Keypair.fromPublicKey(other.publicKey).verify(
        tx.hash(),
        signature?.signature ?? Buffer.alloc(0),
      ),
    ).toBe(false);
  });

  it('keeps its own copy, so zeroing the caller buffer does not change the signer', () => {
    const accounts = testnet();
    const key = accounts.generate();
    const secret = Buffer.from(key.secret);
    const signer = accounts.signer(secret, key.publicKey);
    secret.fill(0);
    const tx = new TransactionBuilder(new Account(key.publicKey, '1'), {
      fee: '100',
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(Operation.bumpSequence({ bumpTo: '2' }))
      .setTimeout(30)
      .build();
    signer.sign(tx);
    expect(
      Keypair.fromPublicKey(key.publicKey).verify(
        tx.hash(),
        tx.signatures[0]?.signature ?? Buffer.alloc(0),
      ),
    ).toBe(true);
  });

  it('refuses a secret that is not the key of the account named, without naming either', () => {
    const accounts = testnet();
    const mine = accounts.generate();
    const theirs = accounts.generate();
    const error = chainError(() => accounts.signer(mine.secret, theirs.publicKey));
    expect(error.code).toBe('SIGNATURE_INVALID');
    expect(error.message).not.toContain(theirs.publicKey);
    expect(error.message).not.toContain(mine.publicKey);
    expect(chainError(() => accounts.signer(Buffer.alloc(16), mine.publicKey)).code).toBe(
      'SIGNATURE_INVALID',
    );
  });

  it('funds through friendbot, reads the account back, and adds no trustline', async () => {
    const c = chain();
    const key = testnet(c).generate();
    await testnet(c).fund(key.publicKey, callOptions('t-1'));
    expect(c.friendbot).toHaveBeenCalledWith(key.publicKey);
    expect(c.accountFacts).toHaveBeenCalledWith(key.publicKey);
  });

  it('fails as UNAVAILABLE when the account still does not exist', async () => {
    const accounts = testnet(chain(false));
    await expect(
      accounts.fund(accounts.generate().publicKey, callOptions('t-2')),
    ).rejects.toMatchObject({
      name: 'ChainError',
      code: 'UNAVAILABLE',
      reason: 'friendbot_failed',
    });
  });

  it('passes on a friendbot failure as a ChainError', async () => {
    const c = chain();
    c.friendbot.mockRejectedValueOnce(new Error('socket hang up'));
    const accounts = testnet(c);
    await expect(
      accounts.fund(accounts.generate().publicKey, callOptions('t-3')),
    ).rejects.toMatchObject({
      name: 'ChainError',
      code: 'UNAVAILABLE',
    });
  });

  it('answers TIMEOUT when friendbot outlives the call deadline', async () => {
    const c = chain();
    c.friendbot.mockImplementationOnce(() => new Promise<void>(() => undefined));
    const accounts = testnet(c);
    const o: CallOptions = { signal: AbortSignal.timeout(20), correlationId: 't-4' };
    await expect(accounts.fund(accounts.generate().publicKey, o)).rejects.toMatchObject({
      code: 'TIMEOUT',
    });
  });

  it('funds nothing off testnet', async () => {
    const c = chain();
    const accounts = new StellarAgentAccounts({ network: 'stellar:pubnet', chain: c });
    await expect(
      accounts.fund(accounts.generate().publicKey, callOptions('t-5')),
    ).rejects.toMatchObject({
      code: 'UNAVAILABLE',
      reason: 'funding_unsupported',
    });
    expect(c.friendbot).not.toHaveBeenCalled();
  });
});
