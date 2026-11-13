// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PayoutEngine } from '../src/engine/engine.js';
import { defaultRecipientRef } from '../src/ids.js';
import { MandateClient } from '../src/mandate/client.js';
import type { PayoutRail } from '../src/rails/rail.js';
import { UsdcRail } from '../src/rails/usdc.js';
import { ReceiptLog } from '../src/receipts/log.js';
import { FakeMandateRpc, MANDATE, agent, executor, testSigner } from './fake-rpc.js';

export const alice = testSigner('alice').publicKey;
export const bob = testSigner('bob').publicKey;
export const mallory = testSigner('mallory').publicKey;

export function setup(options: { rails?: (m: MandateClient) => PayoutRail[] } = {}) {
  const rpc = new FakeMandateRpc();
  for (const who of [alice, bob]) rpc.allowRecipient(defaultRecipientRef(who), who);
  const mandate = new MandateClient(rpc, MANDATE);
  const receipts = new ReceiptLog(join(mkdtempSync(join(tmpdir(), 'ujira-mcp-')), 'receipts.json'));
  const engine = new PayoutEngine({
    mandate,
    agent,
    rails: options.rails?.(mandate) ?? [new UsdcRail(mandate, executor)],
    receipts,
    assetCode: 'USDC',
    network: 'testnet',
    now: () => new Date(Number(rpc.now) * 1000),
  });
  return { rpc, mandate, receipts, engine };
}
