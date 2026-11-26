// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// Opt in, against testnet: reads the live time to live of the public demo
// mandate's entries and the factory's, and prints them. With a fee sponsor
// key and UJIRA_TESTNET_KEEPALIVE_SEND=1 it also runs one keep alive pass,
// paid by that key, and checks the entries afterwards. When the key signs
// for another account, UJIRA_TESTNET_PAYER_ACCOUNT names that account.
//
//   UJIRA_TESTNET=1 npx vitest run test/keep-alive.testnet.test.ts
//   UJIRA_TESTNET=1 UJIRA_TESTNET_KEEPALIVE_SEND=1 UJIRA_FEE_SPONSOR_KEY_FILE=... npx vitest run test/keep-alive.testnet.test.ts

import { describe, expect, it } from 'vitest';

import { callOptions, type KeptEntry } from '../src/chain/adapter.js';
import { StellarChainAdapter } from '../src/chain/stellar/adapter.js';
import { RpcGateway, TESTNET_RPC_URL } from '../src/chain/stellar/gateway.js';
import { signerFromEnv } from '../src/chain/stellar/keys.js';
import {
  StellarNetwork,
  TESTNET_FRIENDBOT_URL,
  TESTNET_HORIZON_URL,
} from '../src/chain/stellar/network.js';
import {
  TESTNET_FACTORY,
  TESTNET_USDC_CONTRACT,
  TESTNET_USDC_ISSUER,
} from '../src/chain/stellar/testnet.js';
import { StellarEntryKeeper } from '../src/chain/stellar/ttl.js';
import { MandateKeepAlive, loadKeepAliveSettings } from '../src/worker/keep-alive.js';

const DEMO_MANDATE = 'CDEEDQ64YS6XHBTWC3QLS5JWOLI3LSO46VDDZE66FW6CZGHZNRDV4GZW';
const DEMO_RECIPIENTS = [
  [
    'a5af47dc553b19356f6fd85bdabb3be0256fb70fbc800ce3d3100508609b76a7',
    'GDWQCLVZKFKKIQGXOSRZRLOBJ4V5J6UQ2L5D3RC4Y3IGEJXFZ4VJFPLX',
  ],
  [
    'f4aaf5afaf4b5ef3698f2b9d28791174954f8d075c50c3e5d4097c447a97dd35',
    'GD3GVK2SYUMIAHMRCC5ZYEAMQW6LIKC4YJ57D7A474GXIVCYKPC6XRQ3',
  ],
  [
    'd75b056f3861f7bf82c3d298e16b369da6df053240596100ebee6240960835d2',
    'GCF3NTSN3MT2MR4E2F6OI4FTRAAXI462LSVBRYR5ARK2UXAZO4HWCUK6',
  ],
].map(([recipientRef = '', destination = '']) => ({ recipientRef, destination }));
const LEDGERS_PER_DAY = 17_280;

const on = process.env['UJIRA_TESTNET'] === '1';
const send = process.env['UJIRA_TESTNET_KEEPALIVE_SEND'] === '1';

const network = new StellarNetwork({
  rpcUrl: process.env['UJIRA_RPC_URL'] ?? TESTNET_RPC_URL,
  horizonUrl: TESTNET_HORIZON_URL,
  friendbotUrl: TESTNET_FRIENDBOT_URL,
});
const keeper = new StellarEntryKeeper({ network });

function table(name: string, latestLedger: number, entries: readonly KeptEntry[]): string {
  const rows = entries.map(
    (e) =>
      `${name} ${e.kind}: ${e.state}, ${String(e.ledgersLeft)} ledgers left, about ${(e.ledgersLeft / LEDGERS_PER_DAY).toFixed(1)} days`,
  );
  return [`latest ledger ${String(latestLedger)}`, ...rows].join('\n');
}

async function readAll() {
  const mandate = await keeper.entries(
    { contract: DEMO_MANDATE, asset: TESTNET_USDC_CONTRACT, recipients: DEMO_RECIPIENTS },
    callOptions('testnet-ttl', 30_000),
  );
  const factory = await keeper.entries(
    { contract: TESTNET_FACTORY, asset: null, recipients: [] },
    callOptions('testnet-ttl', 30_000),
  );
  return { mandate, factory };
}

describe.skipIf(!on)('keep alive on testnet', () => {
  it('reads the demo mandate and factory entries', { timeout: 60_000 }, async () => {
    const { mandate, factory } = await readAll();
    console.log(table('mandate', mandate.latestLedger, mandate.entries));
    console.log(table('factory', factory.latestLedger, factory.entries));
    const kinds = mandate.entries.map((e) => e.kind);
    expect(kinds.slice(0, 3)).toEqual(['instance', 'code', 'balance']);
    expect(mandate.entries[0]?.state).not.toBe('missing');
    expect(factory.entries.map((e) => e.kind)).toEqual(['instance', 'code']);
  });

  it.skipIf(!send)('runs one pass paid by the fee sponsor', { timeout: 600_000 }, async () => {
    const key = signerFromEnv(process.env, 'UJIRA_FEE_SPONSOR');
    if (key === undefined) throw new Error('set UJIRA_FEE_SPONSOR_KEY_FILE or _SECRET');
    // The testnet fee sponsor account has its master key at weight 0 and is
    // signed for by another key, so the account can be named apart from it.
    const account = process.env['UJIRA_TESTNET_PAYER_ACCOUNT'];
    const payer =
      account === undefined || account === ''
        ? key
        : { publicKey: account, sign: key.sign.bind(key) };
    const settings = loadKeepAliveSettings();
    const adapter = new StellarChainAdapter({
      gateway: new RpcGateway({ readSource: payer.publicKey }),
      chain: network,
      factory: TESTNET_FACTORY,
      asset: { code: 'USDC', issuer: TESTNET_USDC_ISSUER, contract: TESTNET_USDC_CONTRACT },
    });
    const keepAlive = new MandateKeepAlive({
      keeper,
      mandates: () => [{ contract: DEMO_MANDATE, recipients: DEMO_RECIPIENTS }],
      status: async (contract) => {
        const { config, state } = await adapter.readMandate(
          contract,
          callOptions('testnet', 30_000),
        );
        return { active: !state.revoked && !state.expired, asset: config.asset };
      },
      shared: [TESTNET_FACTORY],
      payer,
      settings,
      log: (line) => {
        console.log(line);
      },
      callTimeoutMs: 120_000,
    });

    const run = await keepAlive.runOnce();
    console.log(`payer ${payer.publicKey}, transactions ${run.transactions.join(', ')}`);
    expect(run.failed).toBe(0);

    const after = await readAll();
    console.log(table('mandate after', after.mandate.latestLedger, after.mandate.entries));
    console.log(table('factory after', after.factory.latestLedger, after.factory.entries));
    for (const e of [...after.mandate.entries, ...after.factory.entries]) {
      if (e.state === 'missing') continue;
      expect(e.state, e.kind).toBe('live');
      expect(e.ledgersLeft, e.kind).toBeGreaterThanOrEqual(settings.thresholdLedgers);
    }
    expect(keepAlive.warningsFor(DEMO_MANDATE)).toEqual([]);

    const again = await keepAlive.runOnce();
    expect(again.transactions).toEqual([]);
  });
});
