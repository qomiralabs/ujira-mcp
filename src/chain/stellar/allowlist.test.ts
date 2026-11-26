// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

import { createHash } from 'node:crypto';

import {
  Account,
  Asset,
  FeeBumpTransaction,
  Keypair,
  Operation,
  TransactionBuilder,
  xdr,
} from '@stellar/stellar-sdk';
import { describe, expect, it } from 'vitest';

import { MANDATE, UNIT, agent, executor } from '../../../test/fake-rpc.js';
import { alice } from '../../../test/helpers.js';
import { defaultRecipientRef } from '../../ids.js';
import { ChainError } from '../adapter.js';
import { allowEntriesOf, classify, parseEnvelope, type AllowContext } from './allowlist.js';
import { address, encodeAllowEntries, i128 } from './codec.js';
import { TESTNET_PASSPHRASE } from './gateway.js';
import { createArgs, invokeTx, trustlineTx } from './txbuild.js';

const FACTORY = 'CB4AYBA5NVQPVPNOWUCSZQK6ZIGOF7KSCS6SF6UV6D2OKPDXLHEPD4V7';
const USDC = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA';
const ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
const OTHER = 'CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA';

const owner = Keypair.fromRawEd25519Seed(createHash('sha256').update('owner').digest());

const ctx: AllowContext = {
  factory: FACTORY,
  usdc: { code: 'USDC', issuer: ISSUER, contract: USDC },
  agent: agent.publicKey,
  executor: executor.publicKey,
  isRegistered: (id) => id === MANDATE,
};

const src = () => new Account(owner.publicKey(), '1');
const params = {
  budget: 100n * UNIT,
  perPaymentCap: 10n * UNIT,
  dailyCap: 20n * UNIT,
  approvalThreshold: 5n * UNIT,
  expiresAt: 1_800_000_000 + 86_400,
};
const createCtx = {
  principal: owner.publicKey(),
  agent: agent.publicKey,
  executor: executor.publicKey,
  asset: USDC,
  now: 1_800_000_000,
};

/** The console code a refusal carries; every refusal is a signing request mismatch. */
function refusedCode(work: () => unknown): string | undefined {
  try {
    work();
  } catch (error) {
    return error instanceof ChainError && error.code === 'SIGNING_REQUEST_MISMATCH'
      ? error.reason
      : 'other';
  }
  return undefined;
}

describe('submit allow list', () => {
  it('accepts a create that names this server as agent and executor', () => {
    const tx = invokeTx(src(), FACTORY, 'create', createArgs(params, createCtx));
    expect(classify(tx, ctx)).toEqual({ kind: 'create', principal: owner.publicKey() });
  });

  it('refuses a create for another agent, another executor or another asset', () => {
    for (const over of [
      { agent: Keypair.random().publicKey() },
      { executor: Keypair.random().publicKey() },
      { asset: OTHER },
    ]) {
      const tx = invokeTx(src(), FACTORY, 'create', createArgs(params, { ...createCtx, ...over }));
      expect(refusedCode(() => classify(tx, ctx))).toBe('tx_not_allowed');
    }
    const upgrade = invokeTx(src(), FACTORY, 'fee_address', []);
    expect(refusedCode(() => classify(upgrade, ctx))).toBe('tx_not_allowed');
  });

  it('accepts USDC only into a console mandate', () => {
    const fund = (to: string) =>
      invokeTx(src(), USDC, 'transfer', [address(owner.publicKey()), address(to), i128(5n)]);
    expect(classify(fund(MANDATE), ctx)).toEqual({ kind: 'fund', mandate: MANDATE, amount: 5n });
    expect(refusedCode(() => classify(fund(OTHER), ctx))).toBe('tx_not_allowed');
    expect(refusedCode(() => classify(fund(alice), ctx))).toBe('tx_not_allowed');
    const approve = invokeTx(src(), USDC, 'approve', [
      address(owner.publicKey()),
      address(MANDATE),
      i128(5n),
      xdr.ScVal.scvU32(1),
    ]);
    expect(refusedCode(() => classify(approve, ctx))).toBe('tx_not_allowed');
  });

  it('accepts owner calls on a console mandate and nothing else', () => {
    for (const method of ['pause', 'resume', 'revoke', 'sweep', 'withdraw', 'approve', 'reject']) {
      expect(classify(invokeTx(src(), MANDATE, method, []), ctx)).toMatchObject({
        kind: 'mandate',
        method,
      });
    }
    for (const method of ['execute', 'request_payout', 'add_role', 'update_limits', 'cancel']) {
      expect(refusedCode(() => classify(invokeTx(src(), MANDATE, method, []), ctx))).toBe(
        'tx_not_allowed',
      );
    }
    expect(refusedCode(() => classify(invokeTx(src(), OTHER, 'pause', []), ctx))).toBe(
      'tx_not_allowed',
    );
  });

  it('accepts a USDC trustline only', () => {
    expect(classify(trustlineTx(src(), { code: 'USDC', issuer: ISSUER }), ctx)).toEqual({
      kind: 'trustline',
    });
    const fake = trustlineTx(src(), { code: 'USDC', issuer: owner.publicKey() });
    expect(refusedCode(() => classify(fake, ctx))).toBe('tx_not_allowed');
  });

  it('refuses other operations, two operations and fee bumps', () => {
    const builder = () =>
      new TransactionBuilder(src(), { fee: '100', networkPassphrase: TESTNET_PASSPHRASE });
    const pay = builder()
      .addOperation(Operation.payment({ destination: alice, asset: Asset.native(), amount: '1' }))
      .setTimeout(60)
      .build();
    expect(refusedCode(() => classify(pay, ctx))).toBe('tx_not_allowed');
    const two = builder()
      .addOperation(Operation.changeTrust({ asset: new Asset('USDC', ISSUER) }))
      .addOperation(Operation.changeTrust({ asset: new Asset('USDC', ISSUER) }))
      .setTimeout(60)
      .build();
    expect(refusedCode(() => classify(two, ctx))).toBe('tx_not_allowed');

    const inner = trustlineTx(src(), { code: 'USDC', issuer: ISSUER });
    const key = Keypair.random();
    inner.sign(key);
    const bump: FeeBumpTransaction = TransactionBuilder.buildFeeBumpTransaction(
      key,
      '20000',
      inner,
      TESTNET_PASSPHRASE,
    );
    expect(refusedCode(() => parseEnvelope(bump.toXdr()))).toBe('tx_not_allowed');
    expect(refusedCode(() => parseEnvelope('garbage'))).toBe('invalid_xdr');
    expect(parseEnvelope(inner.toXdr()).source).toBe(owner.publicKey());
  });

  it('reads the entries of an allow_recipients call', () => {
    const entries = [{ recipientRef: defaultRecipientRef(alice), destination: alice }];
    expect(allowEntriesOf([encodeAllowEntries(entries)])).toEqual([
      { ref: defaultRecipientRef(alice), destination: alice },
    ]);
    expect(allowEntriesOf([])).toEqual([]);
    expect(allowEntriesOf([i128(1n)])).toEqual([]);
  });
});
