// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

import { describe, expect, it } from 'vitest';

import { ApiError } from './api';
import { createFakeAuthApi, type FakeAuthApi } from './fakeAuth';
import { FAKE_ASSET, FAKE_NETWORK, FAKE_SCALE, createFakeV1Api, type FakeV1Api } from './fakeV1';
import type { PrepareMandateInput } from './v1';
import type { TokenAmount } from './v1Schemas';

const ALICE = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
const BOB = 'GBT7ITQKEX3Z2YWIYLPRQ5W3JLA2TJ3JTABB765ZYNG7VLX5YYUPI3DT';
const UNIT = 10_000_000n;

const usdc = (whole: bigint): TokenAmount => ({
  amount: whole * UNIT,
  asset: FAKE_ASSET,
  network: FAKE_NETWORK,
  scale: FAKE_SCALE,
});

async function signedIn(address: string, auth: FakeAuthApi = createFakeAuthApi({ delayMs: 0 })) {
  const c = await auth.challenge(address);
  await auth.startSession({ challengeId: c.challengeId, address, signature: 'sig' });
  const { project } = await auth.createPrincipal('Acme Ltd');
  auth.useProject(project.id);
  return { auth, project };
}

const RULES: PrepareMandateInput = {
  approvers: [],
  approvalsRequired: 1,
  recipients: [],
  limits: {
    totalBudget: usdc(1_000n),
    perPaymentCap: usdc(100n),
    perRecipientDailyCap: usdc(200n),
    approvalThreshold: usdc(50n),
    payoutTtlSeconds: 86_400,
    expiresAt: '2099-01-01T00:00:00.000Z',
  },
};

/** A funded mandate and a recipient with a wallet, made through the routes themselves. */
async function ready(v1: FakeV1Api) {
  const create = await v1.prepareMandate(RULES);
  const { mandateId } = await v1.submitSigned(create.id, 'signed');
  const id = mandateId ?? '';
  const fund = await v1.mandateAction(id, { kind: 'fund', amount: 500n * UNIT });
  await v1.submitSigned(fund.id, 'signed');
  const { recipient } = await v1.createRecipient({ label: 'Ada', address: BOB });
  return { mandateId: id, recipientId: recipient.id };
}

async function setup() {
  const { auth, project } = await signedIn(ALICE);
  const v1 = createFakeV1Api(auth, { delayMs: 0, demo: false });
  return { auth, v1, project, ...(await ready(v1)) };
}

describe('the fake /v1 API', () => {
  it('needs a session, and says so to the session listeners', async () => {
    const auth = createFakeAuthApi({ delayMs: 0 });
    const v1 = createFakeV1Api(auth, { delayMs: 0 });
    let lost = 0;
    auth.onSessionLost(() => {
      lost += 1;
    });
    await expect(v1.payouts()).rejects.toMatchObject({ code: 'SESSION_INVALID', status: 401 });
    expect(lost).toBe(1);
  });

  it('answers SESSION_INVALID once the session lapses', async () => {
    const { auth, v1 } = await setup();
    auth.expire();
    await expect(v1.mandates()).rejects.toMatchObject({ code: 'SESSION_INVALID' });
  });

  it('keeps each project to itself', async () => {
    const { auth, v1, mandateId, project } = await setup();
    const other = await auth.createProject(project.principalId, 'Other');
    auth.useProject(other.id);
    expect((await v1.mandates()).items).toHaveLength(0);
    await expect(v1.mandate(mandateId)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    auth.useProject(project.id);
    expect((await v1.mandate(mandateId)).id).toBe(mandateId);
  });

  it("refuses another member's project as if it did not exist", async () => {
    const shared = createFakeAuthApi({ delayMs: 0 });
    const { project } = await signedIn(ALICE, shared);
    const v1 = createFakeV1Api(shared, { delayMs: 0 });
    await signedIn(BOB, shared);
    shared.useProject(project.id);
    await expect(v1.mandates()).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
  });

  it('starts each project with demo data when asked', async () => {
    const { auth } = await signedIn(ALICE);
    const v1 = createFakeV1Api(auth, { delayMs: 0 });
    const [m] = (await v1.mandates()).items;
    expect(m?.config.principal).toBe(ALICE);
    const statuses = (await v1.payouts()).items.map((p) => p.status).sort();
    expect(statuses).toEqual(['blocked', 'paid', 'pending_approval']);
    expect((await v1.approvals()).items).toHaveLength(1);
  });

  it('pays under the threshold, holds at it for approval, and blocks over the cap', async () => {
    const { v1, mandateId, recipientId } = await setup();
    const pay = (taskId: string, whole: bigint) =>
      v1.createPayout({ mandateId, recipientId, amount: usdc(whole), taskId }, `key-${taskId}`);
    const paid = await pay('t-1', 10n);
    expect(paid).toMatchObject({ status: 'paid', blockedBy: null });
    expect(paid.legs[0]?.txHash).toMatch(/^[0-9a-f]{64}$/);
    expect(paid.receiptId).not.toBeNull();

    const held = await pay('t-2', 50n);
    expect(held).toMatchObject({ status: 'pending_approval', receiptId: null });

    const blocked = await pay('t-3', 101n);
    expect(blocked).toMatchObject({
      status: 'blocked',
      blockedBy: 'PAYMENT_CAP_EXCEEDED',
      onChainPayoutId: null,
    });
    // A refusal is a record with a receipt, not an error.
    expect(blocked.receiptId).not.toBeNull();

    const m = await v1.mandate(mandateId);
    expect(m.state.balance.amount).toBe(490n * UNIT);
    expect(m.state.committed.amount).toBe(50n * UNIT);
    expect(m.state.free.amount).toBe(440n * UNIT);
    expect(m.state.spent.amount).toBe(10n * UNIT);
  });

  it('replays the same key and body, and refuses the same key with another body', async () => {
    const { v1, mandateId, recipientId } = await setup();
    const body = { mandateId, recipientId, amount: usdc(5n), taskId: 't-1' };
    const first = await v1.createPayout(body, 'run-1');
    const again = await v1.createPayout(body, 'run-1');
    expect(again.id).toBe(first.id);
    expect((await v1.payouts()).items).toHaveLength(1);
    await expect(v1.createPayout({ ...body, amount: usdc(6n) }, 'run-1')).rejects.toMatchObject({
      code: 'IDEMPOTENCY_KEY_REUSED',
      status: 422,
    });
    await expect(v1.createPayout(body, 'run-2')).rejects.toMatchObject({
      code: 'TASK_ID_REUSED',
      status: 409,
    });
    await expect(v1.createPayout(body, '')).rejects.toMatchObject({
      code: 'IDEMPOTENCY_KEY_INVALID',
    });
  });

  it('takes only the key characters the server takes', async () => {
    const { v1, mandateId, recipientId } = await setup();
    const body = { mandateId, recipientId, amount: usdc(5n), taskId: 't-2' };
    for (const key of ['run/1', 'run 1', 'run#1', 'k'.repeat(256)]) {
      await expect(v1.createPayout(body, key)).rejects.toMatchObject({
        code: 'IDEMPOTENCY_KEY_INVALID',
        status: 400,
      });
    }
    const ok = await v1.createPayout(body, `${'k'.repeat(250)}_.:-9`);
    expect(ok.taskId).toBe('t-2');
  });

  it('refuses an amount in another asset or of zero', async () => {
    const { v1, mandateId, recipientId } = await setup();
    await expect(
      v1.createPayout(
        { mandateId, recipientId, amount: { ...usdc(1n), asset: 'EURC' }, taskId: 'a' },
        'a',
      ),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    await expect(
      v1.createPayout({ mandateId, recipientId, amount: usdc(0n), taskId: 'b' }, 'b'),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });

  it('blocks a recipient with no wallet with the rule that refused it', async () => {
    const { v1, mandateId } = await setup();
    const { recipient, signingRequest } = await v1.createRecipient({ label: 'Kofi', mandateId });
    expect(signingRequest).toBeNull();
    const p = await v1.createPayout(
      { mandateId, recipientId: recipient.id, amount: usdc(1n), taskId: 'k' },
      'k',
    );
    expect(p).toMatchObject({ status: 'blocked', blockedBy: 'RECIPIENT_HAS_NO_METHOD' });
  });

  it('approves and rejects through a signed mandate action, then issues the receipt', async () => {
    const { v1, mandateId, recipientId } = await setup();
    const a = await v1.createPayout(
      { mandateId, recipientId, amount: usdc(60n), taskId: 'a' },
      'a',
    );
    const b = await v1.createPayout(
      { mandateId, recipientId, amount: usdc(70n), taskId: 'b' },
      'b',
    );
    expect((await v1.approvals()).items.map((p) => p.id).sort()).toEqual([a.id, b.id].sort());

    const approve = await v1.mandateAction(mandateId, { kind: 'approve', payoutId: a.id });
    expect(approve).toMatchObject({ action: 'approve', signer: ALICE });
    // Nothing changes until the signed transaction comes back.
    expect((await v1.payout(a.id)).status).toBe('pending_approval');
    await v1.submitSigned(approve.id, 'signed');
    const reject = await v1.mandateAction(mandateId, { kind: 'reject', payoutId: b.id });
    await v1.submitSigned(reject.id, 'signed');

    expect((await v1.payout(a.id)).status).toBe('paid');
    expect((await v1.payout(b.id)).status).toBe('rejected');
    expect((await v1.approvals()).items).toHaveLength(0);
    expect((await v1.mandate(mandateId)).state.committed.amount).toBe(0n);
    const outcomes = (await v1.receipts()).items.map((r) => r.outcome).sort();
    expect(outcomes).toEqual(['paid', 'rejected']);
  });

  it('names the owner as the approver, and lists what waits oldest first', async () => {
    let clock = Date.parse('2026-11-27T09:00:00.000Z');
    const { auth } = await signedIn(ALICE);
    const v1 = createFakeV1Api(auth, { delayMs: 0, demo: false, now: () => clock });
    const { mandateId, recipientId } = await ready(v1);
    expect((await v1.mandate(mandateId)).config.approvers).toEqual([ALICE]);
    const ids: string[] = [];
    for (const task of ['first', 'second', 'third']) {
      clock += 60_000;
      const p = await v1.createPayout(
        { mandateId, recipientId, amount: usdc(60n), taskId: task },
        task,
      );
      ids.push(p.id);
    }
    expect((await v1.approvals()).items.map((p) => p.id)).toEqual(ids);
  });

  it('takes a decision only from an approver, and signs it as that approver', async () => {
    const { v1, mandateId, recipientId } = await setup();
    const create = await v1.prepareMandate({ ...RULES, approvers: [BOB] });
    const other = (await v1.submitSigned(create.id, 'signed')).mandateId ?? '';
    const fund = await v1.mandateAction(other, { kind: 'fund', amount: 500n * UNIT });
    await v1.submitSigned(fund.id, 'signed');
    const held = await v1.createPayout(
      { mandateId: other, recipientId, amount: usdc(60n), taskId: 'held' },
      'held',
    );
    await expect(
      v1.mandateAction(other, { kind: 'approve', payoutId: held.id }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
    await expect(
      v1.mandateAction(other, { kind: 'reject', payoutId: held.id }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(v1.signingRequests()).toBe(0);
    expect((await v1.payout(held.id)).status).toBe('pending_approval');

    const mine = await v1.createPayout(
      { mandateId, recipientId, amount: usdc(60n), taskId: 'mine' },
      'mine',
    );
    const approve = await v1.mandateAction(mandateId, { kind: 'approve', payoutId: mine.id });
    expect(approve.signer).toBe(ALICE);
  });

  it('spends a signing request once', async () => {
    const { v1, mandateId } = await setup();
    const pause = await v1.mandateAction(mandateId, { kind: 'pause' });
    expect(v1.signingRequests()).toBe(1);
    await v1.submitSigned(pause.id, 'signed');
    expect((await v1.mandate(mandateId)).status).toBe('paused');
    await expect(v1.submitSigned(pause.id, 'signed')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(v1.signingRequests()).toBe(0);
  });

  it('keeps the name a mandate was created with, and checks its recipients', async () => {
    const { v1, recipientId } = await setup();
    await expect(v1.prepareMandate({ ...RULES, name: '  ' })).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
    });
    await expect(
      v1.prepareMandate({ ...RULES, name: 'Grants', recipients: ['not-a-recipient'] }),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    const { recipient: noWallet } = await v1.createRecipient({ label: 'Kofi' });
    await expect(
      v1.prepareMandate({ ...RULES, name: 'Grants', recipients: [noWallet.id] }),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    const create = await v1.prepareMandate({
      ...RULES,
      name: ' Grants ',
      recipients: [recipientId],
    });
    const { mandateId } = await v1.submitSigned(create.id, 'signed');
    expect((await v1.mandate(mandateId ?? '')).name).toBe('Grants');
  });

  it('refuses a withdrawal of more than is free', async () => {
    const { v1, mandateId } = await setup();
    await expect(
      v1.mandateAction(mandateId, { kind: 'withdraw', amount: 501n * UNIT }),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });

  it('pages with an opaque cursor, and filters by status', async () => {
    const { v1, mandateId, recipientId } = await setup();
    for (let i = 0; i < 5; i += 1) {
      await v1.createPayout(
        { mandateId, recipientId, amount: usdc(1n), taskId: `t-${String(i)}` },
        `k-${String(i)}`,
      );
    }
    await v1.createPayout({ mandateId, recipientId, amount: usdc(99n), taskId: 'big' }, 'big');
    const first = await v1.payouts({ limit: 4 });
    expect(first.items).toHaveLength(4);
    expect(first.nextCursor).not.toBeNull();
    const second = await v1.payouts({ limit: 4, cursor: first.nextCursor ?? '' });
    expect(second.items).toHaveLength(2);
    expect(second.nextCursor).toBeNull();
    const ids = new Set([...first.items, ...second.items].map((p) => p.id));
    expect(ids.size).toBe(6);
    expect((await v1.payouts({ status: 'pending_approval' })).items).toHaveLength(1);
    await expect(v1.payouts({ cursor: 'forged' })).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
    });
    await expect(v1.payouts({ limit: 0 })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });

  it('exports receipts as CSV, with a formula looking label made safe', async () => {
    const { v1, mandateId } = await setup();
    const { recipient } = await v1.createRecipient({ label: '=SUM(A1)', address: BOB });
    await v1.createPayout(
      { mandateId, recipientId: recipient.id, amount: usdc(2n), taskId: 'csv' },
      'csv',
    );
    const csv = await v1.receiptsCsv();
    const [header, row] = csv.trim().split('\n');
    expect(header).toBe(
      'receipt_id,payout_id,task_id,recipient,amount,asset,outcome,blocked_by,tx_hash,issued_at',
    );
    expect(row).toContain(",'=SUM(A1),2.00,USDC,paid,");
  });

  it('verifies a paid receipt and names the field a refused one lacks', async () => {
    const { v1, mandateId, recipientId } = await setup();
    const paid = await v1.createPayout(
      { mandateId, recipientId, amount: usdc(1n), taskId: 'p' },
      'p',
    );
    const blocked = await v1.createPayout(
      { mandateId, recipientId, amount: usdc(500n), taskId: 'x' },
      'x',
    );
    expect(await v1.verifyReceipt(paid.receiptId ?? '')).toMatchObject({ matched: true });
    expect(await v1.verifyReceipt(blocked.receiptId ?? '')).toMatchObject({
      matched: false,
      field: 'txHash',
    });
  });

  it('shows a new API key secret once, and lists it without', async () => {
    const { v1 } = await setup();
    const { apiKey, secret } = await v1.createApiKey({
      name: 'Runner',
      scopes: ['payouts:write', 'payouts:read'],
    });
    expect(secret).toMatch(/^ujk_test_[0-9a-f]{48}$/);
    expect(secret.startsWith(apiKey.prefix)).toBe(true);
    const listed = (await v1.apiKeys()).items;
    expect(JSON.stringify(listed)).not.toContain(secret);
    await v1.revokeApiKey(apiKey.id);
    expect((await v1.apiKeys()).items[0]?.revokedAt).not.toBeNull();
    await expect(v1.createApiKey({ name: 'x', scopes: ['admin:all'] })).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
    });
  });

  it('refuses keys to a role that is not owner or admin', async () => {
    const { auth } = await setup();
    const tenant = auth.tenant();
    const viewer: FakeAuthApi = { ...auth, tenant: () => ({ ...tenant, role: 'viewer' }) };
    const asViewer = createFakeV1Api(viewer, { delayMs: 0, demo: false });
    await expect(asViewer.createApiKey({ name: 'k', scopes: ['payouts:read'] })).rejects.toSatisfy(
      (e: unknown) => e instanceof ApiError && e.code === 'FORBIDDEN' && e.requestId !== undefined,
    );
  });

  it('counts the overview from the payouts themselves', async () => {
    const { v1, mandateId, recipientId } = await setup();
    await v1.createPayout({ mandateId, recipientId, amount: usdc(3n), taskId: 'a' }, 'a');
    await v1.createPayout({ mandateId, recipientId, amount: usdc(4n), taskId: 'b' }, 'b');
    await v1.createPayout({ mandateId, recipientId, amount: usdc(80n), taskId: 'c' }, 'c');
    const o = await v1.overview();
    expect(o.paid[0]?.amount).toBe(7n * UNIT);
    expect(o.byStatus).toEqual({ paid: 2, pending_approval: 1 });
    expect(o.approvalsWaiting).toBe(1);
  });

  it('imports only a contract the chain names this member on', async () => {
    const contract = 'CB4AYBA5NVQPVPNOWUCSZQK6ZIGOF7KSCS6SF6UV6D2OKPDXLHEPD4V7';
    const { auth } = await signedIn(ALICE);
    const v1 = createFakeV1Api(auth, { delayMs: 0, demo: false, importable: [contract] });
    await expect(v1.importMandate('nope')).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    await expect(
      v1.importMandate('CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const m = await v1.importMandate(contract);
    expect(m.contractId).toBe(contract);
    expect((await v1.importMandate(contract)).id).toBe(m.id);
  });
});
