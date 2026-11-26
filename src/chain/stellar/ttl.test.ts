// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

import {
  Account,
  Address,
  Keypair,
  SorobanDataBuilder,
  xdr,
  type Transaction,
} from '@stellar/stellar-sdk';
import { describe, expect, it } from 'vitest';

import { ChainError, callOptions } from '../adapter.js';
import { signerFrom } from './keys.js';
import type { LedgerEntriesRead, Submitted } from './network.js';
import {
  MAX_EXTEND_LEDGERS,
  StellarEntryKeeper,
  allowedKey,
  balanceKey,
  dailyKey,
  instanceKey,
  type KeeperNetwork,
} from './ttl.js';

const MANDATE = 'CDEEDQ64YS6XHBTWC3QLS5JWOLI3LSO46VDDZE66FW6CZGHZNRDV4GZW';
const USDC = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA';
const REF_1 = 'a5af47dc553b19356f6fd85bdabb3be0256fb70fbc800ce3d3100508609b76a7';
const DEST_1 = 'GDWQCLVZKFKKIQGXOSRZRLOBJ4V5J6UQ2L5D3RC4Y3IGEJXFZ4VJFPLX';
const REF_2 = 'f4aaf5afaf4b5ef3698f2b9d28791174954f8d075c50c3e5d4097c447a97dd35';
const DEST_2 = 'GD3GVK2SYUMIAHMRCC5ZYEAMQW6LIKC4YJ57D7A474GXIVCYKPC6XRQ3';
const WASM = Buffer.alloc(32, 7);

// Keys of the public demo mandate's entries as testnet RPC found them on
// 2026-11-26; getLedgerEntries only answers for a key the network holds.
const TESTNET_KEYS = {
  instance: 'AAAABgAAAAHIQcPcxL1zhnYW4Ll1NnLRtcnc9UY8k94tvCyY+WxHXgAAABQAAAAB',
  balance:
    'AAAABgAAAAFQRc1ewHKado/VrQJQWFLfTwKNzoMOWsUiCbpISDsvAQAAABAAAAABAAAAAgAAAA8AAAAHQmFsYW5jZQAAAAASAAAAAchBw9zEvXOGdhbguXU2ctG1ydz1RjyT3i28LJj5bEdeAAAAAQ==',
  allowed:
    'AAAABgAAAAHIQcPcxL1zhnYW4Ll1NnLRtcnc9UY8k94tvCyY+WxHXgAAABAAAAABAAAABAAAAA8AAAAHQWxsb3dlZAAAAAANAAAAIKWvR9xVOxk1b2/YW9q7O+Alb7cPvIAM49MQBQhgm3anAAAAEgAAAAAAAAAA7QEuuVFUpEDXdKOYrcFPK9T6kNL6PcRcxtBiJuXPKpIAAAABAAAAAQ==',
  daily:
    'AAAABgAAAAHIQcPcxL1zhnYW4Ll1NnLRtcnc9UY8k94tvCyY+WxHXgAAABAAAAABAAAAAgAAAA8AAAAFRGFpbHkAAAAAAAANAAAAIKWvR9xVOxk1b2/YW9q7O+Alb7cPvIAM49MQBQhgm3anAAAAAQ==',
};

const payerKeypair = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 9));
const payer = signerFrom(payerKeypair);

function instanceEntry(contract: string, wasm: Buffer | null): xdr.LedgerEntryData {
  const executable =
    wasm === null
      ? xdr.ContractExecutable.contractExecutableStellarAsset()
      : xdr.ContractExecutable.contractExecutableWasm(wasm);
  return xdr.LedgerEntryData.contractData(
    new xdr.ContractDataEntry({
      ext: xdr.ExtensionPoint.v0(),
      contract: Address.fromString(contract).toScAddress(),
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent,
      val: xdr.ScVal.scvContractInstance(new xdr.ScContractInstance({ executable, storage: null })),
    }),
  );
}

function footprint(tx: Transaction): { readOnly: string[]; readWrite: string[] } {
  const env = xdr.TransactionEnvelope.fromXdr(tx.toEnvelope().toXdr('base64'), 'base64');
  if (env.type !== 'envelopeTypeTx') throw new Error('not a v1 envelope');
  const ext = env.v1.tx.ext;
  if (ext.type !== 'sorobanData') throw new Error('no soroban data');
  const data = new SorobanDataBuilder(ext.sorobanData);
  return {
    readOnly: data.getReadOnly().map((k) => k.toXdr('base64')),
    readWrite: data.getReadWrite().map((k) => k.toXdr('base64')),
  };
}

class FakeNetwork implements KeeperNetwork {
  latestLedger = 5_932_880;
  /** Key to live until ledger; 0 is archived, as testnet answers it. */
  ttl = new Map<string, number>();
  vals = new Map<string, xdr.LedgerEntryData>();
  reads: string[][] = [];
  prepared: Transaction[] = [];
  status: Submitted['status'] = 'SUCCESS';
  fail: Error | undefined = undefined;

  put(key: xdr.LedgerKey, liveUntil: number, val?: xdr.LedgerEntryData) {
    const id = key.toXdr('base64');
    this.ttl.set(id, liveUntil);
    this.vals.set(id, val ?? instanceEntry(MANDATE, WASM));
  }

  ledgerEntries(keys: readonly xdr.LedgerKey[]): Promise<LedgerEntriesRead> {
    if (this.fail !== undefined) return Promise.reject(this.fail);
    const ids = keys.map((k) => k.toXdr('base64'));
    this.reads.push(ids);
    const entries = ids.flatMap((id) => {
      const until = this.ttl.get(id);
      const val = this.vals.get(id);
      return until === undefined || val === undefined
        ? []
        : [{ key: xdr.LedgerKey.fromXdr(id, 'base64'), val, liveUntilLedgerSeq: until }];
    });
    return Promise.resolve({ latestLedger: this.latestLedger, entries });
  }

  loadAccount(address: string): Promise<Account> {
    return Promise.resolve(new Account(address, '41'));
  }

  prepare(tx: Transaction): Promise<Transaction> {
    this.prepared.push(tx);
    return Promise.resolve(tx);
  }

  submit(tx: Transaction): Promise<Submitted> {
    return Promise.resolve({ hash: Buffer.from(tx.hash()).toString('hex'), status: this.status });
  }
}

const o = () => callOptions('test');
const codeKey = () =>
  xdr.LedgerKey.contractCode(new xdr.LedgerKeyContractCode({ hash: WASM })).toXdr('base64');

describe('ledger keys', () => {
  it('builds the keys testnet holds for the demo mandate', () => {
    expect(instanceKey(MANDATE).toXdr('base64')).toBe(TESTNET_KEYS.instance);
    expect(balanceKey(USDC, MANDATE).toXdr('base64')).toBe(TESTNET_KEYS.balance);
    expect(allowedKey(MANDATE, { recipientRef: REF_1, destination: DEST_1 }).toXdr('base64')).toBe(
      TESTNET_KEYS.allowed,
    );
    expect(dailyKey(MANDATE, REF_1).toXdr('base64')).toBe(TESTNET_KEYS.daily);
  });
});

describe('StellarEntryKeeper.entries', () => {
  it('reads the instance first, then its code, balance, allowlist and day usage', async () => {
    const net = new FakeNetwork();
    net.put(instanceKey(MANDATE), net.latestLedger + 329_482);
    net.put(xdr.LedgerKey.fromXdr(codeKey(), 'base64'), net.latestLedger + 433_401);
    net.put(balanceKey(USDC, MANDATE), net.latestLedger + 312_202);
    net.put(allowedKey(MANDATE, { recipientRef: REF_1, destination: DEST_1 }), 0);
    net.put(dailyKey(MANDATE, REF_1), net.latestLedger);
    const keeper = new StellarEntryKeeper({ network: net });

    const read = await keeper.entries(
      {
        contract: MANDATE,
        asset: USDC,
        recipients: [
          { recipientRef: REF_1, destination: DEST_1 },
          { recipientRef: REF_1, destination: DEST_1 },
          { recipientRef: REF_2, destination: DEST_2 },
        ],
      },
      o(),
    );

    expect(net.reads[0]).toEqual([TESTNET_KEYS.instance]);
    expect(read.latestLedger).toBe(5_932_880);
    expect(read.entries.map((e) => [e.kind, e.state, e.ledgersLeft])).toEqual([
      ['instance', 'live', 329_482],
      ['code', 'live', 433_401],
      ['balance', 'live', 312_202],
      ['allowed', 'archived', 0],
      ['allowed', 'missing', 0],
      ['daily', 'live', 0],
      ['daily', 'missing', 0],
    ]);
    expect(read.entries[0]?.id).toBe(TESTNET_KEYS.instance);
    expect(read.entries[1]?.id).toBe(codeKey());
    expect(new Set(read.entries.map((e) => e.id)).size).toBe(read.entries.length);
  });

  it('reads a factory as its instance and code only', async () => {
    const net = new FakeNetwork();
    net.put(instanceKey(MANDATE), net.latestLedger + 10);
    const keeper = new StellarEntryKeeper({ network: net });
    const read = await keeper.entries({ contract: MANDATE, asset: null, recipients: [] }, o());
    expect(read.entries.map((e) => [e.kind, e.state])).toEqual([
      ['instance', 'live'],
      ['code', 'missing'],
    ]);
  });

  it('has no code entry for a missing instance or a built in contract', async () => {
    const net = new FakeNetwork();
    const keeper = new StellarEntryKeeper({ network: net });
    const none = await keeper.entries({ contract: MANDATE, asset: null, recipients: [] }, o());
    expect(none.entries.map((e) => [e.kind, e.state])).toEqual([['instance', 'missing']]);

    net.put(instanceKey(USDC), net.latestLedger + 5, instanceEntry(USDC, null));
    const sac = await keeper.entries({ contract: USDC, asset: null, recipients: [] }, o());
    expect(sac.entries.map((e) => e.kind)).toEqual(['instance']);
  });

  it('refuses an address that is not a contract and maps network failures', async () => {
    const net = new FakeNetwork();
    const keeper = new StellarEntryKeeper({ network: net });
    expect(() => keeper.entries({ contract: 'nope', asset: null, recipients: [] }, o())).toThrow(
      expect.objectContaining({ code: 'INVALID_ADDRESS' }) as Error,
    );
    net.fail = new Error('socket hang up');
    await expect(
      keeper.entries({ contract: MANDATE, asset: null, recipients: [] }, o()),
    ).rejects.toMatchObject({ name: 'ChainError', code: 'UNAVAILABLE' });
  });
});

describe('StellarEntryKeeper.extend and restore', () => {
  it('extends with a read only footprint, paid and signed by the payer', async () => {
    const net = new FakeNetwork();
    const keeper = new StellarEntryKeeper({ network: net });
    const ids = [TESTNET_KEYS.instance, TESTNET_KEYS.balance];

    const { txHash } = await keeper.extend(ids, 1_036_800, payer, o());

    const tx = net.prepared[0];
    if (tx === undefined) throw new Error('nothing was prepared');
    expect(txHash).toBe(Buffer.from(tx.hash()).toString('hex'));
    expect(tx.source).toBe(payer.publicKey);
    expect(tx.operations).toEqual([
      expect.objectContaining({ type: 'extendFootprintTtl', extendTo: 1_036_800 }),
    ]);
    expect(footprint(tx)).toEqual({ readOnly: ids, readWrite: [] });
    expect(tx.signatures).toHaveLength(1);
    expect(tx.signatures.every((s) => payerKeypair.verify(tx.hash(), s.signature))).toBe(true);
  });

  it('restores with a read write footprint', async () => {
    const net = new FakeNetwork();
    const keeper = new StellarEntryKeeper({ network: net });
    await keeper.restore([TESTNET_KEYS.allowed], payer, o());
    const tx = net.prepared[0];
    if (tx === undefined) throw new Error('nothing was prepared');
    expect(tx.operations).toEqual([expect.objectContaining({ type: 'restoreFootprint' })]);
    expect(footprint(tx)).toEqual({ readOnly: [], readWrite: [TESTNET_KEYS.allowed] });
  });

  it('reports a transaction the network refused, with its hash', async () => {
    const net = new FakeNetwork();
    net.status = 'FAILED';
    const keeper = new StellarEntryKeeper({ network: net });
    const failed = keeper.extend([TESTNET_KEYS.instance], 100, payer, o());
    await expect(failed).rejects.toBeInstanceOf(ChainError);
    await expect(failed).rejects.toMatchObject({
      code: 'TX_FAILED',
      txHash: expect.stringMatching(/^[0-9a-f]{64}$/) as string,
    });
  });

  it('refuses ledger counts the network would refuse and ids that are not keys', () => {
    const keeper = new StellarEntryKeeper({ network: new FakeNetwork() });
    expect(keeper.maxExtendLedgers).toBe(MAX_EXTEND_LEDGERS);
    for (const bad of [0, -1, 1.5, MAX_EXTEND_LEDGERS + 1]) {
      expect(() => keeper.extend([TESTNET_KEYS.instance], bad, payer, o())).toThrow(RangeError);
    }
    expect(() => keeper.extend([], 100, payer, o())).toThrow(RangeError);
    expect(() => keeper.restore(['not a key'], payer, o())).toThrow(RangeError);
  });
});
