// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The engine with a rail that pays everyone through one shared destination
// and settles in two steps, as the SDP rail does.

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Keypair } from '@stellar/stellar-sdk';
import { describe, expect, it } from 'vitest';

import { createEngine, loadSettings } from '../src/config.js';
import { EngineError } from '../src/errors.js';
import { defaultRecipientRef } from '../src/ids.js';
import type { MandateClient } from '../src/mandate/client.js';
import {
  PartialSettlementError,
  type PayoutRail,
  type RailPayment,
  type RailSettlement,
} from '../src/rails/rail.js';
import { FakeMandateRpc, MANDATE, UNIT, executor, testSigner } from './fake-rpc.js';
import { alice, bob, setup } from './helpers.js';

const DIST = testSigner('sdp-distribution').publicKey;
const SDP_TX = 'cd'.repeat(32);
const usdc = (n: bigint) => (n * UNIT).toString();

/** A two step rail: the mandate pays DIST, then a second leg pays the person. */
class TwoStepRail implements PayoutRail {
  readonly name = 'sdp' as const;
  failSecondLeg = 0;
  readonly resumed: string[] = [];
  private readonly wallets = new Map([
    ['alice', alice],
    ['bob', bob],
  ]);

  resume?: (payment: RailPayment, txHash: string) => Promise<RailSettlement>;

  constructor(
    private readonly mandate: MandateClient,
    withResume = true,
  ) {
    if (withResume) {
      this.resume = (payment, txHash) => {
        this.resumed.push(payment.taskId);
        return Promise.resolve().then(() => this.secondLeg(txHash));
      };
    }
  }

  destinationFor(recipient: string): string {
    this.payee(recipient);
    return DIST;
  }

  payee(recipient: string): string {
    const wallet = this.wallets.get(recipient);
    if (wallet === undefined) throw new EngineError('input_invalid', 'not listed');
    return wallet;
  }

  async settle(payment: RailPayment): Promise<RailSettlement> {
    const { txHash } = await this.mandate.execute(executor, payment.payoutId);
    return this.secondLeg(txHash);
  }

  private secondLeg(txHash: string): RailSettlement {
    if (this.failSecondLeg > 0) {
      this.failSecondLeg--;
      throw new PartialSettlementError('submission_unknown', 'second leg pending', {
        mandateTxHash: txHash,
        sdpDisbursementId: 'disb-1',
      });
    }
    return { txHash, sdpDisbursementId: 'disb-1', sdpPaymentId: 'pay-1', sdpTxHash: SDP_TX };
  }
}

function sdpSetup(withResume = true) {
  let rail: TwoStepRail | undefined;
  const ctx = setup({
    rails: (m) => {
      rail = new TwoStepRail(m, withResume);
      return [rail];
    },
  });
  // The principal allowed alice through the shared destination, not bob.
  ctx.rpc.allowRecipient(defaultRecipientRef(alice), DIST);
  if (rail === undefined) throw new Error('rail not built');
  return { ...ctx, rail };
}

describe('a rail with a shared destination', () => {
  it('checks the allowlist and caps by the person, and keeps both hashes', async () => {
    const { engine, rpc } = sdpSetup();

    const r = await engine.requestPayout({
      task_id: 'sdp-1',
      recipient: 'alice',
      amount: usdc(5n),
      rail: 'sdp',
    });

    expect(r).toMatchObject({
      outcome: 'paid',
      rail: 'sdp',
      destination: DIST,
      sdp_disbursement_id: 'disb-1',
      sdp_payment_id: 'pay-1',
      sdp_tx_hash: SDP_TX,
    });
    expect(r.tx_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(rpc.paid).toEqual([{ destination: DIST, amount: 5n * UNIT }]);
    expect(rpc.daily.get(defaultRecipientRef(alice))).toBe(5n * UNIT);
  });

  it('blocks a person the principal did not allow, though the destination is allowed', async () => {
    const { engine, rpc } = sdpSetup();

    const quoted = await engine.quotePayout({ recipient: 'bob', amount: usdc(1n), rail: 'sdp' });
    const r = await engine.requestPayout({
      task_id: 'sdp-bob',
      recipient: 'bob',
      amount: usdc(1n),
      rail: 'sdp',
    });

    expect(quoted).toMatchObject({ decision: 'blocked', reason: 'recipient_not_allowed' });
    expect(r).toMatchObject({ outcome: 'blocked', reason: 'recipient_not_allowed' });
    expect(rpc.paid).toEqual([]);
  });

  it('keeps a payout the mandate paid but the rail did not finish, and finishes it once', async () => {
    const { engine, rpc, rail, receipts } = sdpSetup();
    rail.failSecondLeg = 1;
    const input = { task_id: 'sdp-2', recipient: 'alice', amount: usdc(3n), rail: 'sdp' };

    await expect(engine.requestPayout(input)).rejects.toBeInstanceOf(PartialSettlementError);
    const settling = await receipts.find(MANDATE, 'sdp-2');
    expect(settling).toMatchObject({
      outcome: 'settling',
      settles_as: 'paid',
      reason: 'submission_unknown',
      sdp_disbursement_id: 'disb-1',
    });
    expect(settling?.tx_hash).toMatch(/^[0-9a-f]{64}$/);
    expect((await engine.payoutStatus({ task_id: 'sdp-2' })).onchain_status).toBe('executed');

    const done = await engine.requestPayout(input);

    expect(done).toMatchObject({
      outcome: 'paid',
      tx_hash: settling?.tx_hash,
      sdp_tx_hash: SDP_TX,
    });
    expect(done.reason).toBeUndefined();
    expect(done.settles_as).toBeUndefined();
    expect(done.request_tx_hash).toBe(settling?.request_tx_hash);
    expect(rail.resumed).toEqual(['sdp-2']);
    expect(rpc.paid).toHaveLength(1);
    expect(await engine.requestPayout(input)).toEqual(done);
    expect(rail.resumed).toEqual(['sdp-2']);
  });

  it('stays settling while the second leg keeps failing', async () => {
    const { engine, rail, receipts } = sdpSetup();
    rail.failSecondLeg = 2;
    const input = { task_id: 'sdp-3', recipient: 'alice', amount: usdc(3n), rail: 'sdp' };

    await expect(engine.requestPayout(input)).rejects.toThrow('second leg pending');
    await expect(engine.requestPayout(input)).rejects.toThrow('second leg pending');

    expect((await receipts.find(MANDATE, 'sdp-3'))?.outcome).toBe('settling');
    expect((await engine.requestPayout(input)).outcome).toBe('paid');
  });

  it('marks a settling payout paid when the rail has nothing left to finish', async () => {
    const { engine, rail } = sdpSetup(false);
    rail.failSecondLeg = 1;
    const input = { task_id: 'sdp-4', recipient: 'alice', amount: usdc(3n), rail: 'sdp' };
    await expect(engine.requestPayout(input)).rejects.toThrow();

    const done = await engine.requestPayout(input);

    expect(done.outcome).toBe('paid');
    expect(done.tx_hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('SDP settings', () => {
  const kp = Keypair.random();
  const file = join(mkdtempSync(join(tmpdir(), 'ujira-mcp-')), 'mandate.json');
  writeFileSync(
    file,
    JSON.stringify({
      mandate: MANDATE,
      asset: { code: 'USDC', issuer: DIST },
      recipients: [
        { recipient_ref: 'ab'.repeat(32), destination: alice, name: 'recipient-1' },
        { recipient_ref: 'cd'.repeat(32), destination: bob },
      ],
    }),
  );
  const base = {
    UJIRA_MANDATE_FILE: file,
    UJIRA_AGENT_SECRET: kp.secret(),
    UJIRA_SDP_URL: 'http://localhost:8000',
    UJIRA_SDP_API_KEY: 'SDP_id.secret',
    UJIRA_SDP_DISTRIBUTION: DIST,
  };

  it('offers the SDP rail when its settings are present', async () => {
    const s = loadSettings({ ...base, UJIRA_SDP_TENANT: 'default' });
    expect(s.sdp).toMatchObject({
      url: 'http://localhost:8000',
      tenant: 'default',
      distributionAccount: DIST,
      assetIssuer: DIST,
      recipients: { 'recipient-1': alice },
    });
    const rpc = new FakeMandateRpc();
    rpc.agents = [kp.publicKey()];
    rpc.allowRecipient('ab'.repeat(32), DIST);
    const { engine } = createEngine(s, {
      gateway: rpc,
      now: () => new Date(Number(rpc.now) * 1000),
    });
    const q = await engine.quotePayout({ recipient: 'recipient-1', amount: '10', rail: 'sdp' });
    expect(q).toMatchObject({ decision: 'allowed', rail: 'sdp', destination: DIST });
  });

  it('leaves SDP out without a URL', () => {
    expect(loadSettings({ ...base, UJIRA_SDP_URL: '' }).sdp).toBeUndefined();
  });

  it.each([
    ['UJIRA_SDP_API_KEY', /UJIRA_SDP_API_KEY/],
    ['UJIRA_SDP_DISTRIBUTION', /UJIRA_SDP_DISTRIBUTION/],
  ])('refuses SDP settings without %s', (name, message) => {
    expect(() => loadSettings({ ...base, [name]: '' })).toThrow(message);
  });

  it('needs an asset issuer from the environment or the mandate file', () => {
    const bare = join(mkdtempSync(join(tmpdir(), 'ujira-mcp-')), 'm.json');
    writeFileSync(bare, JSON.stringify({ mandate: MANDATE }));
    expect(() => loadSettings({ ...base, UJIRA_MANDATE_FILE: bare })).toThrow(
      /UJIRA_SDP_ASSET_ISSUER/,
    );
    expect(
      loadSettings({ ...base, UJIRA_MANDATE_FILE: bare, UJIRA_SDP_ASSET_ISSUER: DIST }).sdp
        ?.assetIssuer,
    ).toBe(DIST);
  });
});
