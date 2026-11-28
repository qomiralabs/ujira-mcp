// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The transaction history read, against Horizon answers recorded from Stellar
// testnet (test/fixtures/horizon/recorded.ts).

import { describe, expect, it } from 'vitest';

import { RECORDED, horizonFixture as fixture } from '../../../test/fixtures/horizon/recorded.js';
import { ChainError, callOptions } from '../adapter.js';
import { StellarChainAdapter } from './adapter.js';
import type { SorobanGateway } from './gateway.js';
import { recordFromHorizon, type TransactionRecord } from './history.js';
import { StellarNetwork, type StellarNetworkPort } from './network.js';

describe('recordFromHorizon', () => {
  it('reads the call and the transfer of a recorded execute transaction', () => {
    expect(recordFromHorizon(fixture('execute-tx'), fixture('execute-ops'))).toEqual({
      successful: true,
      ledger: 5708807,
      calls: [{ contract: RECORDED.mandate, fn: 'execute' }],
      transfers: [
        {
          asset: RECORDED.asset,
          from: RECORDED.mandate,
          to: RECORDED.destination,
          amount: 50_000_000n,
        },
      ],
    });
  });

  it('reads a recorded request transaction as a call that moved nothing', () => {
    const record = recordFromHorizon(fixture('request-tx'), fixture('request-ops'));
    expect(record.calls).toEqual([{ contract: RECORDED.mandate, fn: 'request_payout' }]);
    expect(record.transfers).toEqual([]);
  });

  it('refuses shapes it does not expect rather than reading nothing', () => {
    const ops = fixture('execute-ops') as {
      _embedded: { records: { asset_balance_changes: { amount: string; from?: string }[] }[] };
    };
    const change = ops._embedded.records[0]?.asset_balance_changes[0];
    if (change === undefined) throw new Error('the fixture has no transfer');
    const cases: [unknown, unknown][] = [
      [{ ledger: 1 }, fixture('execute-ops')],
      [fixture('execute-tx'), { records: [] }],
      [fixture('execute-tx'), withChange({ ...change, amount: '5.5' })],
      [fixture('execute-tx'), withChange({ ...change, amount: '-5.0000000' })],
      [fixture('execute-tx'), withChange({ ...change, from: undefined })],
      [fixture('execute-tx'), withChange({ ...change, asset_code: undefined })],
    ];
    for (const [tx, list] of cases) {
      expect(() => recordFromHorizon(tx, list)).toThrow(ChainError);
    }

    function withChange(next: Record<string, unknown>): unknown {
      const copy = structuredClone(ops);
      const record = copy._embedded.records[0];
      if (record !== undefined) record.asset_balance_changes = [next as never];
      return copy;
    }
  });

  it('skips mints and burns, and operations that call no contract', () => {
    const record = recordFromHorizon(
      { successful: true, ledger: 9 },
      {
        _embedded: {
          records: [
            { type: 'payment' },
            {
              type: 'invoke_host_function',
              parameters: [],
              asset_balance_changes: [
                {
                  asset_type: 'native',
                  type: 'mint',
                  to: RECORDED.destination,
                  amount: '1.0000000',
                },
                {
                  asset_type: 'native',
                  type: 'transfer',
                  from: RECORDED.mandate,
                  to: RECORDED.destination,
                  amount: '0.0000001',
                },
              ],
            },
          ],
        },
      },
    );
    expect(record.calls).toEqual([]);
    expect(record.transfers).toEqual([
      { asset: 'native', from: RECORDED.mandate, to: RECORDED.destination, amount: 1n },
    ]);
  });
});

function respond(answers: Record<string, { status: number; body: unknown }>): typeof fetch {
  return (input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const path = new URL(url).pathname + new URL(url).search;
    const answer = answers[path];
    if (answer === undefined) return Promise.reject(new Error(`unexpected ${path}`));
    return Promise.resolve(
      new Response(JSON.stringify(answer.body), {
        status: answer.status,
        headers: { 'content-type': 'application/json' },
      }),
    );
  };
}

const network = (fetchFn: typeof fetch) =>
  new StellarNetwork({
    rpcUrl: 'http://localhost:1',
    horizonUrl: 'https://horizon.example',
    friendbotUrl: 'https://friendbot.example',
    fetch: fetchFn,
  });

describe('StellarNetwork.transactionRecord', () => {
  const txPath = `/transactions/${RECORDED.executeTx}`;

  it('reads the transaction and its operations from Horizon', async () => {
    const got = await network(
      respond({
        [txPath]: { status: 200, body: fixture('execute-tx') },
        [`${txPath}/operations?limit=100`]: { status: 200, body: fixture('execute-ops') },
      }),
    ).transactionRecord(RECORDED.executeTx);
    expect(got?.transfers[0]?.amount).toBe(50_000_000n);
  });

  it('answers null for a transaction the network never had', async () => {
    const got = await network(
      respond({ [txPath]: { status: 404, body: fixture('not-found') } }),
    ).transactionRecord(RECORDED.executeTx);
    expect(got).toBeNull();
  });

  it('is unavailable when Horizon fails, and refuses a hash that is not one', async () => {
    const failing = network(respond({ [txPath]: { status: 503, body: {} } }));
    await expect(failing.transactionRecord(RECORDED.executeTx)).rejects.toMatchObject({
      code: 'UNAVAILABLE',
    });
    const opsFailing = network(
      respond({
        [txPath]: { status: 200, body: fixture('execute-tx') },
        [`${txPath}/operations?limit=100`]: { status: 500, body: {} },
      }),
    );
    await expect(opsFailing.transactionRecord(RECORDED.executeTx)).rejects.toMatchObject({
      code: 'UNAVAILABLE',
    });
    await expect(failing.transactionRecord('../accounts')).rejects.toThrow(RangeError);
  });
});

describe('StellarChainAdapter.transfers', () => {
  const unused = () => Promise.reject(new Error('not used here'));
  const port = (record: TransactionRecord | null | 'none'): StellarNetworkPort => ({
    account: unused,
    accountFacts: unused,
    loadAccount: unused,
    prepare: unused,
    submit: unused,
    friendbot: unused,
    latestLedger: unused,
    ...(record === 'none' ? {} : { transactionRecord: () => Promise.resolve(record) }),
  });
  const adapter = (record: TransactionRecord | null | 'none') =>
    new StellarChainAdapter({
      gateway: {} as SorobanGateway,
      chain: port(record),
      factory: 'CB4AYBA5NVQPVPNOWUCSZQK6ZIGOF7KSCS6SF6UV6D2OKPDXLHEPD4V7',
      asset: {
        code: 'USDC',
        issuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
        contract: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
      },
    });
  const recorded = recordFromHorizon(fixture('execute-tx'), fixture('execute-ops'));

  it('keeps only transfers of the asset mandates hold', async () => {
    const withXlm: TransactionRecord = {
      ...recorded,
      transfers: [
        ...recorded.transfers,
        { asset: 'native', from: RECORDED.mandate, to: RECORDED.destination, amount: 1n },
      ],
    };
    const got = await adapter(withXlm).transfers(
      RECORDED.executeTx.toUpperCase(),
      callOptions('t'),
    );
    expect(got).toEqual({
      status: 'SUCCESS',
      ledger: 5708807,
      calls: [{ contract: RECORDED.mandate, fn: 'execute' }],
      transfers: [{ from: RECORDED.mandate, to: RECORDED.destination, amount: 50_000_000n }],
    });
  });

  it('says when a transaction is missing or failed', async () => {
    expect(await adapter(null).transfers(RECORDED.executeTx, callOptions('t'))).toEqual({
      status: 'NOT_FOUND',
    });
    expect(
      await adapter({ ...recorded, successful: false }).transfers(
        RECORDED.executeTx,
        callOptions('t'),
      ),
    ).toEqual({ status: 'FAILED', ledger: 5708807 });
  });

  it('is unavailable without a history, and refuses a bad hash before any call', async () => {
    await expect(
      adapter('none').transfers(RECORDED.executeTx, callOptions('t')),
    ).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    await expect(adapter(null).transfers('xyz', callOptions('t'))).rejects.toThrow(RangeError);
  });

  it('is bounded by the call deadline', async () => {
    const stuck = new StellarChainAdapter({
      gateway: {} as SorobanGateway,
      chain: { ...port(null), transactionRecord: () => new Promise(() => undefined) },
      factory: 'CB4AYBA5NVQPVPNOWUCSZQK6ZIGOF7KSCS6SF6UV6D2OKPDXLHEPD4V7',
      asset: {
        code: 'USDC',
        issuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
        contract: 'C',
      },
    });
    await expect(stuck.transfers(RECORDED.executeTx, callOptions('t', 5))).rejects.toMatchObject({
      code: 'TIMEOUT',
    });
  });
});
