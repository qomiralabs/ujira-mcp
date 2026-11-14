// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

import { join } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  Account,
  Asset,
  Operation,
  TransactionBuilder,
  scValToNative,
  type Transaction,
} from '@stellar/stellar-sdk';
import { afterEach, describe, expect, it } from 'vitest';

import { defaultRecipientRef, payoutIdFor } from '../src/ids.js';
import { MandateClient } from '../src/mandate/client.js';
import { TESTNET_PASSPHRASE } from '../src/stellar/gateway.js';
import {
  api,
  consoleSettings,
  errorCode,
  keypair,
  mandateAddress,
  owner,
  sign,
  startConsole,
  stop,
  treasury,
  type World,
} from './console-helpers.js';
import { MANDATE, UNIT, agent, approver, executor } from './fake-rpc.js';
import { alice, bob } from './helpers.js';

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
const OTHER = 'CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA';

function firstArg<T>(list: readonly T[]): T {
  const first = list[0];
  if (first === undefined) throw new Error('expected an argument');
  return first;
}

async function submitSigned(base: string, envelope: string) {
  return api(base, '/api/tx/submit', { xdr: sign(envelope, owner) });
}

describe('console API: config and accounts', () => {
  it('serves the config the UI needs', async () => {
    const { base } = await start();
    const { status, json } = await api(base, '/api/config');
    expect(status).toBe(200);
    expect(json).toMatchObject({
      network: 'testnet',
      networkPassphrase: TESTNET_PASSPHRASE,
      explorerTxBase: 'https://stellar.expert/explorer/testnet/tx/',
      factory: 'CB4AYBA5NVQPVPNOWUCSZQK6ZIGOF7KSCS6SF6UV6D2OKPDXLHEPD4V7',
      asset: { code: 'USDC', decimals: 7 },
      agent: agent.publicKey,
      executor: executor.publicKey,
      sdpAvailable: false,
      sdpProofUrl: 'https://qomiralabs.github.io/ujira-demo/instaward.html',
      faucet: { amount: '500000000', target: '500000000', cooldownSeconds: 600, enabled: true },
    });
    expect(JSON.stringify(json)).not.toContain(treasury.publicKey);
  });

  it('reads an account, and says when it does not exist', async () => {
    const { base } = await start();
    const mine = await api(base, `/api/accounts/${owner.publicKey()}`);
    expect(mine.json).toEqual({
      address: owner.publicKey(),
      exists: true,
      xlm: '10000.0000000',
      usdc: usdc(1000n),
    });
    const none = await api(base, `/api/accounts/${alice}`);
    expect(none.json).toEqual({ address: alice, exists: false, xlm: null, usdc: null });
    const bad = await api(base, '/api/accounts/not-an-address');
    expect(bad.status).toBe(400);
    expect(errorCode(bad.json)).toBe('invalid_request');
  });

  it('answers unknown routes and wrong methods in the API error shape', async () => {
    const { base } = await start();
    const none = await api(base, '/api/nothing');
    expect(none.status).toBe(404);
    expect(none.json).toEqual({
      error: { code: 'not_found', message: 'There is no such API route' },
    });
    const wrong = await api(base, '/api/tx/build');
    expect(wrong.status).toBe(405);
    expect(errorCode(wrong.json)).toBe('method_not_allowed');
  });

  it('refuses a body that is not JSON, too large, or has unknown fields', async () => {
    const { base } = await start();
    const res = await fetch(`${base}/api/onboard/xlm`, { method: 'POST', body: '{nope' });
    expect(res.status).toBe(400);
    expect(errorCode((await res.json()) as Record<string, unknown>)).toBe('invalid_json');
    const big = await api(base, '/api/tx/submit', { xdr: 'A'.repeat(20_000) });
    expect(big.status).toBe(413);
    const extra = await api(base, '/api/onboard/xlm', { address: alice, secret: 'S...' });
    expect(extra.status).toBe(400);
    expect((extra.json['error'] as { message: string }).message).toContain(
      'unknown field(s): secret',
    );
    expect(JSON.stringify(extra.json)).not.toContain('S...');
  });

  it('rate limits every API caller per minute', async () => {
    const { base } = await start({ settings: consoleSettings({}, { apiCallsPerMinute: 2 }) });
    expect((await api(base, '/api/config', undefined, ip(1))).status).toBe(200);
    expect((await api(base, '/api/config', undefined, ip(1))).status).toBe(200);
    const third = await api(base, '/api/config', undefined, ip(1));
    expect(third.status).toBe(429);
    expect(errorCode(third.json)).toBe('rate_limited');
    expect((await api(base, '/api/config', undefined, ip(2))).status).toBe(200);
  });
});

describe('console API: onboarding', () => {
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
      settings: consoleSettings({ faucetAmount: 123_456_789n, faucetCooldownSeconds: 30 }),
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
    const { treasury: unused, ...rest } = consoleSettings();
    expect(unused).toBeDefined();
    const { base } = await start({ settings: rest });
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

describe('console API: building and relaying transactions', () => {
  const createParams = (over: Record<string, unknown> = {}) => ({
    budget: usdc(100n),
    perPaymentCap: usdc(10n),
    dailyCap: usdc(20n),
    approvalThreshold: usdc(5n),
    expiresAt: 1_800_000_000 + 30 * 86_400,
    ...over,
  });

  it('creates a mandate: build, sign, submit, then it is registered', async () => {
    const { base, chain } = await start({ register: false });
    const built = await api(base, '/api/tx/build', {
      action: 'create_mandate',
      source: owner.publicKey(),
      params: createParams(),
    });
    expect(built.status).toBe(200);
    expect(String(built.json['description'])).toContain('total budget 100 USDC');
    const tx = chain.prepared.at(-1);
    const op = tx?.operations[0];
    expect(op?.type).toBe('invokeHostFunction');
    if (op?.type !== 'invokeHostFunction' || op.func.type !== 'hostFunctionTypeInvokeContract') {
      throw new Error('expected a contract call');
    }
    const [config] = op.func.invokeContract.args.map((a) => scValToNative(a) as unknown);
    expect(config).toMatchObject({
      principal: owner.publicKey(),
      agents: [agent.publicKey],
      approvers: [owner.publicKey()],
      approvals_required: 1,
      executors: [executor.publicKey],
      recipient_mode: 1,
      max_fee_bps: 0,
    });

    chain.answers.push({ returnValue: mandateAddress(MANDATE) });
    const sent = await submitSigned(base, String(built.json['xdr']));
    expect(sent.json).toMatchObject({ status: 'SUCCESS', mandate: MANDATE, returnValue: MANDATE });
    const list = await api(base, `/api/mandates?principal=${owner.publicKey()}`);
    expect(list.json).toEqual({
      mandates: [
        { id: MANDATE, createdAt: expect.any(String) as unknown, createTx: sent.json['hash'] },
      ],
    });
    expect((await api(base, `/api/mandates?principal=${alice}`)).json).toEqual({ mandates: [] });
  });

  it('refuses rules the contract would refuse, in words', async () => {
    const { base } = await start();
    const over = await api(base, '/api/tx/build', {
      action: 'create_mandate',
      source: owner.publicKey(),
      params: createParams({ perPaymentCap: usdc(200n) }),
    });
    expect(errorCode(over.json)).toBe('invalid_rules');
    const past = await api(base, '/api/tx/build', {
      action: 'create_mandate',
      source: owner.publicKey(),
      params: createParams({ expiresAt: 1_800_000_000 }),
    });
    expect(errorCode(past.json)).toBe('invalid_rules');
    const self = await api(base, '/api/tx/build', {
      action: 'create_mandate',
      source: agent.publicKey,
      params: createParams(),
    });
    expect(errorCode(self.json)).toBe('role_conflict');
    const float = await api(base, '/api/tx/build', {
      action: 'create_mandate',
      source: owner.publicKey(),
      params: createParams({ budget: '10.5' }),
    });
    expect(errorCode(float.json)).toBe('invalid_request');
    const unknown = await api(base, '/api/tx/build', {
      action: 'mint',
      source: owner.publicKey(),
      params: {},
    });
    expect(unknown.status).toBe(400);
    expect(errorCode(unknown.json)).toBe('unknown_action');
  });

  it('allows recipients by name and stores the names once the transaction lands', async () => {
    const { base, chain, rpc, registry } = await start();
    const carol = keypair('carol').publicKey();
    const built = await api(base, '/api/tx/build', {
      action: 'allow_recipients',
      source: owner.publicKey(),
      params: {
        mandate: MANDATE,
        recipients: [
          { label: 'Alice', address: alice },
          { label: 'carol', address: carol },
        ],
      },
    });
    expect(built.status).toBe(200);
    // Alice is already allowed on chain, so only carol is sent, and Alice is named at once.
    expect(registry.mandate(MANDATE)?.recipients.map((r) => r.label)).toEqual(['Alice']);
    const op = chain.prepared.at(-1)?.operations[0];
    if (op?.type !== 'invokeHostFunction' || op.func.type !== 'hostFunctionTypeInvokeContract') {
      throw new Error('expected a contract call');
    }
    const entries = scValToNative(firstArg(op.func.invokeContract.args)) as {
      destination: string;
      recipient_ref: Uint8Array;
    }[];
    expect(
      entries.map((e) => [e.destination, Buffer.from(e.recipient_ref).toString('hex')]),
    ).toEqual([[carol, defaultRecipientRef(carol)]]);
    const sent = await submitSigned(base, String(built.json['xdr']));
    expect(sent.json['status']).toBe('SUCCESS');
    expect(registry.mandate(MANDATE)?.recipients).toEqual([
      { label: 'Alice', address: alice, recipientRef: defaultRecipientRef(alice) },
      { label: 'carol', address: carol, recipientRef: defaultRecipientRef(carol) },
    ]);
    rpc.allowRecipient(defaultRecipientRef(carol), carol);
    const view = await api(base, `/api/mandates/${MANDATE}`);
    expect(view.json['recipients']).toHaveLength(2);

    const again = await api(base, '/api/tx/build', {
      action: 'allow_recipients',
      source: owner.publicKey(),
      params: { mandate: MANDATE, recipients: [{ label: 'carol', address: carol }] },
    });
    expect(errorCode(again.json)).toBe('already_allowed');
    const taken = await api(base, '/api/tx/build', {
      action: 'allow_recipients',
      source: owner.publicKey(),
      params: { mandate: MANDATE, recipients: [{ label: 'carol', address: bob }] },
    });
    expect(errorCode(taken.json)).toBe('label_taken');
    const notOwner = await api(base, '/api/tx/build', {
      action: 'allow_recipients',
      source: alice,
      params: { mandate: MANDATE, recipients: [{ label: 'x', address: bob }] },
    });
    expect(notOwner.status).toBe(403);
    const addressLabel = await api(base, '/api/tx/build', {
      action: 'allow_recipients',
      source: owner.publicKey(),
      params: { mandate: MANDATE, recipients: [{ label: bob, address: bob }] },
    });
    expect(errorCode(addressLabel.json)).toBe('invalid_request');
  });

  it('allows the SDP distribution account next to each person when SDP is on', async () => {
    const distribution = keypair('sdp-distribution').publicKey();
    const { base, chain } = await start({
      sdp: {
        client: {} as never,
        distributionAccount: distribution,
        assetIssuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
      },
    });
    const carol = keypair('carol').publicKey();
    await api(base, '/api/tx/build', {
      action: 'allow_recipients',
      source: owner.publicKey(),
      params: { mandate: MANDATE, recipients: [{ label: 'carol', address: carol }] },
    });
    const op = chain.prepared.at(-1)?.operations[0];
    if (op?.type !== 'invokeHostFunction' || op.func.type !== 'hostFunctionTypeInvokeContract') {
      throw new Error('expected a contract call');
    }
    const entries = scValToNative(firstArg(op.func.invokeContract.args)) as {
      destination: string;
    }[];
    expect(entries.map((e) => e.destination)).toEqual([carol, distribution]);
    expect((await api(base, '/api/config')).json['sdpAvailable']).toBe(true);
  });

  it('builds each owner action as one call from the owner', async () => {
    const { base, chain } = await start();
    const payoutId = 'ab'.repeat(32);
    const cases: [string, Record<string, unknown>, string, unknown[]][] = [
      ['fund_mandate', { amount: usdc(50n) }, 'transfer', [owner.publicKey(), MANDATE, 50n * UNIT]],
      ['pause', {}, 'pause', [owner.publicKey()]],
      ['resume', {}, 'resume', []],
      ['revoke', {}, 'revoke', []],
      ['sweep', {}, 'sweep', [owner.publicKey()]],
      ['approve', { payoutId }, 'approve', [owner.publicKey(), Buffer.from(payoutId, 'hex')]],
      ['reject', { payoutId }, 'reject', [owner.publicKey(), Buffer.from(payoutId, 'hex')]],
      ['withdraw', { amount: usdc(1n) }, 'withdraw', [UNIT]],
    ];
    for (const [action, params, method, args] of cases) {
      const res = await api(base, '/api/tx/build', {
        action,
        source: owner.publicKey(),
        params: { mandate: MANDATE, ...params },
      });
      expect(res.status, action).toBe(200);
      const tx = chain.prepared.at(-1);
      expect(tx?.source).toBe(owner.publicKey());
      const op = tx?.operations[0];
      if (op?.type !== 'invokeHostFunction' || op.func.type !== 'hostFunctionTypeInvokeContract') {
        throw new Error('expected a contract call');
      }
      expect(op.func.invokeContract.functionName.toString()).toBe(method);
      const native = op.func.invokeContract.args.map((a) => {
        const v = scValToNative(a) as unknown;
        return v instanceof Uint8Array ? Buffer.from(v) : v;
      });
      expect(native).toEqual(args);
      expect(typeof res.json['description']).toBe('string');
    }
    const unknownMandate = await api(base, '/api/tx/build', {
      action: 'pause',
      source: owner.publicKey(),
      params: { mandate: OTHER },
    });
    expect(unknownMandate.status).toBe(404);
  });

  it('relays only console transactions, and only signed ones', async () => {
    const { base, chain } = await start();
    const payment = new TransactionBuilder(new Account(owner.publicKey(), '1'), {
      fee: '100',
      networkPassphrase: TESTNET_PASSPHRASE,
    })
      .addOperation(Operation.payment({ destination: alice, asset: Asset.native(), amount: '1' }))
      .setTimeout(60)
      .build();
    payment.sign(owner);
    const refused = await api(base, '/api/tx/submit', { xdr: payment.toXdr() });
    expect(refused.status).toBe(400);
    expect(errorCode(refused.json)).toBe('tx_not_allowed');
    expect(chain.submitted).toHaveLength(0);

    const built = await api(base, '/api/tx/build', {
      action: 'pause',
      source: owner.publicKey(),
      params: { mandate: MANDATE },
    });
    const unsigned = await api(base, '/api/tx/submit', { xdr: built.json['xdr'] });
    expect(errorCode(unsigned.json)).toBe('unsigned');
    const garbage = await api(base, '/api/tx/submit', { xdr: 'bm90IHhkcg==' });
    expect(errorCode(garbage.json)).toBe('invalid_xdr');

    chain.answers.push({ status: 'FAILED', reason: 'already_paused' });
    const failed = await submitSigned(base, String(built.json['xdr']));
    expect(failed.json).toMatchObject({
      status: 'FAILED',
      reason: 'already_paused',
      returnValue: null,
    });
  });
});

describe('console API: mandate, agent, payouts and receipts', () => {
  async function named() {
    const w = await start();
    await w.registry.upsertRecipients(MANDATE, [
      { label: 'alice', address: alice, recipientRef: defaultRecipientRef(alice) },
      { label: 'bob', address: bob, recipientRef: defaultRecipientRef(bob) },
    ]);
    return w;
  }

  it('shows the mandate rules and state from chain with its labels and MCP URL', async () => {
    const { base } = await named();
    const { json } = await api(base, `/api/mandates/${MANDATE}`);
    expect(json).toMatchObject({
      id: MANDATE,
      agent: agent.publicKey,
      executor: executor.publicKey,
      approver: approver.publicKey,
      rules: {
        budget: usdc(500n),
        perPaymentCap: usdc(50n),
        dailyCap: usdc(100n),
        approvalThreshold: usdc(20n),
        expiresAt: 1_900_000_000,
        feeCapBps: 100,
      },
      state: { balance: usdc(500n), spent: '0', remaining: usdc(500n), paused: false },
      mcpUrl: `${base}/m/${MANDATE}/mcp`,
      sdpAvailable: false,
      explorerContractUrl: `https://stellar.expert/explorer/testnet/contract/${MANDATE}`,
    });
    expect(json['recipients']).toEqual([
      { label: 'alice', address: alice, recipientRef: defaultRecipientRef(alice) },
      { label: 'bob', address: bob, recipientRef: defaultRecipientRef(bob) },
    ]);
    const proxied = await api(base, `/api/mandates/${MANDATE}`, undefined, {
      'x-forwarded-proto': 'https',
    });
    expect(String(proxied.json['mcpUrl'])).toMatch(/^https:\/\//);
    expect((await api(base, `/api/mandates/${OTHER}`)).status).toBe(404);
  });

  it('runs the whole agent story: pay, approve, pay now, pause blocks', async () => {
    const { base, rpc } = await named();
    const quote = await api(base, `/api/mandates/${MANDATE}/agent/quote`, {
      recipient: 'alice',
      amount: usdc(1n),
      rail: 'usdc',
    });
    expect(quote.json).toMatchObject({ decision: 'allowed', destination: alice });

    const paid = await api(base, `/api/mandates/${MANDATE}/agent/request`, {
      recipient: 'alice',
      amount: usdc(1n),
      rail: 'usdc',
      taskId: 'task-1',
    });
    expect(paid.json).toMatchObject({
      outcome: 'paid',
      amount_display: '1 USDC',
      destination: alice,
    });

    const big = await api(base, `/api/mandates/${MANDATE}/agent/request`, {
      recipient: bob,
      amount: usdc(30n),
      rail: 'usdc',
      taskId: 'task-2',
    });
    expect(big.json['outcome']).toBe('approval_required');
    let payouts = (await api(base, `/api/mandates/${MANDATE}/payouts`)).json['payouts'] as Record<
      string,
      unknown
    >[];
    expect(payouts.map((p) => [p['taskId'], p['status'], p['recipientLabel']])).toEqual([
      ['task-2', 'pending_approval', 'bob'],
      ['task-1', 'paid', 'alice'],
    ]);
    expect(payouts[1]).toMatchObject({ recipient: alice, amount: usdc(1n), rail: 'usdc' });
    expect(typeof payouts[1]?.['paidTx']).toBe('string');

    // The owner approves in their wallet; the chain is what the console reads.
    await new MandateClient(rpc, MANDATE).approve(approver, payoutIdFor(MANDATE, 'task-2'));
    payouts = (await api(base, `/api/mandates/${MANDATE}/payouts`)).json['payouts'] as Record<
      string,
      unknown
    >[];
    expect(payouts[0]?.['status']).toBe('approved');
    const now = await api(base, `/api/mandates/${MANDATE}/agent/request`, {
      recipient: bob,
      amount: usdc(30n),
      rail: 'usdc',
      taskId: 'task-2',
    });
    expect(now.json['outcome']).toBe('approved_then_paid');

    rpc.paused = true;
    const blocked = await api(base, `/api/mandates/${MANDATE}/agent/request`, {
      recipient: 'alice',
      amount: usdc(1n),
      rail: 'usdc',
      taskId: 'task-3',
    });
    expect(blocked.status).toBe(200);
    expect(blocked.json).toMatchObject({ outcome: 'blocked', reason: 'mandate_paused' });
    payouts = (await api(base, `/api/mandates/${MANDATE}/payouts`)).json['payouts'] as Record<
      string,
      unknown
    >[];
    expect(payouts.map((p) => [p['taskId'], p['status'], p['reason']])).toEqual([
      ['task-3', 'blocked', 'mandate_paused'],
      ['task-2', 'paid', undefined],
      ['task-1', 'paid', undefined],
    ]);

    const receipts = await api(base, `/api/mandates/${MANDATE}/receipts`);
    expect((receipts.json['receipts'] as unknown[]).length).toBe(3);
  });

  it('answers engine input errors as HTTP errors and checks agent bodies strictly', async () => {
    const { base } = await named();
    const sdp = await api(base, `/api/mandates/${MANDATE}/agent/quote`, {
      recipient: 'alice',
      amount: usdc(1n),
      rail: 'sdp',
    });
    expect(sdp.status).toBe(400);
    expect(errorCode(sdp.json)).toBe('rail_unavailable');
    const unknown = await api(base, `/api/mandates/${MANDATE}/agent/quote`, {
      recipient: 'nobody',
      amount: usdc(1n),
    });
    expect(errorCode(unknown.json)).toBe('input_invalid');
    const noTask = await api(base, `/api/mandates/${MANDATE}/agent/request`, {
      recipient: 'alice',
      amount: usdc(1n),
      rail: 'usdc',
    });
    expect(errorCode(noTask.json)).toBe('invalid_request');
    const paid = await api(base, `/api/mandates/${MANDATE}/agent/request`, {
      recipient: 'alice',
      amount: usdc(1n),
      rail: 'usdc',
      taskId: 't',
    });
    expect(paid.json['outcome']).toBe('paid');
    // A paid task answers with its receipt again, whatever the retry asks for.
    const retry = await api(base, `/api/mandates/${MANDATE}/agent/request`, {
      recipient: 'alice',
      amount: usdc(2n),
      rail: 'usdc',
      taskId: 't',
    });
    expect(retry.json).toMatchObject({ outcome: 'paid', amount: usdc(1n) });
    const waiting = await api(base, `/api/mandates/${MANDATE}/agent/request`, {
      recipient: 'bob',
      amount: usdc(30n),
      rail: 'usdc',
      taskId: 'big',
    });
    expect(waiting.json['outcome']).toBe('approval_required');
    const conflict = await api(base, `/api/mandates/${MANDATE}/agent/request`, {
      recipient: 'bob',
      amount: usdc(31n),
      rail: 'usdc',
      taskId: 'big',
    });
    expect(conflict.status).toBe(409);
    expect(errorCode(conflict.json)).toBe('task_conflict');
  });

  it('caps payout requests per mandate', async () => {
    const { base, registry } = await start({
      settings: consoleSettings({}, { mandatePayoutsPerHour: 1 }),
    });
    await registry.upsertRecipients(MANDATE, [
      { label: 'alice', address: alice, recipientRef: defaultRecipientRef(alice) },
    ]);
    const body = (task: string) => ({
      recipient: 'alice',
      amount: usdc(1n),
      rail: 'usdc',
      taskId: task,
    });
    expect((await api(base, `/api/mandates/${MANDATE}/agent/request`, body('a'))).status).toBe(200);
    const second = await api(base, `/api/mandates/${MANDATE}/agent/request`, body('b'), ip(99));
    expect(second.status).toBe(429);
  });
});

describe('console MCP route and static pages', () => {
  async function connect(base: string, id: string) {
    const client = new Client({ name: 'test', version: '0' });
    const transport = new StreamableHTTPClientTransport(new URL(`${base}/m/${id}/mcp`));
    await client.connect(transport as Transport);
    return client;
  }

  it('serves the four tools bound to one mandate, names included', async () => {
    const w = await start();
    await w.registry.upsertRecipients(MANDATE, [
      { label: 'alice', address: alice, recipientRef: defaultRecipientRef(alice) },
    ]);
    const client = await connect(w.base, MANDATE);
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name)).toEqual([
      'quote_payout',
      'request_payout',
      'payout_status',
      'list_receipts',
    ]);
    expect(tools.tools[1]?.description).toContain(`alice (${alice})`);
    const result = await client.callTool({
      name: 'request_payout',
      arguments: { recipient: 'alice', amount: usdc(2n), task_id: 'from-claude' },
    });
    const text = (result.content as { text: string }[])[0]?.text ?? '';
    expect(JSON.parse(text)).toMatchObject({
      outcome: 'paid',
      mandate: MANDATE,
      destination: alice,
    });
    await client.close();
    // The same receipt shows in the console.
    const receipts = await api(w.base, `/api/mandates/${MANDATE}/receipts`);
    expect((receipts.json['receipts'] as { task_id: string }[])[0]?.task_id).toBe('from-claude');
  });

  it('refuses an unknown mandate, other origins, and GET on the MCP route', async () => {
    const { base, lines } = await start();
    const res = await fetch(`${base}/m/${OTHER}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: '{}',
    });
    expect(res.status).toBe(404);
    const cross = await fetch(`${base}/m/${MANDATE}/mcp`, {
      method: 'POST',
      headers: { origin: 'https://evil.example', 'content-type': 'application/json' },
      body: '{}',
    });
    expect(cross.status).toBe(403);
    expect((await fetch(`${base}/m/${MANDATE}/mcp`)).status).toBe(405);
    expect(lines.join('\n')).not.toContain(MANDATE);
  });

  it('keeps /healthz and /mcp as they were', async () => {
    const { base } = await start();
    expect(await (await fetch(`${base}/healthz`)).json()).toEqual({ status: 'ok' });
    const client = new Client({ name: 'test', version: '0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)) as Transport);
    expect((await client.listTools()).tools).toHaveLength(4);
    await client.close();
  });

  it('serves the UI with an SPA fallback and never outside its folder', async () => {
    const { base } = await start();
    const root = await fetch(`${base}/`);
    expect(root.status).toBe(200);
    expect(root.headers.get('content-type')).toContain('text/html');
    expect(await root.text()).toContain('UJIRA Console');
    const deep = await fetch(`${base}/mandates/${MANDATE}`);
    expect(await deep.text()).toContain('UJIRA Console');
    const asset = await fetch(`${base}/assets/app.js`);
    expect(asset.headers.get('content-type')).toContain('javascript');
    expect(asset.headers.get('cache-control')).toContain('immutable');
    expect((await fetch(`${base}/assets/missing.js`)).status).toBe(404);
    for (const path of ['/..%2fsecret.txt', '/%2e%2e/secret.txt', '/..%5csecret.txt']) {
      const res = await fetch(`${base}${path}`);
      expect(await res.text(), path).not.toContain('outside the console');
    }
    expect((await fetch(`${base}/`, { method: 'POST' })).status).toBe(404);
  });
});
