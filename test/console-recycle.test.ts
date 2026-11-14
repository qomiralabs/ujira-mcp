// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';

import { Account, TransactionBuilder, type Transaction } from '@stellar/stellar-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { waitWords } from '../src/console/app.js';
import { ApiError } from '../src/console/errors.js';
import { ConsoleRegistry, MAX_FAUCET_CLAIMS } from '../src/console/registry.js';
import { Recycler } from '../src/console/recycler.js';
import { loadConsoleSettings, testWalletsPath } from '../src/console/settings.js';
import { TestWalletStore } from '../src/console/wallets.js';
import { TESTNET_PASSPHRASE } from '../src/stellar/gateway.js';
import { FakeChain, keypair, treasury, treasuryKey } from './console-helpers.js';
import { UNIT } from './fake-rpc.js';

const USDC = {
  code: 'USDC',
  issuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
};
const dir = () => mkdtempSync(join(tmpdir(), 'ujira-recycle-'));
const SECRET = /S[A-Z2-7]{55}/;

function paymentOf(tx: Transaction | undefined): [string, string, string] | null {
  const op = tx?.operations[0];
  if (op?.type !== 'payment') return null;
  return [tx?.source ?? '', op.destination, op.amount];
}

function setUp(over: { batch?: number } = {}) {
  const wallets = TestWalletStore.open(join(dir(), 'test-wallets.json'));
  const chain = new FakeChain();
  const lines: string[] = [];
  const recycler = new Recycler({
    wallets,
    chain,
    usdc: USDC,
    treasury: treasury.publicKey,
    log: (l) => lines.push(l),
    ...over,
  });
  return { wallets, chain, lines, recycler };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('test wallet store', () => {
  it('keeps keys in a 600 file across a restart and signs only for its own wallets', async () => {
    const path = join(dir(), 'test-wallets.json');
    const store = TestWalletStore.open(path);
    const a = keypair('wallet-a');
    await store.add(a, '2026-11-14T10:00:00.000Z');
    await store.add(a, '2026-11-14T10:00:01.000Z');
    expect(store.size).toBe(1);
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600);

    const again = TestWalletStore.open(path);
    expect(again.list()).toEqual([
      { address: a.publicKey(), createdAt: '2026-11-14T10:00:00.000Z' },
    ]);
    expect(JSON.stringify(again.list())).not.toMatch(SECRET);
    expect(JSON.stringify(again)).not.toMatch(SECRET);
    expect(inspect(again, { depth: 5 })).not.toMatch(SECRET);

    const tx = (source: string) =>
      new TransactionBuilder(new Account(source, '1'), {
        fee: '100',
        networkPassphrase: TESTNET_PASSPHRASE,
      })
        .setTimeout(30)
        .build();
    const mine = tx(a.publicKey());
    expect(again.sign(a.publicKey(), mine)).toBe(true);
    expect(mine.signatures).toHaveLength(1);
    const stranger = keypair('stranger').publicKey();
    const theirs = tx(stranger);
    expect(again.sign(stranger, theirs)).toBe(false);
    expect(theirs.signatures).toHaveLength(0);
  });

  it('drops the oldest wallets past its cap', async () => {
    const store = TestWalletStore.open(join(dir(), 'w.json'), 3);
    const keys = ['k1', 'k2', 'k3', 'k4', 'k5'].map((s) => keypair(s));
    for (const [i, k] of keys.entries()) await store.add(k, `2026-11-14T10:00:0${String(i)}Z`);
    expect(store.list().map((w) => w.address)).toEqual(keys.slice(2).map((k) => k.publicKey()));
    expect(store.has(keys[0]?.publicKey() ?? '')).toBe(false);
  });

  it('refuses a wallet file it cannot trust, without quoting it', () => {
    const d = dir();
    const leaked = keypair('leaked').secret();
    writeFileSync(join(d, 'bad.json'), `{"version":1,"wallets":[{"secret":"${leaked}"`);
    expect(() => TestWalletStore.open(join(d, 'bad.json'))).toThrow('not valid JSON');
    try {
      TestWalletStore.open(join(d, 'bad.json'));
    } catch (error) {
      expect(String(error)).not.toContain(leaked);
    }
    writeFileSync(join(d, 'shape.json'), '{"version":2,"wallets":[]}');
    expect(() => TestWalletStore.open(join(d, 'shape.json'))).toThrow('expected format');
    const other = keypair('other').publicKey();
    writeFileSync(
      join(d, 'mismatch.json'),
      JSON.stringify({ version: 1, wallets: [{ address: other, secret: leaked, createdAt: 'x' }] }),
    );
    expect(() => TestWalletStore.open(join(d, 'mismatch.json'))).toThrow('another address');
  });

  it('lives next to the registry in the data directory', () => {
    expect(testWalletsPath({ dataDir: '/data' })).toBe('/data/test-wallets.json');
  });
});

describe('recycler', () => {
  it('sends each known wallet its full USDC balance back to the treasury', async () => {
    const { wallets, chain, lines, recycler } = setUp();
    const paid = keypair('paid');
    const idle = keypair('idle');
    const gone = keypair('gone');
    const noLine = keypair('no-line');
    for (const k of [paid, idle, gone, noLine]) await wallets.add(k, '2026-11-14T10:00:00Z');
    chain.accounts.set(paid.publicKey(), { exists: true, xlm: '9999', usdc: 40_000_001n });
    chain.accounts.set(idle.publicKey(), { exists: true, xlm: '9999', usdc: 0n });
    chain.accounts.set(noLine.publicKey(), { exists: true, xlm: '9999', usdc: null });

    const round = await recycler.runOnce();
    expect(round.checked).toBe(4);
    expect(round.failed).toBe(0);
    expect(round.swept.map((s) => [s.address, s.amount])).toEqual([
      [paid.publicKey(), 40_000_001n],
    ]);
    expect(chain.submitted).toHaveLength(1);
    const tx = chain.submitted[0];
    expect(paymentOf(tx)).toEqual([paid.publicKey(), treasury.publicKey, '4.0000001']);
    expect(tx?.signatures).toHaveLength(1);
    // The wallet signs and pays its own fee; the treasury key is not involved.
    // Ed25519 signatures are deterministic, so the envelope must carry exactly this one.
    const envelope = Buffer.from(tx?.toXdr() ?? '', 'base64');
    const hash = tx?.hash() ?? Buffer.alloc(32);
    expect(envelope.includes(Buffer.from(paid.sign(hash)))).toBe(true);
    expect(envelope.includes(Buffer.from(treasuryKey.sign(hash)))).toBe(false);
    expect(lines).toEqual([
      `recycled 4.0000001 USDC from test wallet ${paid.publicKey()} to the faucet: ${round.swept[0]?.hash ?? ''}`,
    ]);
    for (const l of lines) expect(l).not.toMatch(SECRET);
  });

  it('never touches a wallet it did not make, even one holding USDC', async () => {
    const { wallets, chain, recycler } = setUp();
    const mine = keypair('mine');
    await wallets.add(mine, 'now');
    const reviewer = keypair('reviewer-wallet');
    chain.accounts.set(reviewer.publicKey(), { exists: true, xlm: '1', usdc: 500n * UNIT });
    chain.accounts.set(treasury.publicKey, { exists: true, xlm: '1', usdc: 900n * UNIT });
    chain.accounts.set(mine.publicKey(), { exists: true, xlm: '1', usdc: 2n * UNIT });
    const looked: string[] = [];
    const account = chain.account.bind(chain);
    chain.account = (address: string) => {
      looked.push(address);
      return account(address);
    };
    await recycler.runOnce();
    expect(looked).toEqual([mine.publicKey()]);
    expect(chain.submitted.map((t) => t.source)).toEqual([mine.publicKey()]);
  });

  it('logs a failed wallet by code and carries on with the rest', async () => {
    const { wallets, chain, lines, recycler } = setUp();
    const bad = keypair('bad');
    const good = keypair('good');
    await wallets.add(bad, 'now');
    await wallets.add(good, 'now');
    for (const k of [bad, good]) {
      chain.accounts.set(k.publicKey(), { exists: true, xlm: '1', usdc: UNIT });
    }
    const submit = chain.submit.bind(chain);
    chain.submit = (tx) => {
      chain.answers = tx.source === bad.publicKey() ? [{ status: 'FAILED' }] : [];
      return submit(tx);
    };
    const round = await recycler.runOnce();
    expect(round.failed).toBe(1);
    expect(round.swept.map((s) => s.address)).toEqual([good.publicKey()]);
    expect(lines).toContain(`recycle of test wallet ${bad.publicKey()} failed (recycle_failed)`);

    chain.account = () => Promise.reject(new Error(`boom ${bad.secret()}`));
    const down = await recycler.runOnce();
    expect(down.failed).toBe(2);
    expect(lines.at(-1)).toBe(`recycle of test wallet ${good.publicKey()} failed (internal_error)`);
    for (const l of lines) expect(l).not.toMatch(SECRET);

    chain.account = () => Promise.reject(new ApiError(502, 'horizon_unavailable', 'down'));
    await recycler.runOnce();
    expect(lines.at(-1)).toContain('(horizon_unavailable)');
  });

  it('looks at a bounded batch per round and reaches every wallet in turn', async () => {
    const { wallets, chain, recycler } = setUp({ batch: 2 });
    const keys = ['r1', 'r2', 'r3'].map((s) => keypair(s));
    for (const k of keys) await wallets.add(k, 'now');
    const looked: string[] = [];
    chain.account = (address: string) => {
      looked.push(address);
      return Promise.resolve({ exists: true, xlm: '1', usdc: 0n });
    };
    expect((await recycler.runOnce()).checked).toBe(2);
    expect((await recycler.runOnce()).checked).toBe(2);
    const [a, b, c] = keys.map((k) => k.publicKey());
    expect(looked).toEqual([a, b, c, a]);
  });

  it('shares a round in flight and runs on a timer until stopped', async () => {
    const { wallets, chain, recycler } = setUp();
    await wallets.add(keypair('timer'), 'now');
    let calls = 0;
    chain.account = () => {
      calls++;
      return Promise.resolve({ exists: true, xlm: '1', usdc: 0n });
    };
    const [one, two] = [recycler.runOnce(), recycler.runOnce()];
    expect(one).toBe(two);
    await one;
    expect(calls).toBe(1);

    vi.useFakeTimers();
    recycler.start(1_000);
    recycler.start(1_000);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(calls).toBe(4);
    recycler.stop();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(calls).toBe(4);
  });
});

describe('faucet bookkeeping', () => {
  it('keeps only the latest top up per address, bounded', async () => {
    const path = join(dir(), 'r.json');
    const r = ConsoleRegistry.open(path);
    const who = keypair('topper').publicKey();
    await r.recordFaucet({ address: who, hash: 'a'.repeat(64), at: '2026-11-14T10:00:00.000Z' });
    await r.recordFaucet({ address: who, hash: 'b'.repeat(64), at: '2026-11-14T10:20:00.000Z' });
    expect(r.faucetClaim(who)?.hash).toBe('b'.repeat(64));
    const file = JSON.parse(readFileSync(path, 'utf8')) as { faucet: unknown[] };
    expect(file.faucet).toHaveLength(1);
    expect(MAX_FAUCET_CLAIMS).toBeGreaterThan(1_000);
  });

  it('reads the cooldown and recycle interval from the environment', () => {
    const d = loadConsoleSettings({});
    expect([d.faucetAmount, d.faucetCooldownSeconds, d.recycleIntervalSeconds]).toEqual([
      500_000_000n,
      600,
      300,
    ]);
    const s = loadConsoleSettings({
      UJIRA_FAUCET_COOLDOWN_SECONDS: '0',
      UJIRA_RECYCLE_INTERVAL_SECONDS: '60',
    });
    expect([s.faucetCooldownSeconds, s.recycleIntervalSeconds]).toEqual([0, 60]);
    expect(() => loadConsoleSettings({ UJIRA_RECYCLE_INTERVAL_SECONDS: '5' })).toThrow(
      'UJIRA_RECYCLE_INTERVAL_SECONDS',
    );
    expect(() => loadConsoleSettings({ UJIRA_FAUCET_COOLDOWN_SECONDS: '-1' })).toThrow(
      'UJIRA_FAUCET_COOLDOWN_SECONDS',
    );
  });

  it('puts a wait in plain words', () => {
    expect(waitWords(1)).toBe('1 second');
    expect(waitWords(45)).toBe('45 seconds');
    expect(waitWords(60)).toBe('1 minute');
    expect(waitWords(61)).toBe('2 minutes');
    expect(waitWords(540)).toBe('9 minutes');
  });
});
