// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The fee sponsor end to end, minus the database: the real Stellar adapter on
// the fake RPC and a network that charges fees the way Stellar does, the
// sponsored submitter, a ledger in memory that keeps the same rules as the
// fee sponsorship tables, and the /v1 answer past the cap.

import {
  Account,
  FeeBumpTransaction,
  TransactionBuilder,
  type Transaction,
} from '@stellar/stellar-sdk';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createV1App } from '../src/api/app.js';
import { errorEnvelopeSchema } from '../src/api/errors.js';
import { defineRoute } from '../src/api/route.js';
import { ChainError, callOptions, type SigningRequest } from '../src/chain/adapter.js';
import { StellarChainAdapter } from '../src/chain/stellar/adapter.js';
import { TESTNET_PASSPHRASE } from '../src/chain/stellar/gateway.js';
import type {
  AccountFacts,
  AccountView,
  StellarNetworkPort,
  Submitted,
} from '../src/chain/stellar/network.js';
import { EngineError } from '../src/errors.js';
import { FeeSponsorCapError } from '../src/payouts/errors.js';
import {
  DEFAULT_FEE_SPONSOR_DAILY_CAP,
  SponsoredSubmitter,
  loadFeeSponsorSettings,
  secondsToNextUtcDay,
  type FeeLedger,
  type FeeReservation,
} from '../src/payouts/fee-sponsorship.js';
import { FakeMandateRpc, MANDATE, principal, testSigner } from './fake-rpc.js';

const FACTORY = 'CB4AYBA5NVQPVPNOWUCSZQK6ZIGOF7KSCS6SF6UV6D2OKPDXLHEPD4V7';
const USDC_CONTRACT = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA';
const ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
// 2026-11-27T22:00:00Z, two hours before the UTC day turns.
const NOW_MS = Date.UTC(2026, 10, 27, 22, 0, 0);
const STROOPS_PER_XLM = 10_000_000n;
// One base reserve pair: what an account with no trustlines or entries must keep.
const RESERVE = 1n * STROOPS_PER_XLM;

const sponsor = testSigner('fee-sponsor');

/**
 * A network that keeps XLM balances in stroops and charges fees as Stellar
 * does: the fee source pays, a plain transaction's source is its fee source,
 * and an account cannot spend into its reserve.
 */
class FeeChargingNetwork implements StellarNetworkPort {
  balances = new Map<string, bigint>([
    [principal.publicKey, RESERVE],
    [sponsor.publicKey, 10_000n * STROOPS_PER_XLM],
  ]);
  submitted: (Transaction | FeeBumpTransaction)[] = [];
  /** What the network charges for inclusion, per operation. */
  inclusion = 100n;

  account(address: string): Promise<AccountView> {
    const stroops = this.balances.get(address);
    if (stroops === undefined) return Promise.resolve({ exists: false, xlm: null, usdc: null });
    const whole = stroops / STROOPS_PER_XLM;
    const frac = (stroops % STROOPS_PER_XLM).toString().padStart(7, '0');
    return Promise.resolve({ exists: true, xlm: `${whole}.${frac}`, usdc: null });
  }
  accountFacts(): Promise<AccountFacts> {
    return Promise.resolve({ exists: true, trustlines: [], memoRequired: false });
  }
  loadAccount(address: string): Promise<Account> {
    return Promise.resolve(new Account(address, '100'));
  }
  prepare(tx: Transaction): Promise<Transaction> {
    return Promise.resolve(tx);
  }
  submit(tx: Transaction | FeeBumpTransaction): Promise<Submitted> {
    const payer = tx instanceof FeeBumpTransaction ? tx.feeSource : tx.source;
    const ops = BigInt(
      tx instanceof FeeBumpTransaction
        ? tx.innerTransaction.operations.length + 1
        : tx.operations.length,
    );
    const charged = this.inclusion * ops;
    const balance = this.balances.get(payer) ?? 0n;
    if (balance - charged < RESERVE) {
      // txINSUFFICIENT_BALANCE: refused before it is applied, so nothing is charged.
      return Promise.reject(
        new ChainError('TX_FAILED', 'The network did not accept the transaction', {
          reason: 'tx_rejected',
        }),
      );
    }
    this.balances.set(payer, balance - charged);
    this.submitted.push(tx);
    return Promise.resolve({
      hash: Buffer.from(tx.hash()).toString('hex'),
      status: 'SUCCESS',
      feeCharged: charged,
    });
  }
  friendbot(): Promise<void> {
    return Promise.resolve();
  }
  latestLedger(): Promise<number> {
    return Promise.resolve(1);
  }
}

/** The fee sponsorship tables' rules, in memory: one total per principal and day. */
class MemoryLedger implements FeeLedger {
  days = new Map<string, bigint>();
  rows = new Map<
    string,
    { principal: string; day: string; status: string; maxFee: bigint; charged: bigint | null }
  >();

  private dayKey = (principal: string, day: string) => `${principal}/${day}`;
  private rowKey = (t: { principalId: string; projectId: string }, hash: string) =>
    `${t.principalId}/${t.projectId}/${hash}`;

  reserve(
    tenant: { principalId: string; projectId: string },
    entry: { innerTxHash: string; day: string; maxFee: bigint; dailyCap: bigint },
  ): Promise<FeeReservation> {
    const dk = this.dayKey(tenant.principalId, entry.day);
    const used = this.days.get(dk) ?? 0n;
    const row = this.rows.get(this.rowKey(tenant, entry.innerTxHash));
    if (row !== undefined && row.status !== 'released') {
      return Promise.resolve({ kind: 'replay', used });
    }
    if (used + entry.maxFee > entry.dailyCap) return Promise.resolve({ kind: 'capped', used });
    this.rows.set(this.rowKey(tenant, entry.innerTxHash), {
      principal: tenant.principalId,
      day: entry.day,
      status: 'reserved',
      maxFee: entry.maxFee,
      charged: null,
    });
    this.days.set(dk, used + entry.maxFee);
    return Promise.resolve({ kind: 'reserved', used: used + entry.maxFee });
  }
  private close(
    tenant: { principalId: string; projectId: string },
    hash: string,
    status: string,
    charged: bigint,
  ): Promise<boolean> {
    const row = this.rows.get(this.rowKey(tenant, hash));
    if (row?.status !== 'reserved') return Promise.resolve(false);
    const kept = charged < row.maxFee ? charged : row.maxFee;
    const dk = this.dayKey(row.principal, row.day);
    this.days.set(dk, (this.days.get(dk) ?? 0n) - row.maxFee + kept);
    row.status = status;
    row.charged = kept;
    return Promise.resolve(true);
  }
  settle(
    tenant: { principalId: string; projectId: string },
    entry: { innerTxHash: string; charged: bigint },
  ): Promise<boolean> {
    return this.close(tenant, entry.innerTxHash, 'settled', entry.charged);
  }
  release(
    tenant: { principalId: string; projectId: string },
    entry: { innerTxHash: string },
  ): Promise<boolean> {
    return this.close(tenant, entry.innerTxHash, 'released', 0n);
  }
  usedBy(principalId: string, day = '2026-11-27'): bigint {
    return this.days.get(this.dayKey(principalId, day)) ?? 0n;
  }
}

const ALPHA = {
  principalId: '00000000-0000-4000-8000-00000000000a',
  projectId: '00000000-0000-4000-8000-0000000000a1',
};
const ALPHA_TWO = {
  principalId: ALPHA.principalId,
  projectId: '00000000-0000-4000-8000-0000000000a2',
};
const BRAVO = {
  principalId: '00000000-0000-4000-8000-00000000000b',
  projectId: '00000000-0000-4000-8000-0000000000b1',
};

function world(options: { dailyCap?: bigint; withSponsor?: boolean } = {}) {
  const chain = new FeeChargingNetwork();
  const adapter = new StellarChainAdapter({
    gateway: new FakeMandateRpc(),
    chain,
    factory: FACTORY,
    asset: { code: 'USDC', issuer: ISSUER, contract: USDC_CONTRACT },
    ...(options.withSponsor === false ? {} : { feeSponsor: sponsor }),
    now: () => NOW_MS,
  });
  const ledger = new MemoryLedger();
  const logs: string[] = [];
  let clock = NOW_MS;
  const submitter = new SponsoredSubmitter({
    adapter,
    ledger,
    settings: { dailyCap: options.dailyCap ?? DEFAULT_FEE_SPONSOR_DAILY_CAP },
    log: (line) => logs.push(line),
    now: () => clock,
  });
  const tick = (ms: number) => {
    clock += ms;
  };
  return { chain, adapter, ledger, logs, submitter, tick };
}

const o = () => callOptions('test');

function signed(req: SigningRequest): string {
  const tx = TransactionBuilder.fromXdr(req.xdr, TESTNET_PASSPHRASE) as Transaction;
  principal.sign(tx);
  return tx.toXdr();
}

async function pause(adapter: StellarChainAdapter): Promise<{ req: SigningRequest; xdr: string }> {
  const req = await adapter.prepareMandateAction(MANDATE, { kind: 'pause' }, o());
  return { req, xdr: signed(req) };
}

async function refusal(work: () => Promise<unknown>): Promise<unknown> {
  try {
    await work();
  } catch (error) {
    return error;
  }
  throw new Error('expected a refusal');
}

describe('a principal with no XLM above its reserve', () => {
  it('cannot pay its own fee, so without the sponsor the network refuses it', async () => {
    const { adapter, chain } = world({ withSponsor: false });
    const { req, xdr } = await pause(adapter);
    const error = await refusal(() => adapter.submitSigned(xdr, req, o()));
    expect(error).toBeInstanceOf(ChainError);
    expect((error as ChainError).reason).toBe('tx_rejected');
    expect(chain.submitted).toHaveLength(0);
  });

  it('submits a mandate action, with the fee paid by the sponsor and its reserve untouched', async () => {
    const { submitter, chain, adapter, ledger } = world();
    const { req, xdr } = await pause(adapter);
    const before = chain.balances.get(sponsor.publicKey) ?? 0n;
    const { txHash } = await submitter.submit(ALPHA, xdr, req, o());

    const sent = chain.submitted[0];
    if (!(sent instanceof FeeBumpTransaction)) throw new Error('expected a fee bump');
    expect(txHash).toBe(Buffer.from(sent.hash()).toString('hex'));
    expect(sent.innerTransaction.toXdr()).toBe(xdr);
    expect(chain.balances.get(principal.publicKey)).toBe(RESERVE);
    expect(chain.balances.get(sponsor.publicKey)).toBe(before - 200n);
    // Settled at what the network charged, not at the bump's maximum.
    expect(ledger.usedBy(ALPHA.principalId)).toBe(200n);
  });
});

describe('the daily cap', () => {
  // Each pause or resume bids 10000 stroops for its operation and the bump, so
  // it reserves 20000, and the network then charges 200, which is what stays
  // counted.
  it('past the cap answers RATE_LIMITED with Retry-After, and sends nothing', async () => {
    const { submitter, chain, adapter, logs } = world({ dailyCap: 20_100n });
    const first = await pause(adapter);
    await submitter.submit(ALPHA, first.xdr, first.req, o());
    expect(chain.submitted).toHaveLength(1);

    const second = await adapter.prepareMandateAction(MANDATE, { kind: 'resume' }, o());
    const route = defineRoute({
      method: 'post',
      path: '/v1/test/submit',
      operationId: 'testSubmit',
      summary: 'Relays a signed envelope through the fee sponsor',
      body: z.object({ xdr: z.string() }).strict(),
      response: z.object({ txHash: z.string() }).strict(),
      errors: ['RATE_LIMITED'],
      handler: ({ body }) => submitter.submit(ALPHA, body.xdr, second, o()),
    });
    const { app } = createV1App({ routes: [route] });
    const response = await app.request('/v1/test/submit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ xdr: signed(second) }),
    });

    expect(response.status).toBe(429);
    // Two hours to the next UTC midnight.
    expect(response.headers.get('retry-after')).toBe('7200');
    const body = errorEnvelopeSchema.parse(await response.json());
    expect(body.error.code).toBe('RATE_LIMITED');
    expect(chain.submitted).toHaveLength(1);
    expect(logs.some((line) => line.startsWith('event=fee_sponsor_cap_reached '))).toBe(true);
  });

  it('is per principal across its projects, and another principal has its own', async () => {
    const { submitter, chain, adapter, ledger } = world({ dailyCap: 20_300n });
    const actions = ['pause', 'resume'] as const;
    const [a, b] = await Promise.all(
      actions.map(async (kind) => {
        const req = await adapter.prepareMandateAction(MANDATE, { kind }, o());
        return { req, xdr: signed(req) };
      }),
    );
    if (a === undefined || b === undefined) throw new Error('two actions');
    await submitter.submit(ALPHA, a.xdr, a.req, o());
    await submitter.submit(ALPHA_TWO, b.xdr, b.req, o());
    expect(ledger.usedBy(ALPHA.principalId)).toBe(400n);

    const c = await pause(adapter);
    const capped = await refusal(() => submitter.submit(ALPHA_TWO, c.xdr, c.req, o()));
    expect(capped).toBeInstanceOf(FeeSponsorCapError);
    await submitter.submit(BRAVO, c.xdr, c.req, o());
    expect(ledger.usedBy(BRAVO.principalId)).toBe(200n);
    expect(chain.submitted).toHaveLength(3);
  });

  it('refuses before sending when even one transaction is over the cap', async () => {
    const { submitter, chain, adapter, ledger } = world({ dailyCap: 19_999n });
    const { req, xdr } = await pause(adapter);
    expect(await refusal(() => submitter.submit(ALPHA, xdr, req, o()))).toBeInstanceOf(
      FeeSponsorCapError,
    );
    expect(chain.submitted).toHaveLength(0);
    expect(ledger.rows.size).toBe(0);
  });
});

describe('a ledger that fails after the send', () => {
  // The transaction has already gone out, so its own outcome is the answer;
  // a reservation left open only overcounts the day, never undercounts it.
  it('still answers with the transaction when settling fails, and logs why', async () => {
    const { submitter, adapter, ledger, logs, chain } = world();
    ledger.settle = () => Promise.reject(new Error('database down'));
    const { req, xdr } = await pause(adapter);
    const { txHash } = await submitter.submit(ALPHA, xdr, req, o());
    expect(txHash).toMatch(/^[0-9a-f]{64}$/);
    expect(chain.submitted).toHaveLength(1);
    expect(logs.filter((l) => l.startsWith('event=fee_sponsor_settle_failed '))).toHaveLength(1);
    expect(ledger.usedBy(ALPHA.principalId)).toBe(20_000n);
  });

  it('still answers with the network refusal when releasing fails, and logs why', async () => {
    const { submitter, adapter, ledger, logs, chain } = world();
    ledger.release = () => Promise.reject(new Error('database down'));
    // The sponsor itself is down to its reserve, so the network refuses the bump.
    chain.balances.set(sponsor.publicKey, RESERVE);
    const { req, xdr } = await pause(adapter);
    const error = await refusal(() => submitter.submit(ALPHA, xdr, req, o()));
    expect((error as ChainError).reason).toBe('tx_rejected');
    expect(logs.filter((l) => l.startsWith('event=fee_sponsor_release_failed '))).toHaveLength(1);
  });

  it('frees the day when the network refused the bump and the ledger is up', async () => {
    const { submitter, adapter, ledger, chain } = world();
    chain.balances.set(sponsor.publicKey, RESERVE);
    const { req, xdr } = await pause(adapter);
    await refusal(() => submitter.submit(ALPHA, xdr, req, o()));
    expect(ledger.usedBy(ALPHA.principalId)).toBe(0n);
  });
});

describe('settings', () => {
  it('reads the cap in stroops, with a default', () => {
    expect(loadFeeSponsorSettings({})).toEqual({ dailyCap: 50_000_000n });
    expect(loadFeeSponsorSettings({ UJIRA_FEE_SPONSOR_DAILY_CAP: '' })).toEqual({
      dailyCap: 50_000_000n,
    });
    expect(loadFeeSponsorSettings({ UJIRA_FEE_SPONSOR_DAILY_CAP: '25000000' })).toEqual({
      dailyCap: 25_000_000n,
    });
  });

  it('refuses anything but a whole number of stroops in range, naming the key', () => {
    for (const bad of ['0', '-5', '1.5', '1e9', 'lots', '9223372036854775808']) {
      expect(() => loadFeeSponsorSettings({ UJIRA_FEE_SPONSOR_DAILY_CAP: bad })).toThrow(
        EngineError,
      );
    }
    expect(() => loadFeeSponsorSettings({ UJIRA_FEE_SPONSOR_DAILY_CAP: 'x' })).toThrow(
      /UJIRA_FEE_SPONSOR_DAILY_CAP/,
    );
  });

  it('counts the seconds to the next UTC day', () => {
    expect(secondsToNextUtcDay(NOW_MS)).toBe(7_200);
    expect(secondsToNextUtcDay(Date.UTC(2026, 10, 28))).toBe(86_400);
    expect(secondsToNextUtcDay(Date.UTC(2026, 10, 28) - 1)).toBe(1);
  });
});
