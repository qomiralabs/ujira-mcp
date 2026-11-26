// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The demo's console routes: test XLM, the USDC trustline, the faucet and
// test recipients, served through the console when the demo runs.

import { join } from 'node:path';

import { TransactionBuilder, type Transaction } from '@stellar/stellar-sdk';
import { afterEach, describe, expect, it } from 'vitest';

import { TESTNET_PASSPHRASE } from '../../src/chain/stellar/gateway.js';
import {
  api,
  demoSettings,
  errorCode,
  keypair,
  owner,
  startConsole,
  stop,
  treasury,
  type World,
} from '../console-helpers.js';
import { MANDATE, UNIT } from '../fake-rpc.js';
import { alice, bob } from '../helpers.js';

const open: World[] = [];

afterEach(async () => {
  await Promise.all(open.splice(0).map((w) => stop(w.server)));
});

async function start(options: Parameters<typeof startConsole>[0] = {}) {
  const w = await startConsole(options);
  open.push(w);
  return w;
}

const usdc = (n: bigint) => (n * UNIT).toString();
const ip = (n: number) => ({ 'x-real-ip': `203.0.113.${n}` });

describe('demo: onboarding and the faucet', () => {
  it('asks friendbot for a new account only, within a per address cap', async () => {
    const { base, chain } = await start();
    expect((await api(base, '/api/onboard/xlm', { address: owner.publicKey() })).json).toEqual({
      ok: true,
    });
    expect(chain.funded).toEqual([]);
    expect((await api(base, '/api/onboard/xlm', { address: alice }, ip(3))).json).toEqual({
      ok: true,
    });
    expect(chain.funded).toEqual([alice]);
    await api(base, '/api/onboard/xlm', { address: bob }, ip(3));
    const third = await api(base, '/api/onboard/xlm', { address: keypair('c').publicKey() }, ip(3));
    expect(third.status).toBe(429);
  });

  it('builds an unsigned USDC trustline for the wallet', async () => {
    const { base, settings } = await start();
    const { json } = await api(base, '/api/onboard/trustline', { address: owner.publicKey() });
    const tx = TransactionBuilder.fromXdr(String(json['xdr']), TESTNET_PASSPHRASE) as Transaction;
    expect(tx.source).toBe(owner.publicKey());
    expect(tx.signatures).toHaveLength(0);
    const op = tx.operations[0];
    expect(op?.type).toBe('changeTrust');
    if (op?.type === 'changeTrust' && 'getCode' in op.line) {
      expect(op.line.getCode()).toBe('USDC');
      expect(op.line.getIssuer()).toBe(settings.usdc.issuer);
    }
    expect(String(json['description'])).toContain('USDC trustline');
    const missing = await api(base, '/api/onboard/trustline', { address: alice });
    expect(missing.status).toBe(400);
    expect(errorCode(missing.json)).toBe('account_not_found');
  });

  /** The single payment a faucet transaction makes, as [destination, amount]. */
  function paymentOf(tx: Transaction | undefined): [string, string] | null {
    const op = tx?.operations[0];
    return op?.type === 'payment' ? [op.destination, op.amount] : null;
  }

  it('tops an empty wallet up to the target from the treasury', async () => {
    const { base, chain, registry } = await start();
    const who = keypair('reviewer').publicKey();
    chain.accounts.set(who, { exists: true, xlm: '1.0', usdc: 0n });
    const first = await api(base, '/api/onboard/usdc', { address: who }, ip(10));
    expect(first.status).toBe(200);
    expect(first.json).toMatchObject({
      amount: usdc(50n),
      balance: usdc(50n),
      target: usdc(50n),
      cooldownSeconds: 600,
    });
    const paid = chain.submitted.at(-1);
    expect(paid?.source).toBe(treasury.publicKey);
    expect(paid?.signatures).toHaveLength(1);
    expect(paymentOf(paid)).toEqual([who, '50.0000000']);
    expect(registry.faucetClaim(who)?.hash).toBe(first.json['hash']);
  });

  it('sends only the difference to the target, in exact minor units', async () => {
    const { base, chain } = await start();
    const who = keypair('partly-spent').publicKey();
    // 12.3456789 USDC left: the top up must be exactly 37.6543211, with no float rounding.
    chain.accounts.set(who, { exists: true, xlm: '1.0', usdc: 123_456_789n });
    const res = await api(base, '/api/onboard/usdc', { address: who }, ip(12));
    expect(res.status).toBe(200);
    expect(res.json['amount']).toBe('376543211');
    expect(typeof res.json['amount']).toBe('string');
    expect(paymentOf(chain.submitted.at(-1))).toEqual([who, '37.6543211']);
    // One minor unit short of the target still gets that one unit.
    const almost = keypair('almost-full').publicKey();
    chain.accounts.set(almost, { exists: true, xlm: '1.0', usdc: 50n * UNIT - 1n });
    const tiny = await api(base, '/api/onboard/usdc', { address: almost }, ip(13));
    expect(tiny.json['amount']).toBe('1');
    expect(paymentOf(chain.submitted.at(-1))).toEqual([almost, '0.0000001']);
  });

  it('says no top up is needed at or above the target, and sends nothing', async () => {
    const { base, chain, registry } = await start();
    const full = keypair('full').publicKey();
    const rich = keypair('rich').publicKey();
    chain.accounts.set(full, { exists: true, xlm: '1', usdc: 50n * UNIT });
    chain.accounts.set(rich, { exists: true, xlm: '1', usdc: 75n * UNIT });
    for (const who of [full, rich]) {
      const res = await api(base, '/api/onboard/usdc', { address: who }, ip(14));
      expect(res.status).toBe(409);
      expect(errorCode(res.json)).toBe('faucet_not_needed');
      expect(registry.faucetClaim(who)).toBeUndefined();
    }
    expect(chain.submitted).toHaveLength(0);
    // Refusals that send nothing do not use up the caller's hourly top ups.
    const empty = keypair('empty').publicKey();
    chain.accounts.set(empty, { exists: true, xlm: '1', usdc: 0n });
    expect((await api(base, '/api/onboard/usdc', { address: empty }, ip(14))).status).toBe(200);
  });

  it('makes a wallet wait out the cooldown, then tops it up again', async () => {
    const { base, chain, rpc } = await start();
    const who = keypair('repeat').publicKey();
    chain.accounts.set(who, { exists: true, xlm: '1', usdc: 0n });
    expect((await api(base, '/api/onboard/usdc', { address: who }, ip(15))).status).toBe(200);
    // The wallet spends 40 of its 50 on a mandate.
    chain.accounts.set(who, { exists: true, xlm: '1', usdc: 10n * UNIT });

    rpc.now += 60n;
    const res = await fetch(`${base}/api/onboard/usdc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...ip(16) },
      body: JSON.stringify({ address: who }),
    });
    const body = (await res.json()) as { error: Record<string, unknown> };
    expect(res.status).toBe(429);
    expect(body.error['code']).toBe('faucet_cooldown');
    expect(body.error['retryAfterSeconds']).toBe(540);
    expect(body.error['message']).toContain('try again in 9 minutes');
    expect(res.headers.get('retry-after')).toBe('540');
    expect(chain.submitted).toHaveLength(1);

    rpc.now += 539n;
    const last = await api(base, '/api/onboard/usdc', { address: who }, ip(16));
    expect(errorCode(last.json)).toBe('faucet_cooldown');
    expect((last.json['error'] as Record<string, unknown>)['message']).toContain('1 second');

    rpc.now += 1n;
    const again = await api(base, '/api/onboard/usdc', { address: who }, ip(16));
    expect(again.status).toBe(200);
    expect(again.json['amount']).toBe(usdc(40n));
    expect(paymentOf(chain.submitted.at(-1))).toEqual([who, '40.0000000']);
  });

  it('refuses the faucet without a trustline, past the IP cap, and below the floor', async () => {
    const { base, chain } = await start();
    const a = keypair('a').publicKey();
    const b = keypair('b').publicKey();
    const c = keypair('c').publicKey();
    const d = keypair('d').publicKey();
    for (const who of [b, c, d]) chain.accounts.set(who, { exists: true, xlm: '1', usdc: 0n });
    chain.accounts.set(a, { exists: true, xlm: '1', usdc: null });
    const noLine = await api(base, '/api/onboard/usdc', { address: a }, ip(20));
    expect(errorCode(noLine.json)).toBe('trustline_missing');
    const missing = await api(base, '/api/onboard/usdc', { address: alice }, ip(20));
    expect(errorCode(missing.json)).toBe('account_not_found');
    expect((await api(base, '/api/onboard/usdc', { address: b }, ip(20))).status).toBe(200);
    expect((await api(base, '/api/onboard/usdc', { address: c }, ip(20))).status).toBe(200);
    const capped = await api(base, '/api/onboard/usdc', { address: d }, ip(20));
    expect(capped.status).toBe(429);
    expect(errorCode(capped.json)).toBe('rate_limited');

    // The floor is 100: 149 cannot cover a 50 top up, but it can cover 49.
    chain.accounts.set(treasury.publicKey, { exists: true, xlm: '1', usdc: 149n * UNIT });
    const empty = await api(base, '/api/onboard/usdc', { address: d }, ip(21));
    expect(empty.status).toBe(503);
    expect(errorCode(empty.json)).toBe('faucet_empty');
    chain.accounts.set(d, { exists: true, xlm: '1', usdc: 1n * UNIT });
    const fits = await api(base, '/api/onboard/usdc', { address: d }, ip(21));
    expect(fits.status).toBe(200);
    expect(fits.json['amount']).toBe(usdc(49n));
  });

  it('says a top up is already on its way while one is in flight', async () => {
    const { base, chain } = await start();
    const who = keypair('impatient').publicKey();
    chain.accounts.set(who, { exists: true, xlm: '1', usdc: 0n });
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const submit = chain.submit.bind(chain);
    chain.submit = async (tx) => {
      await gate;
      return submit(tx);
    };
    const first = api(base, '/api/onboard/usdc', { address: who }, ip(22));
    await new Promise((r) => setTimeout(r, 50));
    const second = await api(base, '/api/onboard/usdc', { address: who }, ip(22));
    expect(errorCode(second.json)).toBe('faucet_busy');
    release();
    expect((await first).status).toBe(200);
  });

  it('reports the faucet target and cooldown in the config', async () => {
    const { base } = await start({
      demo: demoSettings({ faucetAmount: 123_456_789n, faucetCooldownSeconds: 30 }),
    });
    const cfg = await api(base, '/api/config');
    expect(cfg.json['faucet']).toEqual({
      amount: '123456789',
      target: '123456789',
      cooldownSeconds: 30,
      enabled: true,
    });
  });

  it('turns the faucet off without a treasury key', async () => {
    const { treasury: unused, ...rest } = demoSettings();
    expect(unused).toBeDefined();
    const { base } = await start({ demo: rest });
    const cfg = await api(base, '/api/config');
    expect((cfg.json['faucet'] as { enabled: boolean }).enabled).toBe(false);
    const res = await api(base, '/api/onboard/usdc', { address: owner.publicKey() });
    expect(res.status).toBe(503);
    expect(errorCode(res.json)).toBe('faucet_disabled');
  });

  it('makes a test recipient and keeps its key only in the 600 wallet file', async () => {
    const fresh = keypair('test-recipient');
    const { base, chain, settings, wallets, lines } = await start({ keypairs: [fresh] });
    const res = await api(base, '/api/recipients/test', {}, ip(30));
    expect(res.json['address']).toBe(fresh.publicKey());
    expect(chain.funded).toEqual([fresh.publicKey()]);
    const tx = chain.submitted.at(-1);
    expect(tx?.source).toBe(fresh.publicKey());
    expect(tx?.operations[0]?.type).toBe('changeTrust');
    expect(wallets?.has(fresh.publicKey())).toBe(true);

    const { readFileSync, readdirSync, statSync } = await import('node:fs');
    const keyFile = join(settings.dataDir, 'test-wallets.json');
    expect(readFileSync(keyFile, 'utf8')).toContain(fresh.secret());
    if (process.platform !== 'win32') expect(statSync(keyFile).mode & 0o777).toBe(0o600);
    for (const f of readdirSync(settings.dataDir)) {
      if (f.endsWith('.json') && f !== 'test-wallets.json') {
        expect(readFileSync(join(settings.dataDir, f), 'utf8')).not.toContain(fresh.secret());
      }
    }

    // No route answers with the key, and no log line carries it.
    const seen: string[] = [JSON.stringify(res.json)];
    for (const path of [
      '/api/config',
      `/api/accounts/${fresh.publicKey()}`,
      `/api/mandates?principal=${owner.publicKey()}`,
      `/api/mandates/${MANDATE}`,
    ]) {
      seen.push(JSON.stringify((await api(base, path)).json));
    }
    for (const text of [...seen, ...lines]) {
      expect(text).not.toContain(fresh.secret());
      expect(text).not.toMatch(/S[A-Z2-7]{55}/);
    }
    expect(lines.some((l) => l.includes(fresh.publicKey()))).toBe(true);
    expect(JSON.stringify(wallets)).not.toContain(fresh.secret());
    const { inspect } = await import('node:util');
    expect(inspect(wallets)).not.toContain(fresh.secret());

    expect((await api(base, '/api/recipients/test', { extra: 1 }, ip(30))).status).toBe(400);
    expect((await api(base, '/api/recipients/test', {}, ip(30))).status).toBe(200);
    expect((await api(base, '/api/recipients/test', {}, ip(30))).status).toBe(429);
  });

  it('keeps no test recipient key when there is nowhere to recycle to', async () => {
    const fresh = keypair('no-store');
    const { base, settings } = await start({ keypairs: [fresh], wallets: false });
    expect((await api(base, '/api/recipients/test', {}, ip(31))).status).toBe(200);
    const { readFileSync, readdirSync } = await import('node:fs');
    for (const f of readdirSync(settings.dataDir)) {
      if (f.endsWith('.json')) {
        expect(readFileSync(join(settings.dataDir, f), 'utf8')).not.toContain(fresh.secret());
      }
    }
  });
});
