// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// Keeps a contract's ledger entries from archiving. Soroban rents storage by
// time: each persistent entry lives a number of ledgers, then it is archived
// and the next transaction that touches it pays to restore it first.
//
// A mandate's money is not in the mandate. It is the asset contract's Balance
// entry for the mandate's address, with its own time to live, so that entry
// is kept together with the mandate's instance and code. The mandate never
// extends its allowlist or day usage entries itself, so those archive a week
// after they were last written unless something extends them.
//
// Payout records and their tombstones are left alone on purpose. They live
// until the payout expires plus a day and then archive, which is safe since
// an archived tombstone still blocks its payout id, and keeping every payout
// ever made alive would grow the rent without end.

import {
  Address,
  BASE_FEE,
  Networks,
  Operation,
  SorobanDataBuilder,
  TransactionBuilder,
  xdr,
  type Transaction,
} from '@stellar/stellar-sdk';

import {
  ChainError,
  withDeadline,
  type AllowEntry,
  type CallOptions,
  type EntryKeeper,
  type KeepAliveTarget,
  type KeptEntry,
  type KeptEntryKind,
  type TxSigner,
} from '../adapter.js';
import { toChainError } from './adapter.js';
import type { LedgerEntriesRead, StellarNetworkPort } from './network.js';

/**
 * The network's max_entry_ttl is 3,110,400 ledgers, about 180 days, on
 * testnet and pubnet alike, and an extension has to stay below it.
 */
export const MAX_EXTEND_LEDGERS = 3_110_399;
/** RPC getLedgerEntries takes at most 200 keys a call. */
const MAX_KEYS_PER_READ = 200;
/** Above the base fee, so a busy network still takes the transaction. */
const INCLUSION_FEE = String(Number(BASE_FEE) * 100);
const TX_TIMEOUT_SECONDS = 120;

export type KeeperNetwork = Pick<StellarNetworkPort, 'loadAccount' | 'prepare' | 'submit'> & {
  ledgerEntries(keys: readonly xdr.LedgerKey[]): Promise<LedgerEntriesRead>;
};

function persistent(contract: string, key: xdr.ScVal): xdr.LedgerKey {
  return xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: Address.fromString(contract).toScAddress(),
      key,
      durability: xdr.ContractDataDurability.persistent,
    }),
  );
}

// A #[contracttype] enum variant is stored as a vector of its name and fields.
function variant(name: string, ...fields: xdr.ScVal[]): xdr.ScVal {
  return xdr.ScVal.scvVec([xdr.ScVal.scvSymbol(name), ...fields]);
}

const refBytes = (ref: string) => xdr.ScVal.scvBytes(Buffer.from(ref, 'hex'));

export function instanceKey(contract: string): xdr.LedgerKey {
  return persistent(contract, xdr.ScVal.scvLedgerKeyContractInstance());
}

/** What the asset contract holds for `holder`, the entry a mandate's balance lives in. */
export function balanceKey(asset: string, holder: string): xdr.LedgerKey {
  return persistent(asset, variant('Balance', Address.fromString(holder).toScVal()));
}

/**
 * One allowlist pair. The mandate keys it by recipient, base address and tag;
 * the console only allows plain G addresses, which carry no tag.
 */
export function allowedKey(contract: string, entry: AllowEntry): xdr.LedgerKey {
  return persistent(
    contract,
    variant(
      'Allowed',
      refBytes(entry.recipientRef),
      Address.fromString(entry.destination).toScVal(),
      xdr.ScVal.scvVoid(),
    ),
  );
}

export function dailyKey(contract: string, recipientRef: string): xdr.LedgerKey {
  return persistent(contract, variant('Daily', refBytes(recipientRef)));
}

/** The Wasm a contract instance runs, or null for a built in contract such as an asset. */
function wasmHashOf(data: xdr.LedgerEntryData): xdr.Hash | null {
  if (data.type !== 'contractData') return null;
  const value = data.contractData.val;
  if (value.type !== 'scvContractInstance') return null;
  const executable = value.instance.executable;
  return executable.type === 'contractExecutableWasm' ? executable.wasmHash : null;
}

const text = (key: xdr.LedgerKey) => key.toXdr('base64');

function chunks<T>(list: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let at = 0; at < list.length; at += size) out.push(list.slice(at, at + size));
  return out;
}

function keysOf(ids: readonly string[]): xdr.LedgerKey[] {
  if (ids.length === 0) throw new RangeError('name at least one entry');
  return ids.map((id) => {
    try {
      return xdr.LedgerKey.fromXdr(id, 'base64');
    } catch {
      throw new RangeError('an entry id is not a ledger key');
    }
  });
}

export interface StellarEntryKeeperOptions {
  readonly network: KeeperNetwork;
  readonly passphrase?: string;
}

export class StellarEntryKeeper implements EntryKeeper {
  readonly maxExtendLedgers = MAX_EXTEND_LEDGERS;
  private readonly network: KeeperNetwork;
  private readonly passphrase: string;

  constructor(options: StellarEntryKeeperOptions) {
    this.network = options.network;
    this.passphrase = options.passphrase ?? Networks.TESTNET;
  }

  /**
   * Every entry the target needs, each once, in a stable order: instance,
   * code, balance, then allowlist pairs and day usage. The code key comes
   * from the instance, so the instance is read first.
   */
  entries(
    target: KeepAliveTarget,
    o: CallOptions,
  ): Promise<{ readonly latestLedger: number; readonly entries: readonly KeptEntry[] }> {
    let instance: xdr.LedgerKey;
    try {
      instance = instanceKey(target.contract);
    } catch (error) {
      throw new ChainError('INVALID_ADDRESS', 'The contract address is not valid', {
        cause: error,
      });
    }
    return withDeadline(
      o,
      'read ledger entries',
      async () => {
        const first = await this.network.ledgerEntries([instance]);
        const found = first.entries.find((e) => text(e.key) === text(instance));
        const hash = found === undefined ? null : wasmHashOf(found.val);
        const named: [KeptEntryKind, xdr.LedgerKey][] = [];
        if (hash !== null) {
          named.push(['code', xdr.LedgerKey.contractCode(new xdr.LedgerKeyContractCode({ hash }))]);
        }
        if (target.asset !== null) {
          named.push(['balance', balanceKey(target.asset, target.contract)]);
        }
        for (const r of target.recipients) named.push(['allowed', allowedKey(target.contract, r)]);
        for (const r of target.recipients) {
          named.push(['daily', dailyKey(target.contract, r.recipientRef)]);
        }
        const seen = new Set([text(instance)]);
        const rest = named.filter(([, key]) => {
          const id = text(key);
          if (seen.has(id)) return false;
          seen.add(id);
          return true;
        });

        let latestLedger = first.latestLedger;
        const live = new Map<string, number>();
        for (const e of first.entries) live.set(text(e.key), e.liveUntilLedgerSeq);
        for (const part of chunks(rest, MAX_KEYS_PER_READ)) {
          const read = await this.network.ledgerEntries(part.map(([, key]) => key));
          latestLedger = Math.max(latestLedger, read.latestLedger);
          for (const e of read.entries) live.set(text(e.key), e.liveUntilLedgerSeq);
        }

        const entries = [['instance', instance] as const, ...rest].map(([kind, key]): KeptEntry => {
          const id = text(key);
          const until = live.get(id);
          if (until === undefined) return { kind, id, state: 'missing', ledgersLeft: 0 };
          if (until < latestLedger) return { kind, id, state: 'archived', ledgersLeft: 0 };
          return { kind, id, state: 'live', ledgersLeft: until - latestLedger };
        });
        return { latestLedger, entries };
      },
      (error) => toChainError(error, 'read ledger entries'),
    );
  }

  extend(
    ids: readonly string[],
    ledgers: number,
    payer: TxSigner,
    o: CallOptions,
  ): Promise<{ readonly txHash: string }> {
    if (!Number.isSafeInteger(ledgers) || ledgers < 1 || ledgers > MAX_EXTEND_LEDGERS) {
      throw new RangeError(`extend by 1 to ${String(MAX_EXTEND_LEDGERS)} ledgers`);
    }
    const keys = keysOf(ids);
    return this.send(
      'extend ledger entries',
      payer,
      o,
      Operation.extendFootprintTtl({ extendTo: ledgers }),
      new SorobanDataBuilder().setReadOnly(keys).build(),
    );
  }

  restore(
    ids: readonly string[],
    payer: TxSigner,
    o: CallOptions,
  ): Promise<{ readonly txHash: string }> {
    const keys = keysOf(ids);
    return this.send(
      'restore ledger entries',
      payer,
      o,
      Operation.restoreFootprint({}),
      new SorobanDataBuilder().setReadWrite(keys).build(),
    );
  }

  /**
   * The payer is the source, so it pays the fee and the rent. The network
   * prepares the transaction from a fresh simulation, which sets the rent for
   * the entries' size and the ledgers asked for.
   */
  private send(
    what: string,
    payer: TxSigner,
    o: CallOptions,
    op: xdr.Operation,
    data: xdr.SorobanTransactionData,
  ): Promise<{ readonly txHash: string }> {
    return withDeadline(
      o,
      what,
      async () => {
        const account = await this.network.loadAccount(payer.publicKey);
        const tx: Transaction = new TransactionBuilder(account, {
          fee: INCLUSION_FEE,
          networkPassphrase: this.passphrase,
        })
          .addOperation(op)
          .setSorobanData(data)
          .setTimeout(TX_TIMEOUT_SECONDS)
          .build();
        const prepared = await this.network.prepare(tx);
        payer.sign(prepared);
        const sent = await this.network.submit(prepared);
        if (sent.status !== 'SUCCESS') {
          throw new ChainError('TX_FAILED', `The network refused to ${what} (${sent.hash})`, {
            txHash: sent.hash,
          });
        }
        return { txHash: sent.hash };
      },
      (error) => toChainError(error, what),
    );
  }
}
