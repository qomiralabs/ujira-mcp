// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// Verify against a recorded testnet transaction: the Stellar adapter reads
// Horizon's recorded answers for the execute transaction that paid the demo
// payout, and the receipt matches only when the mandate, destination and
// amount are what that transaction did.

import { describe, expect, it } from 'vitest';

import { RECORDED, horizonFixture } from '../../test/fixtures/horizon/recorded.js';
import { blockedReceipt, paidReceipt, usdc } from '../../test/receipt-fixtures.js';
import {
  ChainError,
  callOptions,
  type ChainAdapter,
  type TransactionTransfers,
} from '../chain/adapter.js';
import { StellarChainAdapter } from '../chain/stellar/adapter.js';
import type { SorobanGateway } from '../chain/stellar/gateway.js';
import { recordFromHorizon } from '../chain/stellar/history.js';
import type { StellarNetworkPort } from '../chain/stellar/network.js';
import { ReceiptNetworkNotServedError } from './errors.js';
import { verifyReceipt } from './verify.js';

const unused = () => Promise.reject(new Error('not used here'));

// The real adapter over a network port that answers from the recordings.
function recordedChain(): StellarChainAdapter {
  const chain: StellarNetworkPort = {
    account: unused,
    accountFacts: unused,
    loadAccount: unused,
    prepare: unused,
    submit: unused,
    friendbot: unused,
    latestLedger: unused,
    transactionRecord: (hash) =>
      Promise.resolve(
        hash === RECORDED.executeTx
          ? recordFromHorizon(horizonFixture('execute-tx'), horizonFixture('execute-ops'))
          : hash === RECORDED.requestTx
            ? recordFromHorizon(horizonFixture('request-tx'), horizonFixture('request-ops'))
            : null,
      ),
  };
  return new StellarChainAdapter({
    gateway: {} as SorobanGateway,
    chain,
    factory: 'CB4AYBA5NVQPVPNOWUCSZQK6ZIGOF7KSCS6SF6UV6D2OKPDXLHEPD4V7',
    asset: {
      code: 'USDC',
      issuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
      contract: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
    },
  });
}

const OTHER_WALLET = 'GBT7ITQKEX3Z2YWIYLPRQ5W3JLA2TJ3JTABB765ZYNG7VLX5YYUPI3DT';
const OTHER_MANDATE = 'CCTOGUKVBT6XK5DM3LKY3NEV2B4JWK4ZFTFAGRZUNVZ3OGFS4ZQLRYES';
const o = () => callOptions('verify-test');

describe('verifyReceipt against the recorded testnet payout', () => {
  const chain = recordedChain();

  it('matches the receipt of what the transaction paid', async () => {
    expect(await verifyReceipt(paidReceipt(), chain, o())).toEqual({
      matched: true,
      field: null,
      txHash: RECORDED.executeTx,
    });
  });

  it('names the amount when the receipt says another amount', async () => {
    const receipt = paidReceipt({
      amount: usdc(RECORDED.amount + 1n),
      legs: [
        {
          index: 0,
          destination: RECORDED.destination,
          amount: usdc(RECORDED.amount + 1n),
          txHash: RECORDED.executeTx,
        },
      ],
    });
    expect(await verifyReceipt(receipt, chain, o())).toEqual({
      matched: false,
      field: 'amount',
      txHash: RECORDED.executeTx,
    });
  });

  it('names the destination when the money went to another wallet', async () => {
    const receipt = paidReceipt({
      legs: [
        {
          index: 0,
          destination: OTHER_WALLET,
          amount: usdc(RECORDED.amount),
          txHash: RECORDED.executeTx,
        },
      ],
    });
    expect((await verifyReceipt(receipt, chain, o())).field).toBe('destination');
  });

  it('names the mandate when the transaction is not that mandate paying', async () => {
    const receipt = paidReceipt({
      mandate: { id: paidReceipt().mandate.id, contractId: OTHER_MANDATE },
    });
    expect((await verifyReceipt(receipt, chain, o())).field).toBe('mandate');
    // The request transaction called the mandate but moved nothing out of it.
    const request = paidReceipt({ txHash: RECORDED.requestTx });
    expect(await verifyReceipt(request, chain, o())).toEqual({
      matched: false,
      field: 'mandate',
      txHash: RECORDED.requestTx,
    });
  });

  it('names the transaction when the network never had it', async () => {
    const receipt = paidReceipt({ txHash: 'a'.repeat(64) });
    expect(await verifyReceipt(receipt, chain, o())).toEqual({
      matched: false,
      field: 'txHash',
      txHash: 'a'.repeat(64),
    });
  });

  it('has no transaction to check for a blocked payout, and reads no chain', async () => {
    const silent: Pick<ChainAdapter, 'network' | 'transfers'> = {
      network: 'stellar:testnet',
      transfers: unused,
    };
    expect(await verifyReceipt(blockedReceipt(), silent, o())).toEqual({
      matched: false,
      field: 'txHash',
      txHash: null,
    });
  });

  it('refuses a receipt from a network the adapter does not serve', async () => {
    await expect(
      verifyReceipt(paidReceipt({ network: 'stellar:pubnet' }), chain, o()),
    ).rejects.toThrow(ReceiptNetworkNotServedError);
  });
});

describe('verifyReceipt on transactions the recording does not cover', () => {
  const answering = (tx: TransactionTransfers): Pick<ChainAdapter, 'network' | 'transfers'> => ({
    network: 'stellar:testnet',
    transfers: () => Promise.resolve(tx),
  });
  const success = (transfers: { to: string; amount: bigint }[]): TransactionTransfers => ({
    status: 'SUCCESS',
    ledger: 1,
    calls: [{ contract: RECORDED.mandate, fn: 'execute' }],
    transfers: transfers.map((t) => ({ from: RECORDED.mandate, ...t })),
  });
  const twoLegs = paidReceipt({
    amount: usdc(30n),
    legs: [
      { index: 0, destination: RECORDED.destination, amount: usdc(20n), txHash: 'b'.repeat(64) },
      { index: 1, destination: RECORDED.destination, amount: usdc(10n), txHash: 'b'.repeat(64) },
    ],
  });

  it('pairs each leg with its own transfer, even two legs to one wallet', async () => {
    const both = success([
      { to: RECORDED.destination, amount: 10n },
      { to: RECORDED.destination, amount: 20n },
    ]);
    expect((await verifyReceipt(twoLegs, answering(both), o())).matched).toBe(true);
    const once = success([{ to: RECORDED.destination, amount: 20n }]);
    expect((await verifyReceipt(twoLegs, answering(once), o())).field).toBe('destination');
  });

  it('is not a match when more left the mandate than the receipt says', async () => {
    const extra = success([
      { to: RECORDED.destination, amount: RECORDED.amount },
      { to: OTHER_WALLET, amount: 1n },
    ]);
    expect((await verifyReceipt(paidReceipt(), answering(extra), o())).field).toBe('amount');
    // The same extra transfer is the fee when the receipt says there was one.
    const withFee = paidReceipt({ fee: usdc(1n) });
    expect((await verifyReceipt(withFee, answering(extra), o())).matched).toBe(true);
  });

  it('names the transaction when it failed', async () => {
    const failed = answering({ status: 'FAILED', ledger: 3 });
    expect((await verifyReceipt(paidReceipt(), failed, o())).field).toBe('txHash');
  });

  it('passes a chain outage on rather than calling it a mismatch', async () => {
    const down: Pick<ChainAdapter, 'network' | 'transfers'> = {
      network: 'stellar:testnet',
      transfers: () => Promise.reject(new ChainError('UNAVAILABLE', 'down')),
    };
    await expect(verifyReceipt(paidReceipt(), down, o())).rejects.toMatchObject({
      code: 'UNAVAILABLE',
    });
  });
});
