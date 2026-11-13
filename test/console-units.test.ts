// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  Account,
  Asset,
  FeeBumpTransaction,
  Keypair,
  Operation,
  TransactionBuilder,
  scValToNative,
  xdr,
} from '@stellar/stellar-sdk';
import { describe, expect, it } from 'vitest';

import {
  allowEntriesOf,
  classify,
  parseEnvelope,
  type AllowContext,
} from '../src/console/allowlist.js';
import { StellarConsoleChain, decimalToMinor } from '../src/console/chain.js';
import { ApiError, toApiError } from '../src/console/errors.js';
import { mapLimit, payoutStatus } from '../src/console/mandates.js';
import { ConsoleRegistry, MAX_RECIPIENTS, defaultLabel } from '../src/console/registry.js';
import { loadConsoleSettings } from '../src/console/settings.js';
import { resolveInside } from '../src/console/static.js';
import {
  checkCreateParams,
  createArgs,
  invokeTx,
  mandateConfig,
  parseBuildRequest,
  tenantTagFor,
  trustlineTx,
} from '../src/console/txbuild.js';
import { ContractRefusedError, EngineError } from '../src/errors.js';
import { defaultRecipientRef } from '../src/ids.js';
import { address, encodeAllowEntries, i128 } from '../src/mandate/codec.js';
import type { Receipt } from '../src/receipts/log.js';
import { TESTNET_PASSPHRASE } from '../src/stellar/gateway.js';
import { owner } from './console-helpers.js';
import { MANDATE, UNIT, agent, executor } from './fake-rpc.js';
import { alice } from './helpers.js';

const FACTORY = 'CB4AYBA5NVQPVPNOWUCSZQK6ZIGOF7KSCS6SF6UV6D2OKPDXLHEPD4V7';
const USDC = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA';
const ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
const OTHER = 'CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA';

const ctx: AllowContext = {
  factory: FACTORY,
  usdc: { code: 'USDC', issuer: ISSUER, contract: USDC },
  agent: agent.publicKey,
  executor: executor.publicKey,
  isRegistered: (id) => id === MANDATE,
};

const src = () => new Account(owner.publicKey(), '1');
const params = {
  budget: 100n * UNIT,
  perPaymentCap: 10n * UNIT,
  dailyCap: 20n * UNIT,
  approvalThreshold: 5n * UNIT,
  expiresAt: 1_800_000_000 + 86_400,
};
const createCtx = {
  principal: owner.publicKey(),
  agent: agent.publicKey,
  executor: executor.publicKey,
  asset: USDC,
  now: 1_800_000_000,
};

function at<T>(list: readonly T[], i: number): T {
  const item = list[i];
  if (item === undefined) throw new Error(`nothing at ${i}`);
  return item;
}

function rules(p: typeof params, c: typeof createCtx = createCtx) {
  return refusedCode(() => {
    checkCreateParams(p, c);
  });
}

function refusedCode(work: () => unknown): string | undefined {
  try {
    work();
  } catch (error) {
    return error instanceof ApiError ? error.code : 'other';
  }
  return undefined;
}

describe('submit allow list', () => {
  it('accepts a create that names this server as agent and executor', () => {
    const tx = invokeTx(src(), FACTORY, 'create', createArgs(params, createCtx));
    expect(classify(tx, ctx)).toEqual({ kind: 'create', principal: owner.publicKey() });
  });

  it('refuses a create for another agent, another executor or another asset', () => {
    for (const over of [
      { agent: Keypair.random().publicKey() },
      { executor: Keypair.random().publicKey() },
      { asset: OTHER },
    ]) {
      const tx = invokeTx(src(), FACTORY, 'create', createArgs(params, { ...createCtx, ...over }));
      expect(refusedCode(() => classify(tx, ctx))).toBe('tx_not_allowed');
    }
    const upgrade = invokeTx(src(), FACTORY, 'fee_address', []);
    expect(refusedCode(() => classify(upgrade, ctx))).toBe('tx_not_allowed');
  });

  it('accepts USDC only into a console mandate', () => {
    const fund = (to: string) =>
      invokeTx(src(), USDC, 'transfer', [address(owner.publicKey()), address(to), i128(5n)]);
    expect(classify(fund(MANDATE), ctx)).toEqual({ kind: 'fund', mandate: MANDATE, amount: 5n });
    expect(refusedCode(() => classify(fund(OTHER), ctx))).toBe('tx_not_allowed');
    expect(refusedCode(() => classify(fund(alice), ctx))).toBe('tx_not_allowed');
    const approve = invokeTx(src(), USDC, 'approve', [
      address(owner.publicKey()),
      address(MANDATE),
      i128(5n),
      xdr.ScVal.scvU32(1),
    ]);
    expect(refusedCode(() => classify(approve, ctx))).toBe('tx_not_allowed');
  });

  it('accepts owner calls on a console mandate and nothing else', () => {
    for (const method of ['pause', 'resume', 'revoke', 'sweep', 'withdraw', 'approve', 'reject']) {
      expect(classify(invokeTx(src(), MANDATE, method, []), ctx)).toMatchObject({
        kind: 'mandate',
        method,
      });
    }
    for (const method of ['execute', 'request_payout', 'add_role', 'update_limits', 'cancel']) {
      expect(refusedCode(() => classify(invokeTx(src(), MANDATE, method, []), ctx))).toBe(
        'tx_not_allowed',
      );
    }
    expect(refusedCode(() => classify(invokeTx(src(), OTHER, 'pause', []), ctx))).toBe(
      'tx_not_allowed',
    );
  });

  it('accepts a USDC trustline only', () => {
    expect(classify(trustlineTx(src(), { code: 'USDC', issuer: ISSUER }), ctx)).toEqual({
      kind: 'trustline',
    });
    const fake = trustlineTx(src(), { code: 'USDC', issuer: owner.publicKey() });
    expect(refusedCode(() => classify(fake, ctx))).toBe('tx_not_allowed');
  });

  it('refuses other operations, two operations and fee bumps', () => {
    const builder = () =>
      new TransactionBuilder(src(), { fee: '100', networkPassphrase: TESTNET_PASSPHRASE });
    const pay = builder()
      .addOperation(Operation.payment({ destination: alice, asset: Asset.native(), amount: '1' }))
      .setTimeout(60)
      .build();
    expect(refusedCode(() => classify(pay, ctx))).toBe('tx_not_allowed');
    const two = builder()
      .addOperation(Operation.changeTrust({ asset: new Asset('USDC', ISSUER) }))
      .addOperation(Operation.changeTrust({ asset: new Asset('USDC', ISSUER) }))
      .setTimeout(60)
      .build();
    expect(refusedCode(() => classify(two, ctx))).toBe('tx_not_allowed');

    const inner = trustlineTx(src(), { code: 'USDC', issuer: ISSUER });
    const key = Keypair.random();
    inner.sign(key);
    const bump: FeeBumpTransaction = TransactionBuilder.buildFeeBumpTransaction(
      key,
      '20000',
      inner,
      TESTNET_PASSPHRASE,
    );
    expect(refusedCode(() => parseEnvelope(bump.toXdr()))).toBe('tx_not_allowed');
    expect(refusedCode(() => parseEnvelope('garbage'))).toBe('invalid_xdr');
    expect(parseEnvelope(inner.toXdr()).source).toBe(owner.publicKey());
  });

  it('reads the entries of an allow_recipients call', () => {
    const entries = [{ recipientRef: defaultRecipientRef(alice), destination: alice }];
    expect(allowEntriesOf([encodeAllowEntries(entries)])).toEqual([
      { ref: defaultRecipientRef(alice), destination: alice },
    ]);
    expect(allowEntriesOf([])).toEqual([]);
    expect(allowEntriesOf([i128(1n)])).toEqual([]);
  });
});

describe('transaction builders', () => {
  it('encodes the factory config the demo mandate used, with the owner approving', () => {
    const native = scValToNative(mandateConfig(params, createCtx)) as Record<string, unknown>;
    expect(native).toEqual({
      principal: owner.publicKey(),
      asset: USDC,
      recipient_mode: 1,
      tenant_tag: Buffer.from(tenantTagFor(owner.publicKey()), 'hex'),
      agents: [agent.publicKey],
      approvers: [owner.publicKey()],
      approvals_required: 1,
      guardians: [],
      executors: [executor.publicKey],
      recovery: [],
      recovery_threshold: 0,
      limits: {
        total_budget: 100n * UNIT,
        per_payment_cap: 10n * UNIT,
        per_recipient_daily_cap: 20n * UNIT,
        approval_threshold: 5n * UNIT,
        payout_ttl_seconds: 86_400n,
        expires_at: BigInt(params.expiresAt),
      },
      attester: null,
      country_policy_hash: Buffer.alloc(32),
      max_fee_bps: 0,
    });
    const salted = createArgs(params, { ...createCtx, salt: 'cd'.repeat(32) });
    expect(Buffer.from(scValToNative(at(salted, 1)) as Uint8Array).toString('hex')).toBe(
      'cd'.repeat(32),
    );
    const random = at(createArgs(params, createCtx), 1);
    const other = at(createArgs(params, createCtx), 1);
    expect(random.toXdr('base64')).not.toBe(other.toXdr('base64'));
  });

  it('checks rules before the network does', () => {
    expect(rules(params)).toBeUndefined();
    expect(rules({ ...params, perPaymentCap: 101n * UNIT })).toBe('invalid_rules');
    expect(rules({ ...params, expiresAt: 1_800_000_100 })).toBe('invalid_rules');
    expect(rules({ ...params, expiresAt: 1_800_000_000 + 400 * 86_400 })).toBe('invalid_rules');
    expect(rules(params, { ...createCtx, principal: executor.publicKey })).toBe('role_conflict');
  });

  it('parses build requests strictly', () => {
    const ok = parseBuildRequest({
      action: 'create_mandate',
      source: owner.publicKey(),
      params: {
        budget: '1000',
        perPaymentCap: '100',
        dailyCap: '100',
        approvalThreshold: '0',
        expiresAt: '1900000000',
      },
    });
    expect(ok.action === 'create_mandate' ? ok.params.expiresAt : null).toBe(1_900_000_000);
    expect(refusedCode(() => parseBuildRequest(null))).toBe('invalid_request');
    expect(refusedCode(() => parseBuildRequest({ action: 'drain' }))).toBe('unknown_action');
    expect(
      refusedCode(() =>
        parseBuildRequest({
          action: 'pause',
          source: owner.publicKey(),
          params: { mandate: MANDATE, x: 1 },
        }),
      ),
    ).toBe('invalid_request');
    expect(
      refusedCode(() =>
        parseBuildRequest({
          action: 'approve',
          source: owner.publicKey(),
          params: { mandate: MANDATE, payoutId: 'XY' },
        }),
      ),
    ).toBe('invalid_request');
    expect(
      refusedCode(() =>
        parseBuildRequest({
          action: 'fund_mandate',
          source: owner.publicKey(),
          params: { mandate: MANDATE, amount: 5 },
        }),
      ),
    ).toBe('invalid_request');
  });
});

describe('console registry', () => {
  const dir = () => mkdtempSync(join(tmpdir(), 'ujira-registry-'));
  const entry = (id: string, at: string) => ({
    id,
    principal: owner.publicKey(),
    createdAt: at,
    createTx: 'b'.repeat(64),
  });

  it('keeps mandates by principal, newest first, across a restart', async () => {
    const path = join(dir(), 'r.json');
    const r = ConsoleRegistry.open(path);
    await r.addMandate(entry(MANDATE, '2026-11-13T10:00:00Z'));
    await r.addMandate(entry(OTHER, '2026-11-13T11:00:00Z'));
    await r.addMandate(entry(OTHER, '2026-11-13T12:00:00Z'));
    expect(r.mandatesOf(owner.publicKey()).map((m) => m.id)).toEqual([OTHER, MANDATE]);
    expect(r.mandatesOf(alice)).toEqual([]);
    await r.upsertRecipients(MANDATE, [
      { label: 'alice', address: alice, recipientRef: defaultRecipientRef(alice) },
    ]);
    await r.recordFaucet({ address: alice, hash: 'c'.repeat(64), at: 'now' });
    const again = ConsoleRegistry.open(path);
    expect(again.mandate(MANDATE)?.recipients[0]?.label).toBe('alice');
    expect(again.faucetClaim(alice)?.hash).toBe('c'.repeat(64));
    expect((readFileSync(path, 'utf8').match(/"id"/g) ?? []).length).toBe(2);
  });

  it('gives a label to one address per mandate and bounds the list', async () => {
    const r = ConsoleRegistry.open(join(dir(), 'r.json'));
    await r.addMandate(entry(MANDATE, 'x'));
    const bob = Keypair.random().publicKey();
    await r.upsertRecipients(MANDATE, [
      { label: 'pal', address: alice, recipientRef: defaultRecipientRef(alice) },
    ]);
    await r.upsertRecipients(MANDATE, [
      { label: 'pal', address: bob, recipientRef: defaultRecipientRef(bob) },
      { label: 'alice', address: alice, recipientRef: defaultRecipientRef(alice) },
    ]);
    expect(r.mandate(MANDATE)?.recipients.map((x) => [x.label, x.address])).toEqual([
      ['pal', bob],
      ['alice', alice],
    ]);
    const many = Array.from({ length: MAX_RECIPIENTS + 5 }, (_, i) => {
      const a = Keypair.random().publicKey();
      return { label: `r${i}`, address: a, recipientRef: defaultRecipientRef(a) };
    });
    await r.upsertRecipients(MANDATE, many);
    expect(r.mandate(MANDATE)?.recipients).toHaveLength(MAX_RECIPIENTS);
    await expect(r.upsertRecipients(OTHER, [])).rejects.toThrow('no such mandate');
    expect(defaultLabel([], alice)).toBe(`recipient-${alice.slice(0, 6)}`);
  });

  it('refuses a registry file it cannot read', () => {
    const d = dir();
    writeFileSync(join(d, 'bad.json'), '{"version":2}');
    expect(() => ConsoleRegistry.open(join(d, 'bad.json'))).toThrow('expected format');
    writeFileSync(join(d, 'worse.json'), 'nope');
    expect(() => ConsoleRegistry.open(join(d, 'worse.json'))).toThrow('not valid JSON');
  });
});

describe('console helpers', () => {
  it('turns Horizon amounts into minor units without floats', () => {
    expect(decimalToMinor('50.0000000')).toBe(500_000_000n);
    expect(decimalToMinor('0.1')).toBe(1_000_000n);
    expect(decimalToMinor('949')).toBe(9_490_000_000n);
    expect(() => decimalToMinor('1.00000001')).toThrow(ApiError);
    expect(() => decimalToMinor('-1')).toThrow(ApiError);
  });

  it('maps engine errors to statuses and hides unknown ones', () => {
    expect(toApiError(new EngineError('input_invalid', 'bad')).status).toBe(400);
    expect(toApiError(new EngineError('task_conflict', 'x')).status).toBe(409);
    expect(toApiError(new ContractRefusedError('pause', 23)).code).toBe('already_paused');
    const hidden = toApiError(new Error('secret detail'));
    expect([hidden.status, hidden.code, hidden.message]).toEqual([
      500,
      'internal_error',
      'Something went wrong on the server',
    ]);
  });

  it('maps chain answers to payout statuses', () => {
    const r = { outcome: 'approval_required' } as Receipt;
    const rec = (status: number, expiresAt = 100n) =>
      ({ kind: 'record', status, expiresAt }) as Parameters<typeof payoutStatus>[1];
    expect(payoutStatus(r, rec(1), 50n)).toBe('pending_approval');
    expect(payoutStatus(r, rec(1), 100n)).toBe('expired');
    expect(payoutStatus(r, rec(2), 50n)).toBe('approved');
    expect(payoutStatus(r, rec(2), 200n)).toBe('expired');
    expect(payoutStatus(r, { kind: 'tombstone', payoutId: '', status: 3 }, 50n)).toBe('paid');
    expect(payoutStatus(r, { kind: 'tombstone', payoutId: '', status: 4 }, 50n)).toBe('rejected');
    expect(payoutStatus(r, { kind: 'tombstone', payoutId: '', status: 5 }, 50n)).toBe('cancelled');
    expect(payoutStatus({ outcome: 'blocked' } as Receipt, null, 1n)).toBe('blocked');
    expect(payoutStatus({ outcome: 'paid' } as Receipt, null, 1n)).toBe('paid');
  });

  it('runs work with bounded concurrency in order', async () => {
    let running = 0;
    let peak = 0;
    const out = await mapLimit([1, 2, 3, 4, 5], 2, async (n) => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 5));
      running--;
      return n * 2;
    });
    expect(out).toEqual([2, 4, 6, 8, 10]);
    expect(peak).toBe(2);
  });

  it('resolves static paths only inside the console folder', () => {
    expect(resolveInside('/srv/ui', '/assets/a.js')).toBe('/srv/ui/assets/a.js');
    expect(resolveInside('/srv/ui', '/../etc/passwd')).toBeUndefined();
    expect(resolveInside('/srv/ui', '/%2e%2e/etc')).toBeUndefined();
    expect(resolveInside('/srv/ui', '/%E0%A4%A')).toBeUndefined();
    expect(resolveInside('/srv/ui', '/a%00b')).toBeUndefined();
  });

  it('reads console settings from the environment', () => {
    const s = loadConsoleSettings({
      UJIRA_RECEIPTS_FILE: '/data/receipts.json',
      UJIRA_PUBLIC_ORIGIN: 'https://ujira.example/',
      UJIRA_FAUCET_AMOUNT: '100',
      UJIRA_TREASURY_SECRET: owner.secret(),
    });
    expect(s.dataDir).toBe('/data');
    expect(s.publicOrigin).toBe('https://ujira.example');
    expect(s.faucetAmount).toBe(100n);
    expect(s.faucetFloor).toBe(200n);
    expect(s.treasury?.publicKey).toBe(owner.publicKey());
    expect(s.limits.mandatePayoutsPerHour).toBe(30);
    expect(loadConsoleSettings({ UJIRA_DATA_DIR: '/x' }).treasury).toBeUndefined();
    expect(() => loadConsoleSettings({ UJIRA_FAUCET_AMOUNT: '1.5' })).toThrow(
      'UJIRA_FAUCET_AMOUNT',
    );
    expect(() => loadConsoleSettings({ UJIRA_HORIZON_URL: 'ftp://x' })).toThrow(
      'UJIRA_HORIZON_URL',
    );
    expect(() => loadConsoleSettings({ UJIRA_FACTORY: 'nope' })).toThrow('UJIRA_FACTORY');
    expect(() => loadConsoleSettings({ UJIRA_FAUCET_PER_HOUR: '0' })).toThrow(
      'UJIRA_FAUCET_PER_HOUR',
    );
    expect(() => loadConsoleSettings({ UJIRA_PUBLIC_ORIGIN: 'not a url' })).toThrow(
      'UJIRA_PUBLIC_ORIGIN',
    );
  });
});

describe('Stellar console chain over HTTP', () => {
  function chainWith(answers: Record<string, () => Response>) {
    const seen: string[] = [];
    const fetchFn = ((url: string) => {
      seen.push(url);
      for (const [prefix, answer] of Object.entries(answers)) {
        if (url.startsWith(prefix)) return Promise.resolve(answer());
      }
      return Promise.reject(new Error('offline'));
    }) as typeof fetch;
    const chain = new StellarConsoleChain({
      rpcUrl: 'https://soroban-testnet.stellar.org',
      horizonUrl: 'https://horizon.test',
      friendbotUrl: 'https://friendbot.test',
      fetch: fetchFn,
    });
    return { chain, seen };
  }
  const usdc = { code: 'USDC', issuer: ISSUER };

  it('reads balances from Horizon', async () => {
    const { chain } = chainWith({
      [`https://horizon.test/accounts/${alice}`]: () =>
        Response.json({
          balances: [
            {
              asset_type: 'credit_alphanum4',
              asset_code: 'USDC',
              asset_issuer: ISSUER,
              balance: '12.5000000',
            },
            { asset_type: 'native', balance: '9999.9999900' },
          ],
        }),
      'https://horizon.test/accounts/': () => new Response('{}', { status: 404 }),
    });
    expect(await chain.account(alice, usdc)).toEqual({
      exists: true,
      xlm: '9999.9999900',
      usdc: 125_000_000n,
    });
    expect(await chain.account(owner.publicKey(), usdc)).toEqual({
      exists: false,
      xlm: null,
      usdc: null,
    });
  });

  it('says Horizon or the network failed without passing its body on', async () => {
    const { chain } = chainWith({
      'https://horizon.test/accounts/': () => new Response('internal secret', { status: 500 }),
    });
    await expect(chain.account(alice, usdc)).rejects.toMatchObject({ code: 'horizon_unavailable' });
    const offline = chainWith({}).chain;
    await expect(offline.account(alice, usdc)).rejects.toMatchObject({
      code: 'network_unavailable',
    });
  });

  it('treats an already funded account as funded by friendbot', async () => {
    const { chain, seen } = chainWith({
      'https://friendbot.test/': () => new Response('{}', { status: 400 }),
      'https://horizon.test/accounts/': () => Response.json({ balances: [] }),
    });
    await chain.friendbot(alice);
    expect(seen[0]).toBe(`https://friendbot.test/?addr=${alice}`);
    const fails = chainWith({
      'https://friendbot.test/': () => new Response('{}', { status: 500 }),
      'https://horizon.test/accounts/': () => new Response('{}', { status: 404 }),
    }).chain;
    await expect(fails.friendbot(alice)).rejects.toMatchObject({ code: 'friendbot_failed' });
  });
});
