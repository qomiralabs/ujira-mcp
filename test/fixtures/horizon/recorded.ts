// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// Horizon answers recorded from Stellar testnet on 2026-11-27, kept as they
// came. They are the demo payout demo-20261113T1101-01 in
// evidence/testnet-run.json: its request transaction, which moved nothing,
// and its execute transaction, which paid 5 USDC from mandate CDEEDQ... to
// GDWQ.... Horizon keeps every ledger, so they can be fetched again.

import { readFileSync } from 'node:fs';

export const RECORDED = {
  network: 'stellar:testnet',
  mandate: 'CDEEDQ64YS6XHBTWC3QLS5JWOLI3LSO46VDDZE66FW6CZGHZNRDV4GZW',
  destination: 'GDWQCLVZKFKKIQGXOSRZRLOBJ4V5J6UQ2L5D3RC4Y3IGEJXFZ4VJFPLX',
  executeTx: '51b33498da3b4d2896c62a41eaaec94b5affdb859f2d17ae556cbbb6094ae587',
  executeLedger: 5708807,
  requestTx: '12409b924b64ac4fff955461fa13b36ce22c540282c1af2a163f3c00e6a0f9b9',
  amount: 50_000_000n,
  asset: 'USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
} as const;

export type RecordedAnswer =
  'execute-tx' | 'execute-ops' | 'request-tx' | 'request-ops' | 'not-found';

export function horizonFixture(name: RecordedAnswer): unknown {
  return JSON.parse(readFileSync(new URL(`./${name}.json`, import.meta.url), 'utf8'));
}
