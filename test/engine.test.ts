// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

import { describe, expect, it } from 'vitest';

import { ContractRefusedError, EngineError } from '../src/errors.js';
import { defaultRecipientRef, payoutIdFor } from '../src/ids.js';
import { address, bytes32 } from '../src/mandate/codec.js';
import type { PayoutRail } from '../src/rails/rail.js';
import { MANDATE, UNIT, approver, feeAddress, principal } from './fake-rpc.js';
import { alice, bob, mallory, setup } from './helpers.js';

const usdc = (n: bigint) => (n * UNIT).toString();

describe('quotePayout', () => {
  it('predicts allowed, approval_required and blocked without sending anything', async () => {
    const { engine, rpc } = setup();
    expect((await engine.quotePayout({ recipient: alice, amount: usdc(5n) })).decision).toBe(
      'allowed',
    );
    expect((await engine.quotePayout({ recipient: alice, amount: usdc(20n) })).decision).toBe(
      'approval_required',
    );
    const capped = await engine.quotePayout({ recipient: alice, amount: usdc(51n) });
    expect(capped).toMatchObject({ decision: 'blocked', reason: 'payment_cap_exceeded' });
    expect(capped.headroom.perPaymentCap).toBe(usdc(50n));
    const stranger = await engine.quotePayout({ recipient: mallory, amount: usdc(1n) });
    expect(stranger).toMatchObject({ decision: 'blocked', reason: 'recipient_not_allowed' });
    expect(rpc.calls.filter((c) => c.startsWith('invoke'))).toEqual([]);
  });

  it('refuses a float, a negative or a non-numeric amount', async () => {
    const { engine } = setup();
    for (const amount of [1.5, '1.5', '-3', 'ten', '0']) {
      await expect(engine.quotePayout({ recipient: alice, amount })).rejects.toMatchObject({
        code: 'input_invalid',
      });
    }
  });

  it('refuses a recipient the rail cannot pay', async () => {
    const { engine } = setup();
    await expect(engine.quotePayout({ recipient: 'not-an-account', amount: '1' })).rejects.toThrow(
      /Stellar account/,
    );
  });

  it('refuses a rail that is not configured', async () => {
    const { engine } = setup();
    await expect(
      engine.quotePayout({ recipient: alice, amount: '1', rail: 'sdp' }),
    ).rejects.toMatchObject({ code: 'rail_unavailable' });
  });
});

describe('requestPayout', () => {
  it('pays a payout under the threshold and records a receipt', async () => {
    const { engine, rpc, receipts } = setup();
    const receipt = await engine.requestPayout({
      task_id: 'task-1',
      recipient: alice,
      amount: usdc(5n),
    });
    expect(receipt).toMatchObject({
      task_id: 'task-1',
      outcome: 'paid',
      amount: 5n * UNIT,
      asset: 'USDC',
      rail: 'usdc',
      recipient: alice,
      payout_id: payoutIdFor(MANDATE, 'task-1'),
      principal: principal.publicKey,
    });
    expect(receipt.tx_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(receipt.request_tx_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(rpc.paid).toEqual([{ destination: alice, amount: 5n * UNIT }]);
    expect(await receipts.list(MANDATE)).toHaveLength(1);
  });

  it('never pays a task twice, however often it is requested', async () => {
    const { engine, rpc } = setup();
    const first = await engine.requestPayout({ task_id: 't', recipient: alice, amount: usdc(5n) });
    const again = await engine.requestPayout({ task_id: 't', recipient: alice, amount: usdc(5n) });
    expect(again).toEqual(first);
    expect(rpc.paid).toHaveLength(1);
    expect(rpc.calls.filter((c) => c === 'invoke:execute')).toHaveLength(1);
  });

  it('refuses to reuse a task ID for another amount or recipient', async () => {
    const { engine } = setup();
    await engine.requestPayout({ task_id: 'big', recipient: alice, amount: usdc(25n) });
    await expect(
      engine.requestPayout({ task_id: 'big', recipient: alice, amount: usdc(26n) }),
    ).rejects.toMatchObject({ code: 'task_conflict' });
    await expect(
      engine.requestPayout({ task_id: 'big', recipient: bob, amount: usdc(25n) }),
    ).rejects.toMatchObject({ code: 'task_conflict' });
  });

  it('waits for approval at the threshold, then pays once a person approved', async () => {
    const { engine, rpc, mandate } = setup();
    const waiting = await engine.requestPayout({
      task_id: 'a1',
      recipient: alice,
      amount: usdc(25n),
    });
    expect(waiting.outcome).toBe('approval_required');
    expect(rpc.paid).toEqual([]);
    expect((await engine.payoutStatus({ task_id: 'a1' })).onchain_status).toBe('pending');

    // The agent asking again changes nothing while it waits.
    expect(
      (await engine.requestPayout({ task_id: 'a1', recipient: alice, amount: usdc(25n) })).outcome,
    ).toBe('approval_required');
    expect(rpc.paid).toEqual([]);

    await mandate.approve(approver, payoutIdFor(MANDATE, 'a1'));
    const paid = await engine.requestPayout({ task_id: 'a1', recipient: alice, amount: usdc(25n) });
    expect(paid.outcome).toBe('approved_then_paid');
    expect(paid.request_tx_hash).toBe(waiting.request_tx_hash);
    expect(paid.tx_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(rpc.paid).toEqual([{ destination: alice, amount: 25n * UNIT }]);
    expect((await engine.payoutStatus({ task_id: 'a1' })).onchain_status).toBe('executed');
  });

  it('records the contract refusal for a payment over the cap, and sends nothing', async () => {
    const { engine, rpc } = setup();
    const r = await engine.requestPayout({ task_id: 'cap', recipient: alice, amount: usdc(60n) });
    expect(r).toMatchObject({
      outcome: 'blocked',
      reason: 'payment_cap_exceeded',
      blocked_by: 'contract',
      contract_error: 41,
    });
    expect(r.tx_hash).toBeUndefined();
    expect(rpc.calls).toContain('simulate:request_payout');
    expect(rpc.calls.filter((c) => c.startsWith('invoke'))).toEqual([]);
  });

  it('blocks a recipient the principal never allowed', async () => {
    const { engine, rpc } = setup();
    const r = await engine.requestPayout({ task_id: 'who', recipient: mallory, amount: usdc(1n) });
    expect(r).toMatchObject({
      outcome: 'blocked',
      reason: 'recipient_not_allowed',
      contract_error: 50,
    });
    expect(rpc.paid).toEqual([]);
  });

  it('blocks a payment over the daily limit for that recipient', async () => {
    const { engine, rpc, receipts } = setup();
    for (let i = 0; i < 6; i++) {
      await engine.requestPayout({ task_id: `d${String(i)}`, recipient: bob, amount: usdc(19n) });
    }
    // 114 would pass 100 a day; the sixth is the one refused.
    const last = await receipts.list(MANDATE);
    expect(last.at(0)).toMatchObject({
      task_id: 'd5',
      outcome: 'blocked',
      reason: 'daily_cap_exceeded',
    });
    expect(rpc.paid).toHaveLength(5);
  });

  it('keeps a block the quote found even when the simulation would let it through', async () => {
    const { engine, rpc } = setup();
    // The fake contract does not refuse the fee address; the quote does.
    rpc.allowRecipient(defaultRecipientRef(feeAddress), feeAddress);
    const r = await engine.requestPayout({
      task_id: 'fee',
      recipient: feeAddress,
      amount: usdc(1n),
    });
    expect(r).toMatchObject({ outcome: 'blocked', reason: 'legs_invalid', blocked_by: 'quote' });
    expect(rpc.calls.filter((c) => c.startsWith('invoke'))).toEqual([]);
  });

  it('blocks while the principal has paused the mandate', async () => {
    const { engine, rpc } = setup();
    rpc.paused = true;
    const r = await engine.requestPayout({ task_id: 'p', recipient: alice, amount: usdc(1n) });
    expect(r).toMatchObject({ outcome: 'blocked', reason: 'mandate_paused', contract_error: 22 });
  });

  it('marks a payout an approver rejected as blocked', async () => {
    const { engine, rpc } = setup();
    await engine.requestPayout({ task_id: 'rj', recipient: alice, amount: usdc(30n) });
    await rpc.invoke(
      MANDATE,
      'reject',
      [address(approver.publicKey), bytes32(payoutIdFor(MANDATE, 'rj'))],
      approver,
    );
    const r = await engine.requestPayout({ task_id: 'rj', recipient: alice, amount: usdc(30n) });
    expect(r).toMatchObject({ outcome: 'blocked', reason: 'rejected_by_approver' });
  });

  it('recovers when the answer to a request was lost but the request landed', async () => {
    const { engine, rpc } = setup();
    rpc.loseAnswerOf = 'request_payout';
    const r = await engine.requestPayout({ task_id: 'lost', recipient: alice, amount: usdc(3n) });
    expect(r.outcome).toBe('paid');
    expect(rpc.paid).toHaveLength(1);
  });

  it('passes a failure that is not the contract to the caller', async () => {
    const { engine, rpc } = setup();
    rpc.loseAnswerOf = 'execute';
    await expect(
      engine.requestPayout({ task_id: 'ex', recipient: alice, amount: usdc(3n) }),
    ).rejects.toBeInstanceOf(EngineError);
    // The payment did land; asking again finds it executed and records it once.
    const r = await engine.requestPayout({ task_id: 'ex', recipient: alice, amount: usdc(3n) });
    expect(r.outcome).toBe('paid');
    expect(rpc.paid).toHaveLength(1);
  });

  it('records a settlement the mandate refused as blocked, leaving the payout approved', async () => {
    const refusing: PayoutRail = {
      name: 'usdc',
      destinationFor: (r) => r,
      settle: () => Promise.reject(new ContractRefusedError('execute', 42)),
    };
    const { engine } = setup({ rails: () => [refusing] });
    const r = await engine.requestPayout({ task_id: 'f', recipient: alice, amount: usdc(1n) });
    expect(r).toMatchObject({
      outcome: 'blocked',
      reason: 'daily_cap_exceeded',
      contract_error: 42,
    });
    expect(r.request_tx_hash).toMatch(/^[0-9a-f]{64}$/);
    expect((await engine.payoutStatus({ task_id: 'f' })).onchain_status).toBe('approved');
  });

  it('passes a rail failure that is not the contract to the caller', async () => {
    const failing: PayoutRail = {
      name: 'usdc',
      destinationFor: (r) => r,
      settle: () => Promise.reject(new Error('rail down')),
    };
    const { engine } = setup({ rails: () => [failing] });
    await expect(
      engine.requestPayout({ task_id: 'g', recipient: alice, amount: usdc(1n) }),
    ).rejects.toThrow('rail down');
  });

  it('hands a rail the payment and keeps its disbursement ID', async () => {
    const seen: unknown[] = [];
    const sdp: PayoutRail = {
      name: 'sdp',
      destinationFor: () => alice,
      settle: (p) => {
        seen.push(p);
        return Promise.resolve({ txHash: 'ab'.repeat(32), sdpDisbursementId: 'disb-1' });
      },
    };
    const { engine } = setup({ rails: () => [sdp] });
    const r = await engine.requestPayout({
      task_id: 's1',
      recipient: '+254700000000',
      amount: usdc(2n),
      rail: 'sdp',
    });
    expect(r).toMatchObject({ outcome: 'paid', rail: 'sdp', sdp_disbursement_id: 'disb-1' });
    expect(seen).toMatchObject([
      { destination: alice, recipient: '+254700000000', amount: 2n * UNIT },
    ]);
  });
});

describe('payoutStatus and receipts', () => {
  it('reports not_found for a task never requested', async () => {
    const { engine } = setup();
    expect(await engine.payoutStatus({ task_id: 'none' })).toMatchObject({
      onchain_status: 'not_found',
      receipt: null,
    });
  });

  it('lists receipts newest first and filters them', async () => {
    const { engine } = setup();
    await engine.requestPayout({ task_id: 'r1', recipient: alice, amount: usdc(1n) });
    await engine.requestPayout({ task_id: 'r2', recipient: alice, amount: usdc(60n) });
    const all = await engine.listReceipts({});
    expect(all.receipts.map((r) => r['task_id'])).toHaveLength(2);
    const blocked = await engine.listReceipts({ outcome: 'blocked' });
    expect(blocked.receipts).toMatchObject([{ task_id: 'r2', amount: usdc(60n) }]);
    expect((await engine.listReceipts({ task_id: 'r1', limit: 1 })).receipts).toHaveLength(1);
  });

  it('cross-checks receipts against the payout record and the ledger', async () => {
    const { engine, rpc } = setup();
    await engine.requestPayout({ task_id: 'v1', recipient: alice, amount: usdc(1n) });
    await engine.requestPayout({ task_id: 'v2', recipient: alice, amount: usdc(30n) });
    await engine.requestPayout({ task_id: 'v3', recipient: mallory, amount: usdc(1n) });
    const out = await engine.listReceipts({ verify: true });
    expect(out.verification?.every((v) => v.ok)).toBe(true);

    // A receipt the chain does not back is caught.
    rpc.txs.clear();
    const bad = await engine.listReceipts({ task_id: 'v1', verify: true });
    expect(bad.verification?.[0]?.ok).toBe(false);
  });
});
