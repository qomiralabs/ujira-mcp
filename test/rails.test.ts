// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// Rail ids and the old names that still have to work: connectors that send
// usdc, the dashboard, and receipt files an older build wrote or will read.

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { WALLET_RAIL, legacyRailName, railFromLegacy, railName } from '../src/rails/rail.js';
import { ReceiptLog, type Receipt } from '../src/receipts/log.js';
import { MANDATE, UNIT } from './fake-rpc.js';
import { alice, setup } from './helpers.js';

const usdc = (n: bigint) => (n * UNIT).toString();

describe('rail ids', () => {
  it('reads the old names as the rails they meant, and anything else as itself', () => {
    expect(railFromLegacy('usdc')).toBe(WALLET_RAIL);
    expect(railFromLegacy('sdp')).toBe('demo.sdp');
    expect(railFromLegacy(WALLET_RAIL)).toBe(WALLET_RAIL);
    expect(railFromLegacy('partner.bank')).toBe('partner.bank');
    // Names an object already has are not rails.
    expect(railFromLegacy('constructor')).toBe('constructor');
    expect(railFromLegacy('__proto__')).toBe('__proto__');
  });

  it('gives the old name back for readers that only know old names', () => {
    expect(legacyRailName(WALLET_RAIL)).toBe('usdc');
    expect(legacyRailName('demo.sdp')).toBe('sdp');
    expect(legacyRailName('partner.bank')).toBe('partner.bank');
  });

  it('refuses rail names that are not ids', () => {
    for (const bad of ['', 'USDC', 'stellar..wallet', '.wallet', 'a b', 'x'.repeat(65)]) {
      expect(railName.safeParse(bad).success, bad).toBe(false);
    }
    expect(railName.parse('usdc')).toBe(WALLET_RAIL);
  });

  it('pays through the wallet rail by default, by its id or by its old name', async () => {
    const { engine } = setup();
    const byDefault = await engine.quotePayout({ recipient: alice, amount: usdc(1n) });
    const byId = await engine.quotePayout({
      recipient: alice,
      amount: usdc(1n),
      rail: WALLET_RAIL,
    });
    const byOldName = await engine.quotePayout({
      recipient: alice,
      amount: usdc(1n),
      rail: 'usdc',
    });
    expect(byDefault.rail).toBe(WALLET_RAIL);
    expect(byId).toEqual(byDefault);
    expect(byOldName).toEqual(byDefault);
  });
});

describe('the receipt file', () => {
  const receipt = (task: string, rail: string) => ({
    task_id: task,
    mandate: MANDATE,
    principal: alice,
    agent: alice,
    network: 'testnet',
    recipient: alice,
    destination: alice,
    amount: '10',
    asset: 'USDC',
    rail,
    outcome: 'paid',
    created_at: '2026-11-20T10:00:00.000Z',
    updated_at: '2026-11-20T10:00:00.000Z',
  });

  it('reads a file an older build wrote, with the old rail names', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'ujira-rails-')), 'receipts.json');
    writeFileSync(
      path,
      JSON.stringify({ version: 1, receipts: [receipt('a', 'usdc'), receipt('b', 'sdp')] }),
    );
    const log = new ReceiptLog(path);
    expect((await log.find(MANDATE, 'a'))?.rail).toBe(WALLET_RAIL);
    expect((await log.find(MANDATE, 'b'))?.rail).toBe('demo.sdp');
  });

  it('keeps the old names on disk, so a rollback can still read it', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'ujira-rails-')), 'receipts.json');
    const log = new ReceiptLog(path);
    const fresh: Receipt = { ...receipt('c', WALLET_RAIL), amount: 10n, outcome: 'paid' };
    await log.upsert(fresh);
    await log.upsert({ ...fresh, task_id: 'd', rail: 'demo.sdp' });
    const file = JSON.parse(readFileSync(path, 'utf8')) as { receipts: { rail: string }[] };
    expect(file.receipts.map((r) => r.rail)).toEqual(['usdc', 'sdp']);
    expect((await log.list(MANDATE)).map((r) => r.rail).sort()).toEqual(['demo.sdp', WALLET_RAIL]);
  });
});
