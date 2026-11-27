// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

import { createHash, createPrivateKey, sign as edSign } from 'node:crypto';

import {
  Account,
  FeeBumpTransaction,
  Keypair,
  SorobanDataBuilder,
  TransactionBuilder,
  xdr,
  type Transaction,
} from '@stellar/stellar-sdk';
import { describe, expect, it } from 'vitest';

import {
  FakeMandateRpc,
  MANDATE,
  UNIT,
  agent,
  approver,
  executor,
  principal,
  stranger,
  testSigner,
} from '../../../test/fake-rpc.js';
import {
  WALLET_MESSAGE_VERSION,
  WalletMessageError,
  formatWalletMessage,
  parseWalletMessage,
  verifyWalletMessage,
} from '../../auth/wallet-message.js';
import { defaultRecipientRef, payoutIdFor, taskRefFor } from '../../ids.js';
import {
  CHAIN_ADAPTER_VERSION,
  CHAIN_ERROR_CODES,
  ChainError,
  callOptions,
  type CallOptions,
  type ChainAdapter,
  type FeeBudget,
  type PayoutIntent,
  type SigningRequest,
  type SponsoredFee,
} from '../adapter.js';
import { StellarChainAdapter } from './adapter.js';
import { classify } from './allowlist.js';
import { address, nativeOf } from './codec.js';
import { TESTNET_PASSPHRASE, type SorobanGateway } from './gateway.js';
import { signerFrom } from './keys.js';
import type { AccountFacts, StellarNetworkPort, Submitted } from './network.js';
import { invokeTx } from './txbuild.js';

const FACTORY = 'CB4AYBA5NVQPVPNOWUCSZQK6ZIGOF7KSCS6SF6UV6D2OKPDXLHEPD4V7';
const USDC_CONTRACT = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA';
const ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
const USDC = `USDC:${ISSUER}`;
const NOW_MS = 1_800_000_000_000;
const alice = testSigner('alice').publicKey;

const never = <T>() => new Promise<T>(() => undefined);

/** Accounts, preparing and sending, all in memory. */
class FakeNetwork implements StellarNetworkPort {
  facts = new Map<string, AccountFacts>();
  submitted: (Transaction | FeeBumpTransaction)[] = [];
  answers: Partial<Submitted>[] = [];
  /** Thrown by the next sends, in order, before anything is recorded as sent. */
  refusals: ChainError[] = [];
  ledgerFails = false;
  /** Prepared transactions carry this Soroban resource fee, as simulation sets one. */
  resourceFee = 0;

  account() {
    return Promise.resolve({ exists: true, xlm: '100', usdc: null });
  }
  accountFacts(address: string): Promise<AccountFacts> {
    return Promise.resolve(
      this.facts.get(address) ?? { exists: false, trustlines: [], memoRequired: false },
    );
  }
  loadAccount(address: string): Promise<Account> {
    return Promise.resolve(new Account(address, '100'));
  }
  prepare(tx: Transaction): Promise<Transaction> {
    if (this.resourceFee === 0) return Promise.resolve(tx);
    const data = new SorobanDataBuilder().setResourceFee(this.resourceFee).build();
    return Promise.resolve(TransactionBuilder.cloneFrom(tx, { sorobanData: data }).build());
  }
  submit(tx: Transaction | FeeBumpTransaction): Promise<Submitted> {
    const refused = this.refusals.shift();
    if (refused !== undefined) return Promise.reject(refused);
    this.submitted.push(tx);
    return Promise.resolve({
      hash: Buffer.from(tx.hash()).toString('hex'),
      status: 'SUCCESS',
      ...this.answers.shift(),
    });
  }
  friendbot(): Promise<void> {
    return Promise.resolve();
  }
  latestLedger(): Promise<number> {
    return this.ledgerFails
      ? Promise.reject(new ChainError('UNAVAILABLE', 'down'))
      : Promise.resolve(4242);
  }
}

/** An RPC that takes every call and never answers any of them. */
class SilentGateway implements SorobanGateway {
  read = () => never<never>();
  simulate = () => never<never>();
  invoke = () => never<never>();
  transaction = () => never<never>();
}

class SilentNetwork implements StellarNetworkPort {
  account = () => never<never>();
  accountFacts = () => never<never>();
  loadAccount = () => never<never>();
  prepare = () => never<never>();
  submit = () => never<never>();
  friendbot = () => never<never>();
  latestLedger = () => never<never>();
}

const sponsor = testSigner('fee-sponsor');

/** A budget that records what it was asked, and refuses when told to. */
class RecordingBudget implements FeeBudget {
  events: (
    | { kind: 'reserve'; fee: SponsoredFee }
    | { kind: 'settle'; fee: SponsoredFee; charged: bigint }
    | { kind: 'release'; fee: SponsoredFee }
  )[] = [];
  refuseWith: Error | undefined;

  reserve(fee: SponsoredFee): Promise<void> {
    this.events.push({ kind: 'reserve', fee });
    return this.refuseWith === undefined ? Promise.resolve() : Promise.reject(this.refuseWith);
  }
  settle(fee: SponsoredFee, charged: bigint): Promise<void> {
    this.events.push({ kind: 'settle', fee, charged });
    return Promise.resolve();
  }
  release(fee: SponsoredFee): Promise<void> {
    this.events.push({ kind: 'release', fee });
    return Promise.resolve();
  }
  kinds(): string[] {
    return this.events.map((e) => e.kind);
  }
}

const hex = (tx: Transaction | FeeBumpTransaction) => Buffer.from(tx.hash()).toString('hex');

function world(over: { gateway?: SorobanGateway; chain?: StellarNetworkPort } = {}) {
  const rpc = new FakeMandateRpc();
  rpc.allowRecipient(defaultRecipientRef(alice), alice);
  const chain = new FakeNetwork();
  const adapter = new StellarChainAdapter({
    gateway: over.gateway ?? rpc,
    chain: over.chain ?? chain,
    factory: FACTORY,
    asset: { code: 'USDC', issuer: ISSUER, contract: USDC_CONTRACT },
    feeSponsor: sponsor,
    now: () => NOW_MS,
  });
  return { rpc, chain, adapter, budget: new RecordingBudget() };
}

/** The same world without a fee sponsor, where a principal pays its own fee. */
function unsponsored() {
  const chain = new FakeNetwork();
  const adapter = new StellarChainAdapter({
    gateway: new FakeMandateRpc(),
    chain,
    factory: FACTORY,
    asset: { code: 'USDC', issuer: ISSUER, contract: USDC_CONTRACT },
    now: () => NOW_MS,
  });
  return { chain, adapter };
}

const o = (): CallOptions => callOptions('test');

async function chainError(work: () => Promise<unknown>): Promise<ChainError> {
  try {
    await work();
  } catch (error) {
    if (error instanceof ChainError) return error;
    throw error;
  }
  throw new Error('expected a ChainError');
}

function signed(req: SigningRequest, key = principal): string {
  const tx = TransactionBuilder.fromXdr(req.xdr, TESTNET_PASSPHRASE) as Transaction;
  key.sign(tx);
  return tx.toXdr();
}

function intent(task: string, amount: bigint, deadline = 1_800_000_300n): PayoutIntent {
  return {
    mandate: MANDATE,
    payoutId: payoutIdFor(MANDATE, task),
    taskRef: taskRefFor(task),
    recipientRef: defaultRecipientRef(alice),
    legs: [{ destination: alice, amount }],
    fee: 0n,
    deadline,
  };
}

describe('the chain adapter interface', () => {
  it('is version 1 of the Stellar adapter, with the error codes the payout model expects', () => {
    const { adapter } = world();
    const port: ChainAdapter = adapter;
    expect([port.version, port.network, CHAIN_ADAPTER_VERSION]).toEqual([1, 'stellar:testnet', 1]);
    expect(CHAIN_ERROR_CODES).toEqual([
      'TIMEOUT',
      'UNAVAILABLE',
      'INVALID_ADDRESS',
      'CONTRACT_REFUSED',
      'TX_FAILED',
      'SIGNATURE_INVALID',
      'SIGNING_REQUEST_MISMATCH',
    ]);
  });

  it('parses accounts and refuses anything else as INVALID_ADDRESS', async () => {
    const { adapter } = world();
    expect(adapter.parseAccount(` ${alice} `)).toBe(alice);
    for (const bad of ['', 'alice', MANDATE, alice.toLowerCase()]) {
      expect((await chainError(() => Promise.resolve(adapter.parseAccount(bad)))).code).toBe(
        'INVALID_ADDRESS',
      );
    }
    expect((await chainError(() => adapter.readMandate(alice, o()))).code).toBe('INVALID_ADDRESS');
  });

  it('reads the mandate and the chain health', async () => {
    const { adapter, chain } = world();
    const { config, state } = await adapter.readMandate(MANDATE, o());
    expect(config.principal).toBe(principal.publicKey);
    expect(state.balance).toBe(500n * UNIT);
    expect(await adapter.health(o())).toEqual({ ok: true, latestLedger: 4242 });
    chain.ledgerFails = true;
    expect(await adapter.health(o())).toEqual({ ok: false, latestLedger: 0 });
  });
});

describe('signing requests', () => {
  const ctx = {
    factory: FACTORY,
    usdc: { code: 'USDC', issuer: ISSUER, contract: USDC_CONTRACT },
    agent: agent.publicKey,
    executor: executor.publicKey,
    isRegistered: (id: string) => id === MANDATE,
  };
  const parse = (req: SigningRequest) =>
    TransactionBuilder.fromXdr(req.xdr, TESTNET_PASSPHRASE) as Transaction;

  it('builds a mandate action for the principal the chain names, whoever asks', async () => {
    const { adapter } = world();
    const req = await adapter.prepareMandateAction(MANDATE, { kind: 'pause' }, o());
    expect(req).toMatchObject({
      network: 'stellar:testnet',
      signer: principal.publicKey,
      action: 'pause',
      expiresAt: new Date(NOW_MS + 300_000).toISOString(),
    });
    expect(req.summary).toContain(`Pause mandate ${MANDATE}`);
    const tx = parse(req);
    expect(tx.source).toBe(principal.publicKey);
    const call = classify(tx, ctx);
    expect(call).toMatchObject({ kind: 'mandate', mandate: MANDATE, method: 'pause' });
    expect(call.kind === 'mandate' ? call.args.map(nativeOf) : null).toEqual([principal.publicKey]);
  });

  it('builds a create through the factory and a fund through the asset contract', async () => {
    const { adapter } = world();
    const limits = {
      totalBudget: 100n * UNIT,
      perPaymentCap: 10n * UNIT,
      perRecipientDailyCap: 20n * UNIT,
      approvalThreshold: 5n * UNIT,
      payoutTtlSeconds: 86_400n,
      expiresAt: 1_900_000_000n,
    };
    const create = {
      kind: 'create',
      principal: principal.publicKey,
      agent: agent.publicKey,
      executor: executor.publicKey,
      approvers: [approver.publicKey],
      approvalsRequired: 1,
      limits,
      recipients: [],
    } as const;
    const made = await adapter.prepareMandateAction(null, create, o());
    expect(made.signer).toBe(principal.publicKey);
    expect(made.summary).toContain(`The agent key ${agent.publicKey}`);
    expect(classify(parse(made), ctx)).toEqual({ kind: 'create', principal: principal.publicKey });

    const fund = await adapter.prepareMandateAction(
      MANDATE,
      { kind: 'fund', from: alice, amount: 7n * UNIT },
      o(),
    );
    expect(fund.signer).toBe(alice);
    expect(classify(parse(fund), ctx)).toEqual({
      kind: 'fund',
      mandate: MANDATE,
      amount: 7n * UNIT,
    });

    expect((await chainError(() => adapter.prepareMandateAction(MANDATE, create, o()))).code).toBe(
      'INVALID_ADDRESS',
    );
    expect(
      (await chainError(() => adapter.prepareMandateAction(null, { kind: 'resume' }, o()))).code,
    ).toBe('INVALID_ADDRESS');
    await expect(
      adapter.prepareMandateAction(
        null,
        {
          ...create,
          recipients: [{ recipientRef: defaultRecipientRef(alice), destination: alice }],
        },
        o(),
      ),
    ).rejects.toThrow(RangeError);
  });

  it('submits exactly the envelope it prepared, signed by its signer', async () => {
    const { adapter, chain } = unsponsored();
    const req = await adapter.prepareMandateAction(MANDATE, { kind: 'pause' }, o());
    const envelope = signed(req);
    const { txHash } = await adapter.submitSigned(envelope, req, o());
    expect(chain.submitted).toHaveLength(1);
    expect(chain.submitted[0]?.toXdr()).toBe(envelope);
    expect(txHash).toBe(hex(parse(req)));
  });

  it('names the contract a submitted create deployed, and only for a create', async () => {
    const { adapter, chain, budget } = world();
    const create = await adapter.prepareMandateAction(
      null,
      {
        kind: 'create',
        principal: principal.publicKey,
        agent: agent.publicKey,
        executor: executor.publicKey,
        approvers: [principal.publicKey],
        approvalsRequired: 1,
        limits: {
          totalBudget: 100n * UNIT,
          perPaymentCap: 10n * UNIT,
          perRecipientDailyCap: 20n * UNIT,
          approvalThreshold: 5n * UNIT,
          payoutTtlSeconds: 86_400n,
          expiresAt: 1_900_000_000n,
        },
        recipients: [],
      },
      o(),
    );
    chain.answers.push({ returnValue: address(MANDATE) });
    expect(await adapter.submitSigned(signed(create), create, o(), budget)).toMatchObject({
      contract: MANDATE,
    });
    // A create whose answer carries no address says so rather than guessing one.
    chain.answers.push({});
    expect(await adapter.submitSigned(signed(create), create, o(), budget)).not.toHaveProperty(
      'contract',
    );
    chain.answers.push({ returnValue: xdr.ScVal.scvU32(7) });
    expect(await adapter.submitSigned(signed(create), create, o(), budget)).not.toHaveProperty(
      'contract',
    );
    const pause = await adapter.prepareMandateAction(MANDATE, { kind: 'pause' }, o());
    chain.answers.push({ returnValue: address(MANDATE) });
    expect(await adapter.submitSigned(signed(pause), pause, o(), budget)).not.toHaveProperty(
      'contract',
    );
  });

  it('sends a principal signed envelope inside a fee bump the sponsor pays, charged to the budget', async () => {
    const { adapter, chain, budget } = world();
    const req = await adapter.prepareMandateAction(MANDATE, { kind: 'pause' }, o());
    const envelope = signed(req);
    chain.answers.push({ feeCharged: 150n });
    const { txHash } = await adapter.submitSigned(envelope, req, o(), budget);

    const sent = chain.submitted[0];
    if (!(sent instanceof FeeBumpTransaction)) throw new Error('expected a fee bump');
    expect(chain.submitted).toHaveLength(1);
    expect(sent.feeSource).toBe(sponsor.publicKey);
    expect(sent.innerTransaction.toXdr()).toBe(envelope);
    expect(sent.signatures).toHaveLength(1);
    expect(txHash).toBe(hex(sent));
    const fee = { innerTxHash: hex(parse(req)), maxFee: BigInt(sent.fee) };
    expect(budget.events).toEqual([
      { kind: 'reserve', fee },
      { kind: 'settle', fee, charged: 150n },
    ]);
  });

  it('bids the inner inclusion fee and passes the resource fee on, so the cap counts what it may cost', async () => {
    const { adapter, chain, budget } = world();
    chain.resourceFee = 1_000_000;
    const req = await adapter.prepareMandateAction(MANDATE, { kind: 'pause' }, o());
    expect(parse(req).fee).toBe('1010000');
    await adapter.submitSigned(signed(req), req, o(), budget);
    // The inner inclusion bid for the operation and again for the bump itself,
    // and the resource fee once.
    expect(chain.submitted[0]?.fee).toBe('1020000');
    expect(budget.events[0]).toMatchObject({ kind: 'reserve', fee: { maxFee: 1_020_000n } });
  });

  it('settles at the maximum when the network does not say what it charged', async () => {
    const { adapter, budget } = world();
    const req = await adapter.prepareMandateAction(MANDATE, { kind: 'pause' }, o());
    await adapter.submitSigned(signed(req), req, o(), budget);
    const [reserved, settled] = budget.events;
    expect(settled).toEqual({ kind: 'settle', fee: reserved?.fee, charged: reserved?.fee.maxFee });
  });

  it('sends nothing when the budget refuses the fee, and answers with its error', async () => {
    const { adapter, chain, budget } = world();
    const req = await adapter.prepareMandateAction(MANDATE, { kind: 'pause' }, o());
    const capped = new Error('over the cap');
    budget.refuseWith = capped;
    await expect(adapter.submitSigned(signed(req), req, o(), budget)).rejects.toBe(capped);
    expect(chain.submitted).toHaveLength(0);
    expect(budget.kinds()).toEqual(['reserve']);
  });

  it('refuses to sponsor without a budget, and sends nothing', async () => {
    const { adapter, chain } = world();
    const req = await adapter.prepareMandateAction(MANDATE, { kind: 'pause' }, o());
    expect((await chainError(() => adapter.submitSigned(signed(req), req, o()))).code).toBe(
      'UNAVAILABLE',
    );
    expect(chain.submitted).toHaveLength(0);
  });

  it('releases the fee when the network refused the transaction, and keeps it when the answer was lost', async () => {
    const { adapter, chain, budget } = world();
    const req = await adapter.prepareMandateAction(MANDATE, { kind: 'pause' }, o());
    chain.refusals.push(
      new ChainError('TX_FAILED', 'not accepted', { reason: 'tx_rejected' }),
      new ChainError('TIMEOUT', 'lost', { reason: 'submission_unknown' }),
    );
    expect((await chainError(() => adapter.submitSigned(signed(req), req, o(), budget))).code).toBe(
      'TX_FAILED',
    );
    expect(budget.kinds()).toEqual(['reserve', 'release']);
    budget.events = [];
    expect((await chainError(() => adapter.submitSigned(signed(req), req, o(), budget))).code).toBe(
      'TIMEOUT',
    );
    expect(budget.kinds()).toEqual(['reserve']);
  });

  it('settles the fee of a transaction that landed and failed, since the network charged for it', async () => {
    const { adapter, chain, budget } = world();
    const req = await adapter.prepareMandateAction(MANDATE, { kind: 'pause' }, o());
    chain.answers.push({ status: 'FAILED', reason: 'already_paused', feeCharged: 90n });
    const refused = await chainError(() => adapter.submitSigned(signed(req), req, o(), budget));
    expect([refused.code, refused.specError]).toEqual(['CONTRACT_REFUSED', 'ALREADY_PAUSED']);
    expect(budget.events[1]).toMatchObject({ kind: 'settle', charged: 90n });
  });

  it('refuses an envelope that differs from its request with SIGNING_REQUEST_MISMATCH', async () => {
    const { adapter, chain, budget } = world();
    const pause = await adapter.prepareMandateAction(MANDATE, { kind: 'pause' }, o());
    const resume = await adapter.prepareMandateAction(MANDATE, { kind: 'resume' }, o());
    const reject = await adapter.prepareMandateAction(
      MANDATE,
      { kind: 'reject', approver: approver.publicKey, payoutId: 'ab'.repeat(32) },
      o(),
    );

    const otherArgs = invokeTx(new Account(principal.publicKey, '100'), MANDATE, 'pause', [
      address(stranger.publicKey),
    ]);
    principal.sign(otherArgs);
    const otherSource = invokeTx(new Account(stranger.publicKey, '100'), MANDATE, 'pause', [
      address(principal.publicKey),
    ]);
    stranger.sign(otherSource);
    const inner = TransactionBuilder.fromXdr(signed(pause), TESTNET_PASSPHRASE) as Transaction;
    const bump = TransactionBuilder.buildFeeBumpTransaction(
      Keypair.random(),
      '20000',
      inner,
      TESTNET_PASSPHRASE,
    );

    const refusals: [string, string, SigningRequest][] = [
      ['another action', signed(resume), pause],
      ['the same method with other arguments', otherArgs.toXdr(), pause],
      ['another source account', otherSource.toXdr(), pause],
      ['a fee bump', bump.toXdr(), pause],
      ['unreadable bytes', 'garbage', pause],
      ['a request for another network', signed(pause), { ...pause, network: 'stellar:pubnet' }],
      [
        'an expired request',
        signed(pause),
        { ...pause, expiresAt: new Date(NOW_MS).toISOString() },
      ],
      [
        'a request signed for another approver',
        signed(reject, approver),
        { ...reject, signer: principal.publicKey },
      ],
    ];
    for (const [what, envelope, expected] of refusals) {
      const error = await chainError(() => adapter.submitSigned(envelope, expected, o(), budget));
      expect(error.code, what).toBe('SIGNING_REQUEST_MISMATCH');
    }
    expect(bump).toBeInstanceOf(FeeBumpTransaction);
    expect(chain.submitted).toHaveLength(0);
    // Refused before any fee is reserved, so a bad envelope costs the cap nothing.
    expect(budget.events).toEqual([]);
  });

  it('refuses an unsigned envelope or one signed by another key with SIGNATURE_INVALID', async () => {
    const { adapter, chain, budget } = world();
    const req = await adapter.prepareMandateAction(MANDATE, { kind: 'pause' }, o());
    for (const envelope of [req.xdr, signed(req, stranger)]) {
      expect((await chainError(() => adapter.submitSigned(envelope, req, o(), budget))).code).toBe(
        'SIGNATURE_INVALID',
      );
    }
    expect(chain.submitted).toHaveLength(0);
    expect(budget.events).toEqual([]);
  });

  it('names the contract refusal when a submitted transaction fails on chain', async () => {
    const { adapter, chain, budget } = world();
    const req = await adapter.prepareMandateAction(MANDATE, { kind: 'pause' }, o());
    chain.answers.push({ status: 'FAILED', reason: 'already_paused' });
    const refused = await chainError(() => adapter.submitSigned(signed(req), req, o(), budget));
    expect([refused.code, refused.specError]).toEqual(['CONTRACT_REFUSED', 'ALREADY_PAUSED']);
    chain.answers.push({ status: 'FAILED' });
    expect((await chainError(() => adapter.submitSigned(signed(req), req, o(), budget))).code).toBe(
      'TX_FAILED',
    );
  });

  it('wraps a principal signed envelope in a fee bump the sponsor pays', async () => {
    const { adapter } = world();
    const req = await adapter.prepareMandateAction(MANDATE, { kind: 'pause' }, o());
    const envelope = signed(req);
    const bumped = TransactionBuilder.fromXdr(
      await adapter.sponsorFee(envelope, principal.publicKey, o()),
      TESTNET_PASSPHRASE,
    );
    if (!(bumped instanceof FeeBumpTransaction)) throw new Error('expected a fee bump');
    expect(bumped.feeSource).toBe(sponsor.publicKey);
    expect(bumped.innerTransaction.toXdr()).toBe(envelope);
    expect(bumped.signatures).toHaveLength(1);

    expect((await chainError(() => adapter.sponsorFee(envelope, alice, o()))).code).toBe(
      'SIGNING_REQUEST_MISMATCH',
    );
    expect(
      (await chainError(() => adapter.sponsorFee(req.xdr, principal.publicKey, o()))).code,
    ).toBe('SIGNATURE_INVALID');
    const bare = new StellarChainAdapter({
      gateway: new FakeMandateRpc(),
      chain: new FakeNetwork(),
      factory: FACTORY,
      asset: { code: 'USDC', issuer: ISSUER, contract: USDC_CONTRACT },
    });
    expect((await chainError(() => bare.sponsorFee(envelope, principal.publicKey, o()))).code).toBe(
      'UNAVAILABLE',
    );
  });
});

describe('payouts through the adapter', () => {
  it('checks a payout by simulation and names the spec error it would hit', async () => {
    const { adapter, rpc } = world();
    expect(await adapter.checkPayout(intent('t1', 5n * UNIT), agent.publicKey, o())).toEqual({
      ok: true,
    });
    expect(await adapter.checkPayout(intent('t1', 51n * UNIT), agent.publicKey, o())).toEqual({
      ok: false,
      specError: 'PAYMENT_CAP_EXCEEDED',
    });
    rpc.paused = true;
    expect(await adapter.checkPayout(intent('t1', 5n * UNIT), agent.publicKey, o())).toEqual({
      ok: false,
      specError: 'MANDATE_PAUSED',
    });
    expect(rpc.payouts.size).toBe(0);
  });

  it('requests, reads and executes a payout, and names a refusal', async () => {
    const { adapter, rpc } = world();
    const id = payoutIdFor(MANDATE, 't2');
    expect(await adapter.payoutState(MANDATE, id, o())).toEqual({ kind: 'absent' });
    const requested = await adapter.requestPayout(intent('t2', 30n * UNIT), agent, o());
    expect(requested.txHash).toMatch(/^[0-9a-f]{64}$/);
    expect(await adapter.payoutState(MANDATE, id, o())).toEqual({ kind: 'pending', approvals: 0 });
    await adapter.mandate(MANDATE).approve(approver, id);
    expect(await adapter.payoutState(MANDATE, id, o())).toEqual({ kind: 'approved' });
    const executed = await adapter.executePayout(MANDATE, id, executor, o());
    expect(await adapter.payoutState(MANDATE, id, o())).toEqual({ kind: 'executed' });
    expect(rpc.paid).toEqual([{ destination: alice, amount: 30n * UNIT }]);
    expect(await adapter.transaction(executed.txHash, o())).toEqual({
      status: 'SUCCESS',
      ledger: 1,
    });
    expect(await adapter.transaction('0'.repeat(64), o())).toEqual({ status: 'NOT_FOUND' });

    const again = await chainError(() =>
      adapter.requestPayout(intent('t2', 30n * UNIT), agent, o()),
    );
    expect([again.code, again.specError]).toEqual(['CONTRACT_REFUSED', 'PAYOUT_ID_EXISTS']);
    const outsider = await chainError(() =>
      adapter.requestPayout(intent('t3', 1n * UNIT), signerFrom(Keypair.random()), o()),
    );
    expect([outsider.code, outsider.specError]).toEqual(['CONTRACT_REFUSED', 'UNAUTHORIZED']);
  });

  it('says whether a destination can receive the asset', async () => {
    const { adapter, chain } = world();
    const bob = testSigner('bob').publicKey;
    const carol = testSigner('carol').publicKey;
    chain.facts.set(alice, { exists: true, trustlines: [USDC], memoRequired: false });
    chain.facts.set(bob, { exists: true, trustlines: [], memoRequired: false });
    chain.facts.set(carol, { exists: true, trustlines: [USDC], memoRequired: true });
    expect(await adapter.checkDestination(alice, USDC, o())).toEqual({ receivable: true });
    expect(await adapter.checkDestination(bob, USDC, o())).toEqual({
      receivable: false,
      reason: 'NO_TRUSTLINE',
    });
    expect(await adapter.checkDestination(bob, 'native', o())).toEqual({ receivable: true });
    expect(await adapter.checkDestination(carol, USDC, o())).toEqual({
      receivable: false,
      reason: 'NEEDS_MEMO',
    });
    expect(await adapter.checkDestination(stranger.publicKey, USDC, o())).toEqual({
      receivable: false,
      reason: 'NO_ACCOUNT',
    });
    await expect(adapter.checkDestination(alice, 'USDC', o())).rejects.toThrow(RangeError);
  });
});

describe('deadlines', () => {
  it('aborts every network call at its deadline with TIMEOUT when the RPC never answers', async () => {
    const live = world();
    const pause = await live.adapter.prepareMandateAction(MANDATE, { kind: 'pause' }, o());
    const envelope = signed(pause);
    const { adapter, budget } = world({ gateway: new SilentGateway(), chain: new SilentNetwork() });
    const id = payoutIdFor(MANDATE, 't1');
    const calls: [string, (o: CallOptions) => Promise<unknown>][] = [
      ['health', (c) => adapter.health(c)],
      ['readMandate', (c) => adapter.readMandate(MANDATE, c)],
      ['prepareMandateAction', (c) => adapter.prepareMandateAction(MANDATE, { kind: 'pause' }, c)],
      ['submitSigned', (c) => adapter.submitSigned(envelope, pause, c, budget)],
      ['checkPayout', (c) => adapter.checkPayout(intent('t1', UNIT), agent.publicKey, c)],
      ['requestPayout', (c) => adapter.requestPayout(intent('t1', UNIT), agent, c)],
      ['executePayout', (c) => adapter.executePayout(MANDATE, id, executor, c)],
      ['payoutState', (c) => adapter.payoutState(MANDATE, id, c)],
      ['transaction', (c) => adapter.transaction('ab'.repeat(32), c)],
      ['checkDestination', (c) => adapter.checkDestination(alice, USDC, c)],
    ];
    for (const [name, call] of calls) {
      const started = Date.now();
      const error = await chainError(() => call(callOptions(name, 30)));
      expect(error.code, name).toBe('TIMEOUT');
      expect(Date.now() - started, name).toBeLessThan(2_000);
    }
  });

  it('refuses at once when the deadline has already passed', async () => {
    const { adapter } = world();
    const req = await adapter.prepareMandateAction(MANDATE, { kind: 'pause' }, o());
    const gone = new AbortController();
    gone.abort();
    const past: CallOptions = { signal: gone.signal, correlationId: 'late' };
    expect(
      (await chainError(() => adapter.sponsorFee(signed(req), principal.publicKey, past))).code,
    ).toBe('TIMEOUT');
    const { budget } = world();
    expect(
      (await chainError(() => adapter.submitSigned(signed(req), req, past, budget))).code,
    ).toBe('TIMEOUT');
    // A deadline already gone reserves nothing.
    expect(budget.events).toEqual([]);
    expect((await chainError(() => adapter.readMandate(MANDATE, past))).code).toBe('TIMEOUT');
  });
});

describe('wallet proofs and receipt references', () => {
  const holder = Keypair.fromRawEd25519Seed(createHash('sha256').update('holder').digest());
  const fields = {
    purpose: 'sign_in',
    address: holder.publicKey(),
    origin: 'https://ujira.co',
    nonce: 'n0nce-0123456789abcdef',
    issuedAt: '2026-11-26T10:00:00.000Z',
    expiresAt: '2026-11-26T10:10:00.000Z',
  } as const;

  it('writes the sign in message exactly as src/auth formats and parses it', () => {
    const { adapter } = world();
    const text = adapter.walletProofMessage(fields);
    expect(text).toBe(formatWalletMessage({ version: WALLET_MESSAGE_VERSION, ...fields }));
    expect(parseWalletMessage(text)).toEqual({ version: WALLET_MESSAGE_VERSION, ...fields });
    const recipient = adapter.walletProofMessage({ ...fields, purpose: 'recipient_wallet' });
    expect(parseWalletMessage(recipient).purpose).toBe('recipient_wallet');
  });

  it('refuses a non Stellar address, and leaves the other fields to the auth format', () => {
    const { adapter } = world();
    const refused = (over: { address?: string; nonce?: string; origin?: string }) => {
      try {
        adapter.walletProofMessage({ ...fields, ...over });
      } catch (error) {
        if (error instanceof ChainError) return error.code;
        if (error instanceof WalletMessageError) return error.code;
      }
      return undefined;
    };
    expect(refused({ address: MANDATE })).toBe('INVALID_ADDRESS');
    expect(refused({ nonce: 'short' })).toBe('MESSAGE_MALFORMED');
    expect(refused({ nonce: `${fields.nonce}\nPurpose: sign_in` })).toBe('MESSAGE_MALFORMED');
    expect(refused({ origin: 'https://ujira.co/app' })).toBe('MESSAGE_MALFORMED');
  });

  it('verifies what src/auth checks, with the adapter as its verifier', async () => {
    const { adapter } = world();
    const message = adapter.walletProofMessage(fields);
    const signature = Buffer.from(holder.signMessage(message)).toString('base64');
    const checked = await verifyWalletMessage(
      {
        message,
        address: holder.publicKey(),
        signature,
        expected: { purpose: 'sign_in', origin: 'https://ujira.co' },
        now: new Date('2026-11-26T10:05:00.000Z'),
      },
      { verifier: adapter, nonces: { consume: () => Promise.resolve(true) } },
    );
    expect(checked.address).toBe(holder.publicKey());
  });

  it('verifies SEP-53 signatures and nothing else', () => {
    const { adapter } = world();
    const message = adapter.walletProofMessage(fields);
    const signature = Buffer.from(holder.signMessage(message)).toString('base64');
    expect(adapter.verifyWalletProof(holder.publicKey(), message, signature)).toBe(true);

    // The same construction, computed without the Stellar library: ed25519
    // over SHA-256 of the SEP-53 prefix and the message.
    const digest = createHash('sha256')
      .update(Buffer.concat([Buffer.from('Stellar Signed Message:\n'), Buffer.from(message)]))
      .digest();
    const key = createPrivateKey({
      format: 'jwk',
      key: {
        kty: 'OKP',
        crv: 'Ed25519',
        d: Buffer.from(holder.rawSecretKey()).toString('base64url'),
        x: Buffer.from(holder.rawPublicKey()).toString('base64url'),
      },
    });
    const independent = edSign(null, digest, key).toString('base64');
    expect(independent).toBe(signature);

    expect(adapter.verifyWalletProof(alice, message, signature)).toBe(false);
    expect(adapter.verifyWalletProof(holder.publicKey(), `${message} `, signature)).toBe(false);
    expect(adapter.verifyWalletProof(holder.publicKey(), message, signature.slice(1))).toBe(false);
    expect(adapter.verifyWalletProof(holder.publicKey(), message, 'not base64')).toBe(false);
    expect(adapter.verifyWalletProof('nobody', message, signature)).toBe(false);
    const raw = Buffer.from(holder.sign(Buffer.from(message))).toString('base64');
    expect(adapter.verifyWalletProof(holder.publicKey(), message, raw)).toBe(false);
  });

  it('formats receipt references for this network', () => {
    const { adapter } = world();
    const hash = 'AB'.repeat(32);
    expect(adapter.receiptRef(hash, 0)).toBe(`ujira:tx:v1:stellar:testnet:${'ab'.repeat(32)}:0`);
    expect(adapter.receiptRef('cd'.repeat(32), 3)).toBe(
      `ujira:tx:v1:stellar:testnet:${'cd'.repeat(32)}:3`,
    );
    for (const [h, i] of [
      ['ab', 0],
      ['ab'.repeat(32), -1],
      ['ab'.repeat(32), 1.5],
    ] as const) {
      expect(() => adapter.receiptRef(h, i)).toThrow(RangeError);
    }
  });
});
