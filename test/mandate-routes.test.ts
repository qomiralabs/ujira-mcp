// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The mandate routes against the fake RPC and a store that keeps the
// database's tenant rules: prepare, sign and submit a create; import; list
// and detail from the chain; actions; and every way a submit is refused.

import {
  FeeBumpTransaction,
  TransactionBuilder,
  scValToNative,
  type Transaction,
  type xdr,
} from '@stellar/stellar-sdk';
import { describe, expect, it } from 'vitest';

import { ChainError } from '../src/chain/adapter.js';
import { classify } from '../src/chain/stellar/allowlist.js';
import { TESTNET_PASSPHRASE } from '../src/chain/stellar/gateway.js';
import { defaultRecipientRef } from '../src/ids.js';
import type { FeeLedger, FeeReservation } from '../src/payouts/fee-sponsorship.js';
import {
  ASSET,
  MANDATE,
  UNIT,
  agent,
  approver,
  executor,
  principal,
  stranger,
} from './fake-rpc.js';
import { alice } from './helpers.js';
import {
  FACTORY,
  feeSponsor,
  ISSUER,
  codeOf,
  mandateHarness,
  prepareBody,
  signEnvelope,
  type MandateHarness,
  type Member,
} from './mandate-helpers.js';

type Answer = Awaited<ReturnType<MandateHarness['call']>>;

function signingRequestOf(a: Answer): Record<string, unknown> {
  const req = a.json?.['signingRequest'];
  if (typeof req !== 'object' || req === null) throw new Error('no signing request');
  return req as Record<string, unknown>;
}

function txOf(xdrText: unknown): Transaction {
  return TransactionBuilder.fromXdr(String(xdrText), TESTNET_PASSPHRASE) as Transaction;
}

let keyCounter = 0;
const nextKey = () => {
  keyCounter += 1;
  return `test-${String(keyCounter)}`;
};

async function submit(
  h: MandateHarness,
  member: Member,
  project: string,
  body: { signingRequestId: unknown; xdr: string },
  idempotencyKey = nextKey(),
) {
  return h.call('POST', '/v1/signing/submit', { member, project, body, idempotencyKey });
}

/** Prepares, signs and submits a create; the submit answer. */
async function createMandate(h: MandateHarness, member: Member, project: string, over = {}) {
  const prepared = await h.call('POST', '/v1/mandates/prepare', {
    member,
    project,
    body: prepareBody(over),
  });
  expect(prepared.status, JSON.stringify(prepared.json)).toBe(201);
  const req = signingRequestOf(prepared);
  return submit(h, member, project, {
    signingRequestId: req['id'],
    xdr: signEnvelope(String(req['xdr'])),
  });
}

describe('POST /v1/mandates/prepare', () => {
  it('names the owner as the one approver when no approvers are given', async () => {
    const h = mandateHarness();
    const { context, member } = await h.tenant();
    const res = await h.call('POST', '/v1/mandates/prepare', {
      member,
      project: context.projectId,
      body: prepareBody({ approvers: [] }),
    });
    const op = txOf(signingRequestOf(res)['xdr']).operations[0];
    if (op?.type !== 'invokeHostFunction' || op.func.type !== 'hostFunctionTypeInvokeContract') {
      throw new Error('expected a contract call');
    }
    const config = scValToNative(op.func.invokeContract.args[0] as xdr.ScVal) as {
      approvers: string[];
      approvals_required: number;
    };
    expect(config.approvers).toEqual([principal.publicKey]);
    expect(config.approvals_required).toBe(1);
  });

  it("builds the factory call naming the project's agent key and the UJIRA executor", async () => {
    const h = mandateHarness();
    const { context, member } = await h.tenant();
    // A client that always sends the field, empty, is served.
    const res = await h.call('POST', '/v1/mandates/prepare', {
      member,
      project: context.projectId,
      body: prepareBody({ recipients: [] }),
    });
    expect(res.status).toBe(201);
    const req = signingRequestOf(res);
    expect(req).toMatchObject({
      network: 'stellar:testnet',
      signer: principal.publicKey,
      action: 'create',
    });
    expect(String(req['summary'])).toContain(agent.publicKey);
    // The envelope is a create the console relay would accept: our factory,
    // USDC, this project's agent and the UJIRA executor.
    const kind = classify(txOf(req['xdr']), {
      factory: FACTORY,
      usdc: { code: 'USDC', issuer: ISSUER, contract: ASSET },
      agent: agent.publicKey,
      executor: executor.publicKey,
      isRegistered: () => false,
    });
    expect(kind).toEqual({ kind: 'create', principal: principal.publicKey });
    const stored = h.store.requests.get(String(req['id']))?.value;
    expect(stored).toMatchObject({
      action: 'create',
      mandateId: null,
      mandateName: 'Weekly payouts',
      submittedTxHash: null,
    });
    expect(stored?.agentKeyId).toBe([...h.store.agentKeys.values()][0]?.value.id);
  });

  it('refuses attested only recipients, since UJIRA holds the agent key', async () => {
    const h = mandateHarness();
    const { context, member } = await h.tenant();
    for (const recipientMode of ['attested', 'both']) {
      const res = await h.call('POST', '/v1/mandates/prepare', {
        member,
        project: context.projectId,
        body: prepareBody({ recipientMode }),
      });
      expect(res.status, recipientMode).toBe(422);
      expect(codeOf(res)).toBe('RECIPIENT_MODE_UNSUPPORTED');
    }
    expect(h.store.requests.size).toBe(0);
  });

  it('refuses rules the contract would refuse, a foreign asset and unknown recipients', async () => {
    const h = mandateHarness();
    const { context, member } = await h.tenant();
    const token = (amount: string, asset = 'USDC') => ({
      amount,
      asset,
      network: 'stellar:testnet',
      scale: 7,
    });
    const cases: [Record<string, unknown>, string, string][] = [
      [
        { limits: { ...prepareBody().limits, perPaymentCap: token('9000000000') } },
        'body.limits.perPaymentCap',
        'above_total_budget',
      ],
      [
        { limits: { ...prepareBody().limits, expiresAt: new Date(h.clock.now).toISOString() } },
        'body.limits.expiresAt',
        'too_soon',
      ],
      // A recipient belongs to one mandate, added once that mandate exists.
      [{ recipients: [crypto.randomUUID()] }, 'body.recipients', 'too_big'],
      [{ approvalsRequired: 2 }, 'body.approvalsRequired', 'out_of_range'],
    ];
    for (const [over, path, issue] of cases) {
      const res = await h.call('POST', '/v1/mandates/prepare', {
        member,
        project: context.projectId,
        body: prepareBody(over),
      });
      expect(res.status, path).toBe(400);
      expect(res.json).toMatchObject({
        error: { code: 'INVALID_REQUEST', details: [{ path, issue }] },
      });
    }
    const foreign = await h.call('POST', '/v1/mandates/prepare', {
      member,
      project: context.projectId,
      body: prepareBody({ limits: { ...prepareBody().limits, totalBudget: token('1', 'EURC') } }),
    });
    expect(foreign.status).toBe(400);
    expect(JSON.stringify(foreign.json)).not.toContain('EURC');
    const extra = await h.call('POST', '/v1/mandates/prepare', {
      member,
      project: context.projectId,
      body: { ...prepareBody(), agent: stranger.publicKey },
    });
    expect(extra.status).toBe(400);
    expect(h.store.requests.size).toBe(0);
  });

  it("makes the project's own agent key on first use and names it", async () => {
    const h = mandateHarness({ provision: true });
    const { context, member } = await h.tenant({ withKey: false });
    expect(h.store.agentKeys.size).toBe(0);
    const res = await h.call('POST', '/v1/mandates/prepare', {
      member,
      project: context.projectId,
      body: prepareBody(),
    });
    expect(res.status).toBe(201);
    const [key] = [...h.store.agentKeys.values()];
    expect(key?.tenant).toBe(`${context.principalId}|${context.projectId}`);
    expect(String(signingRequestOf(res)['summary'])).toContain(agent.publicKey);
    expect(h.store.requests.get(String(signingRequestOf(res)['id']))?.value.agentKeyId).toBe(
      key?.value.id,
    );
    // A second prepare names the same key rather than making another.
    await h.call('POST', '/v1/mandates/prepare', {
      member,
      project: context.projectId,
      body: prepareBody(),
    });
    expect(h.store.agentKeys.size).toBe(1);
  });

  it('says so when the project has no agent key yet', async () => {
    const h = mandateHarness();
    const { context, member } = await h.tenant({ withKey: false });
    const res = await h.call('POST', '/v1/mandates/prepare', {
      member,
      project: context.projectId,
      body: prepareBody(),
    });
    expect(res.status).toBe(409);
    expect(codeOf(res)).toBe('AGENT_KEY_MISSING');
  });

  it('needs a session in the project, from the app origin, with a role that manages money', async () => {
    const h = mandateHarness();
    const { context, member } = await h.tenant();
    const body = prepareBody();
    const project = context.projectId;
    const noCookie = await h.call('POST', '/v1/mandates/prepare', { project, body });
    expect([noCookie.status, codeOf(noCookie)]).toEqual([401, 'SESSION_INVALID']);
    const crossSite = await h.call('POST', '/v1/mandates/prepare', {
      member,
      project,
      body,
      origin: 'https://evil.example',
    });
    expect([crossSite.status, codeOf(crossSite)]).toEqual([403, 'ORIGIN_NOT_ALLOWED']);
    const noProject = await h.call('POST', '/v1/mandates/prepare', { member, body });
    expect(noProject.status).toBe(400);
    expect(noProject.json).toMatchObject({
      error: { details: [{ path: 'header.ujira-project', issue: 'required' }] },
    });
    const elsewhere = await h.call('POST', '/v1/mandates/prepare', {
      member,
      project: crypto.randomUUID(),
      body,
    });
    expect([elsewhere.status, codeOf(elsewhere)]).toEqual([404, 'NOT_FOUND']);
    const viewer = await h.join(context, approver.publicKey, 'viewer');
    const looking = await h.call('POST', '/v1/mandates/prepare', { member: viewer, project, body });
    expect([looking.status, codeOf(looking)]).toEqual([403, 'FORBIDDEN']);
    expect(h.store.requests.size).toBe(0);
  });
});

describe('POST /v1/signing/submit', () => {
  it('creates the mandate and its row, named in the project, once Stellar has it', async () => {
    const h = mandateHarness();
    const { context, member } = await h.tenant();
    const sent = await createMandate(h, member, context.projectId);
    expect(sent.status, JSON.stringify(sent.json)).toBe(200);
    const mandateId = String(sent.json?.['mandateId']);
    expect(Object.keys(sent.json ?? {}).sort()).toEqual(['mandateId', 'txHash']);
    expect(h.chain.submitted).toHaveLength(1);
    const txHash = Buffer.from(h.chain.submitted[0]?.hash() ?? []).toString('hex');
    expect(sent.json?.['txHash']).toBe(txHash);
    const row = h.store.mandateRows.get(mandateId)?.value;
    expect(row).toMatchObject({
      name: 'Weekly payouts',
      contractAddress: MANDATE,
      network: 'stellar:testnet',
      asset: 'USDC',
      scale: 7,
      agentAddress: agent.publicKey,
      principalWallet: principal.publicKey,
      createdTxHash: txHash,
    });
    const [request] = [...h.store.requests.values()];
    expect(request?.value.submittedTxHash).toBe(txHash);

    const detail = await h.call('GET', `/v1/mandates/${mandateId}`, {
      member,
      project: context.projectId,
    });
    expect(detail.status).toBe(200);
    expect(detail.json?.['mandate']).toMatchObject({
      id: mandateId,
      name: 'Weekly payouts',
      contractId: MANDATE,
      depositAddress: MANDATE,
      status: 'active',
      config: {
        principal: principal.publicKey,
        agents: [agent.publicKey],
        executors: [executor.publicKey],
        recipientMode: 'allowlist',
        limits: {
          totalBudget: { amount: (500n * UNIT).toString(), asset: 'USDC', scale: 7 },
          expiresAt: '2030-03-17T17:46:40.000Z',
        },
      },
      state: {
        balance: { amount: (500n * UNIT).toString(), network: 'stellar:testnet' },
        committed: { amount: '0' },
        free: { amount: (500n * UNIT).toString() },
        paused: false,
      },
      recipients: [],
    });
    const list = await h.call('GET', '/v1/mandates', { member, project: context.projectId });
    expect(list.json).toMatchObject({ items: [{ id: mandateId }], nextCursor: null });
  });

  it('names an unnamed mandate by the end of its address', async () => {
    const h = mandateHarness();
    const { context, member } = await h.tenant();
    const unnamed: Record<string, unknown> = prepareBody();
    delete unnamed['name'];
    const prepared = await h.call('POST', '/v1/mandates/prepare', {
      member,
      project: context.projectId,
      body: unnamed,
    });
    const req = signingRequestOf(prepared);
    const sent = await submit(h, member, context.projectId, {
      signingRequestId: req['id'],
      xdr: signEnvelope(String(req['xdr'])),
    });
    const row = h.store.mandateRows.get(String(sent.json?.['mandateId']))?.value;
    expect(row?.name).toBe(`Mandate ${MANDATE.slice(-4)}`);
  });

  it('refuses an envelope that differs from the prepared one with SIGNING_REQUEST_MISMATCH', async () => {
    const h = mandateHarness();
    const { context, member } = await h.tenant();
    const project = context.projectId;
    const created = await createMandate(h, member, project);
    const id = String(created.json?.['mandateId']);
    const action = (kind: string) =>
      h.call('POST', `/v1/mandates/${id}/actions`, { member, project, body: { kind } });
    const pause = signingRequestOf(await action('pause'));
    const resume = signingRequestOf(await action('resume'));
    const before = h.chain.submitted.length;
    const swapped = await submit(h, member, project, {
      signingRequestId: pause['id'],
      xdr: signEnvelope(String(resume['xdr'])),
    });
    expect([swapped.status, codeOf(swapped)]).toEqual([422, 'SIGNING_REQUEST_MISMATCH']);
    const garbage = await submit(h, member, project, {
      signingRequestId: pause['id'],
      xdr: 'bm90IHhkcg==',
    });
    expect(codeOf(garbage)).toBe('SIGNING_REQUEST_MISMATCH');
    const unsigned = await submit(h, member, project, {
      signingRequestId: pause['id'],
      xdr: String(pause['xdr']),
    });
    expect([unsigned.status, codeOf(unsigned)]).toEqual([422, 'SIGNATURE_INVALID']);
    const wrongKey = await submit(h, member, project, {
      signingRequestId: pause['id'],
      xdr: signEnvelope(String(pause['xdr']), stranger),
    });
    expect(codeOf(wrongKey)).toBe('SIGNATURE_INVALID');
    expect(h.chain.submitted).toHaveLength(before);
    // Refusals before the chain leave the request usable.
    const right = await submit(h, member, project, {
      signingRequestId: pause['id'],
      xdr: signEnvelope(String(pause['xdr'])),
    });
    expect(right.status).toBe(200);
    expect(right.json).toMatchObject({ mandateId: id });
  });

  it('relays a request once: a retry replays, a second submit is refused', async () => {
    const h = mandateHarness();
    const { context, member } = await h.tenant();
    const project = context.projectId;
    const prepared = signingRequestOf(
      await h.call('POST', '/v1/mandates/prepare', { member, project, body: prepareBody() }),
    );
    const body = { signingRequestId: prepared['id'], xdr: signEnvelope(String(prepared['xdr'])) };
    const first = await submit(h, member, project, body, 'same-key');
    const replay = await submit(h, member, project, body, 'same-key');
    expect(replay.status).toBe(200);
    expect(replay.headers.get('idempotent-replayed')).toBe('true');
    expect(replay.json).toEqual(first.json);
    const again = await submit(h, member, project, body, 'other-key');
    expect([again.status, codeOf(again)]).toEqual([409, 'SIGNING_REQUEST_USED']);
    expect(h.chain.submitted).toHaveLength(1);
    expect(h.store.mandateRows.size).toBe(1);
    const noKey = await h.call('POST', '/v1/signing/submit', { member, project, body });
    expect(codeOf(noKey)).toBe('IDEMPOTENCY_KEY_REQUIRED');
  });

  it('refuses a request that ran out of time', async () => {
    const h = mandateHarness();
    const { context, member } = await h.tenant();
    const project = context.projectId;
    const prepared = signingRequestOf(
      await h.call('POST', '/v1/mandates/prepare', { member, project, body: prepareBody() }),
    );
    h.clock.now += 301_000;
    const late = await submit(h, member, project, {
      signingRequestId: prepared['id'],
      xdr: signEnvelope(String(prepared['xdr'])),
    });
    expect([late.status, codeOf(late)]).toEqual([410, 'SIGNING_REQUEST_EXPIRED']);
    expect(h.chain.submitted).toHaveLength(0);
  });

  it('names the contract refusal and uses up the request, since the chain took it', async () => {
    const h = mandateHarness();
    const { context, member } = await h.tenant();
    const project = context.projectId;
    const id = String((await createMandate(h, member, project)).json?.['mandateId']);
    const pause = signingRequestOf(
      await h.call('POST', `/v1/mandates/${id}/actions`, {
        member,
        project,
        body: { kind: 'pause' },
      }),
    );
    h.chain.answers.push({ status: 'FAILED', reason: 'already_paused' });
    const body = { signingRequestId: pause['id'], xdr: signEnvelope(String(pause['xdr'])) };
    const refused = await submit(h, member, project, body);
    expect(refused.status).toBe(422);
    expect(refused.json).toMatchObject({
      error: { code: 'CONTRACT_REFUSED', details: [{ path: 'chain', issue: 'ALREADY_PAUSED' }] },
    });
    expect(codeOf(await submit(h, member, project, body))).toBe('SIGNING_REQUEST_USED');
  });

  it('answers 503 with Retry-After when the chain is down, and the request stays usable', async () => {
    const h = mandateHarness();
    const { context, member } = await h.tenant();
    const project = context.projectId;
    const prepared = signingRequestOf(
      await h.call('POST', '/v1/mandates/prepare', { member, project, body: prepareBody() }),
    );
    const body = { signingRequestId: prepared['id'], xdr: signEnvelope(String(prepared['xdr'])) };
    h.chain.failWith = new ChainError('UNAVAILABLE', 'rpc said something private');
    const down = await submit(h, member, project, body);
    expect([down.status, codeOf(down)]).toEqual([503, 'CHAIN_UNAVAILABLE']);
    expect(down.headers.get('retry-after')).toBe('5');
    expect(JSON.stringify(down.json)).not.toContain('private');
    h.chain.failWith = undefined;
    expect((await submit(h, member, project, body)).status).toBe(200);
  });

  it('sends through the relay it was given, which names the caller for the fee sponsor', async () => {
    const seen: string[] = [];
    const h: MandateHarness = mandateHarness({
      relay: (signed, expected, caller, o) => {
        seen.push(`${caller.principalId}:${expected.action}`);
        return h.adapter.submitSigned(signed, expected, o);
      },
    });
    const { context, member } = await h.tenant();
    expect((await createMandate(h, member, context.projectId)).status).toBe(200);
    expect(seen).toEqual([`${context.principalId}:create`]);
  });

  it('fee bumps the signed envelope, charged to the principal, and stops at the daily cap', async () => {
    const charged: string[] = [];
    let refuse = false;
    const ledger: FeeLedger = {
      reserve: (tenant, entry): Promise<FeeReservation> => {
        charged.push(`${tenant.principalId}:${entry.innerTxHash}`);
        return Promise.resolve(
          refuse ? { kind: 'capped', used: entry.dailyCap } : { kind: 'reserved', used: 1n },
        );
      },
      settle: () => Promise.resolve(true),
      release: () => Promise.resolve(true),
    };
    const h = mandateHarness({ sponsor: { ledger, dailyCap: 50_000_000n } });
    const { context, member } = await h.tenant();
    const sent = await createMandate(h, member, context.projectId);
    expect(sent.status, JSON.stringify(sent.json)).toBe(200);
    const bump = h.chain.submitted[0];
    if (!(bump instanceof FeeBumpTransaction)) throw new Error('expected a fee bump');
    expect(bump.feeSource).toBe(feeSponsor.publicKey);
    expect(sent.json?.['txHash']).toBe(Buffer.from(bump.hash()).toString('hex'));
    const inner = Buffer.from(bump.innerTransaction.hash()).toString('hex');
    expect(charged).toEqual([`${context.principalId}:${inner}`]);
    expect(h.store.mandateRows.size).toBe(1);

    refuse = true;
    const id = String(sent.json?.['mandateId']);
    const pause = signingRequestOf(
      await h.call('POST', `/v1/mandates/${id}/actions`, {
        member,
        project: context.projectId,
        body: { kind: 'pause' },
      }),
    );
    const capped = await submit(h, member, context.projectId, {
      signingRequestId: pause['id'],
      xdr: signEnvelope(String(pause['xdr'])),
    });
    expect([capped.status, codeOf(capped)]).toEqual([429, 'RATE_LIMITED']);
    expect(Number.parseInt(capped.headers.get('retry-after') ?? '0', 10)).toBeGreaterThan(0);
    expect(h.chain.submitted).toHaveLength(1);
    // Nothing went out, so the request can be sent again once the day turns.
    expect(h.store.requests.get(String(pause['id']))?.value.submittedTxHash).toBeNull();
  });

  it('says where a created mandate is when it cannot be read back', async () => {
    const h = mandateHarness();
    const { context, member } = await h.tenant();
    const prepared = signingRequestOf(
      await h.call('POST', '/v1/mandates/prepare', {
        member,
        project: context.projectId,
        body: prepareBody(),
      }),
    );
    // The create lands but its answer carries no address.
    h.chain.created = undefined;
    const sent = await submit(h, member, context.projectId, {
      signingRequestId: prepared['id'],
      xdr: signEnvelope(String(prepared['xdr'])),
    });
    expect([sent.status, codeOf(sent)]).toEqual([503, 'CHAIN_UNAVAILABLE']);
    expect(h.store.mandateRows.size).toBe(0);
    expect([...h.store.requests.values()][0]?.value.submittedTxHash).not.toBeNull();
  });
});

describe('POST /v1/mandates/import', () => {
  it('attaches a mandate the chain says the wallet owns and the project key drives', async () => {
    const h = mandateHarness();
    const { context, member } = await h.tenant();
    const project = context.projectId;
    const res = await h.call('POST', '/v1/mandates/import', {
      member,
      project,
      body: { contractId: ` ${MANDATE} ` },
    });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(res.json?.['mandate']).toMatchObject({
      contractId: MANDATE,
      name: `Mandate ${MANDATE.slice(-4)}`,
      config: { principal: principal.publicKey },
    });
    const again = await h.call('POST', '/v1/mandates/import', {
      member,
      project,
      body: { contractId: MANDATE },
    });
    expect((again.json?.['mandate'] as { id: string }).id).toBe(
      (res.json?.['mandate'] as { id: string }).id,
    );
    expect(h.store.mandateRows.size).toBe(1);
    // Another principal owning the same wallet cannot take it.
    const other = await h.tenant();
    const taken = await h.call('POST', '/v1/mandates/import', {
      member: other.member,
      project: other.context.projectId,
      body: { contractId: MANDATE },
    });
    expect([taken.status, codeOf(taken)]).toEqual([409, 'MANDATE_TAKEN']);
  });

  it('refuses a contract whose principal or agent do not match, or that trusts attestations alone', async () => {
    const h = mandateHarness();
    const owner = await h.tenant();
    const notOwner = await h.join(owner.context, stranger.publicKey, 'admin');
    const project = owner.context.projectId;
    const body = { contractId: MANDATE };
    const wrongWallet = await h.call('POST', '/v1/mandates/import', {
      member: notOwner,
      project,
      body,
    });
    expect([wrongWallet.status, codeOf(wrongWallet)]).toEqual([403, 'MANDATE_PRINCIPAL_MISMATCH']);
    h.rpc.agents = [stranger.publicKey];
    const wrongAgent = await h.call('POST', '/v1/mandates/import', {
      member: owner.member,
      project,
      body,
    });
    expect([wrongAgent.status, codeOf(wrongAgent)]).toEqual([422, 'MANDATE_AGENT_MISMATCH']);
    h.rpc.agents = [agent.publicKey];
    h.rpc.executors = [stranger.publicKey];
    const wrongExecutor = await h.call('POST', '/v1/mandates/import', {
      member: owner.member,
      project,
      body,
    });
    expect(codeOf(wrongExecutor)).toBe('MANDATE_AGENT_MISMATCH');
    h.rpc.executors = [executor.publicKey];
    h.rpc.recipientMode = 2;
    const attested = await h.call('POST', '/v1/mandates/import', {
      member: owner.member,
      project,
      body,
    });
    expect([attested.status, codeOf(attested)]).toEqual([422, 'RECIPIENT_MODE_UNSUPPORTED']);
    const notAContract = await h.call('POST', '/v1/mandates/import', {
      member: owner.member,
      project,
      body: { contractId: principal.publicKey },
    });
    expect(notAContract.json).toMatchObject({
      error: {
        code: 'INVALID_REQUEST',
        details: [{ path: 'body.contractId', issue: 'invalid_address' }],
      },
    });
    expect(h.store.mandateRows.size).toBe(0);
  });
});

describe('reading mandates', () => {
  it('reads detail through the adapter and answers 503 when the chain is down', async () => {
    const h = mandateHarness();
    const { context, member } = await h.tenant();
    const project = context.projectId;
    const id = String((await createMandate(h, member, project)).json?.['mandateId']);
    h.rpc.read = () => Promise.reject(new ChainError('UNAVAILABLE', 'down'));
    const down = await h.call('GET', `/v1/mandates/${id}`, { member, project });
    expect([down.status, codeOf(down)]).toEqual([503, 'CHAIN_UNAVAILABLE']);
    const list = await h.call('GET', '/v1/mandates', { member, project });
    expect(codeOf(list)).toBe('CHAIN_UNAVAILABLE');
  });

  it('lists the allowed recipients with their wallets masked', async () => {
    const h = mandateHarness();
    const { context, member } = await h.tenant();
    const project = context.projectId;
    const id = String((await createMandate(h, member, project)).json?.['mandateId']);
    h.store.addRecipient(context, {
      mandateId: id,
      label: 'Ada',
      recipientRef: defaultRecipientRef(alice),
      destination: alice,
    });
    h.store.addRecipient(context, {
      mandateId: id,
      label: 'Kofi',
      recipientRef: 'ab'.repeat(32),
      destination: null,
    });
    const detail = await h.call('GET', `/v1/mandates/${id}`, { member, project });
    const people = (detail.json?.['mandate'] as { recipients: unknown[] }).recipients;
    expect(people).toEqual([
      expect.objectContaining({
        label: 'Ada',
        address: `${alice.slice(0, 4)}...${alice.slice(-4)}`,
      }),
      expect.objectContaining({ label: 'Kofi', address: null }),
    ]);
    expect(JSON.stringify(detail.json)).not.toContain(alice);
  });

  it('pages with an opaque cursor', async () => {
    const h = mandateHarness();
    const { context, member } = await h.tenant();
    const project = context.projectId;
    await h.call('POST', '/v1/mandates/import', { member, project, body: { contractId: MANDATE } });
    const first = await h.call('GET', '/v1/mandates?limit=1', { member, project });
    expect(first.json).toMatchObject({ nextCursor: null });
    const bad = await h.call('GET', '/v1/mandates?cursor=nope!', { member, project });
    expect(codeOf(bad)).toBe('INVALID_REQUEST');
    const tooMany = await h.call('GET', '/v1/mandates?limit=500', { member, project });
    expect(codeOf(tooMany)).toBe('INVALID_REQUEST');
  });
});

describe('with an API key', () => {
  it('reads mandates with mandates:read, and never prepares or submits anything', async () => {
    const h = mandateHarness();
    const { context, member } = await h.tenant();
    const project = context.projectId;
    const id = String((await createMandate(h, member, project)).json?.['mandateId']);
    const reader = h.apiKey(context, ['mandates:read']);
    const detail = await h.call('GET', `/v1/mandates/${id}`, { bearer: reader, origin: null });
    expect(detail.status, JSON.stringify(detail.json)).toBe(200);
    const list = await h.call('GET', '/v1/mandates', { bearer: reader, origin: null });
    expect(list.json).toMatchObject({ items: [{ id }] });
    const writer = h.apiKey(context, ['mandates:read', 'mandates:write']);
    const prepare = await h.call('POST', '/v1/mandates/prepare', {
      bearer: writer,
      origin: null,
      body: prepareBody(),
    });
    expect([prepare.status, codeOf(prepare)]).toEqual([403, 'FORBIDDEN']);
    const noScope = await h.call('GET', '/v1/mandates', {
      bearer: h.apiKey(context, ['payouts:read']),
      origin: null,
    });
    expect([noScope.status, codeOf(noScope)]).toEqual([403, 'FORBIDDEN']);
    // Another tenant's key finds nothing of this one.
    const other = await h.tenant({ wallet: stranger.publicKey });
    const theirs = h.apiKey(other.context, ['mandates:read']);
    expect(
      (await h.call('GET', `/v1/mandates/${id}`, { bearer: theirs, origin: null })).status,
    ).toBe(404);
    const bad = await h.call('GET', '/v1/mandates', { bearer: 'ujk_test_nope', origin: null });
    expect(codeOf(bad)).toBe('TOKEN_INVALID');
  });
});

describe('POST /v1/mandates/{id}/actions', () => {
  async function live(h: MandateHarness) {
    const t = await h.tenant();
    const project = t.context.projectId;
    const id = String((await createMandate(h, t.member, project)).json?.['mandateId']);
    const act = (body: unknown, member = t.member) =>
      h.call('POST', `/v1/mandates/${id}/actions`, { member, project, body });
    return { ...t, project, id, act };
  }

  it('returns a signing request for each action, for the right wallet', async () => {
    const h = mandateHarness();
    const { act, context, id } = await live(h);
    const join = (c: typeof context, wallet: string, role: string) => h.join(c, wallet, role);
    for (const body of [
      { kind: 'pause' },
      { kind: 'resume' },
      { kind: 'revoke' },
      { kind: 'fund', amount: '25000000' },
      { kind: 'withdraw', amount: '1' },
    ]) {
      const res = await act(body);
      expect(res.status, body.kind).toBe(201);
      expect(signingRequestOf(res)).toMatchObject({
        action: body.kind,
        signer: principal.publicKey,
      });
    }
    const approverSession = await join(context, approver.publicKey, 'admin');
    const onchainPayoutId = 'cd'.repeat(32);
    const payoutId = h.store.addPayout(context, { mandateId: id, onchainPayoutId });
    const approve = await act({ kind: 'approve', payoutId }, approverSession);
    expect(signingRequestOf(approve)).toMatchObject({
      action: 'approve',
      signer: approver.publicKey,
    });
    // The /v1 payout id goes in; the chain's id is what gets signed.
    expect(String(signingRequestOf(approve)['summary'])).toContain(onchainPayoutId);
    // The owner is not an approver on this mandate, so nothing is prepared.
    const before = h.store.requests.size;
    const notApprover = await act({ kind: 'reject', payoutId });
    expect([notApprover.status, codeOf(notApprover)]).toEqual([403, 'FORBIDDEN']);
    expect(h.store.requests.size).toBe(before);
    const unknown = await act({ kind: 'approve', payoutId: crypto.randomUUID() }, approverSession);
    expect([unknown.status, codeOf(unknown)]).toEqual([404, 'NOT_FOUND']);
    const onChainId = await act({ kind: 'approve', payoutId: onchainPayoutId }, approverSession);
    expect(codeOf(onChainId)).toBe('INVALID_REQUEST');
    const notOwner = await act({ kind: 'pause' }, approverSession);
    expect([notOwner.status, codeOf(notOwner)]).toEqual([403, 'FORBIDDEN']);
    const zero = await act({ kind: 'fund', amount: '0' });
    expect(codeOf(zero)).toBe('INVALID_REQUEST');
    const unknownKind = await act({ kind: 'sweep' });
    expect(codeOf(unknownKind)).toBe('INVALID_REQUEST');
  });

  it("allows the mandate's own recipients, with their wallets, and no one else's", async () => {
    const h = mandateHarness();
    const { act, context, id } = await live(h);
    const ada = h.store.addRecipient(context, {
      mandateId: id,
      label: 'Ada',
      recipientRef: defaultRecipientRef(alice),
      destination: alice,
    });
    const res = await act({ kind: 'allow_recipients', recipientIds: [ada.id, ada.id] });
    expect(res.status).toBe(201);
    expect(String(signingRequestOf(res)['summary'])).toContain(alice);
    const kofi = h.store.addRecipient(context, {
      mandateId: id,
      label: 'Kofi',
      recipientRef: 'ab'.repeat(32),
      destination: null,
    });
    const noWallet = await act({ kind: 'allow_recipients', recipientIds: [ada.id, kofi.id] });
    expect(noWallet.json).toMatchObject({
      error: { details: [{ path: 'body.recipientIds.1', issue: 'no_wallet' }] },
    });
    // A recipient of another mandate, even in this project, is not this one's.
    const elsewhere = h.store.addRecipient(context, {
      mandateId: crypto.randomUUID(),
      label: 'Ama',
      recipientRef: defaultRecipientRef(alice),
      destination: alice,
    });
    const other = await act({ kind: 'allow_recipients', recipientIds: [elsewhere.id] });
    expect(other.json).toMatchObject({
      error: { details: [{ path: 'body.recipientIds.0', issue: 'not_found' }] },
    });
  });
});

describe('across tenants', () => {
  it('finds nothing of another tenant, whatever id is named', async () => {
    const h = mandateHarness();
    const a = await h.tenant();
    const b = await h.tenant({ wallet: stranger.publicKey });
    const aProject = a.context.projectId;
    const bProject = b.context.projectId;
    const id = String((await createMandate(h, a.member, aProject)).json?.['mandateId']);
    const pause = signingRequestOf(
      await h.call('POST', `/v1/mandates/${id}/actions`, {
        member: a.member,
        project: aProject,
        body: { kind: 'pause' },
      }),
    );
    // B in its own project, naming A's rows.
    const asB = { member: b.member, project: bProject };
    expect((await h.call('GET', `/v1/mandates/${id}`, asB)).status).toBe(404);
    expect((await h.call('GET', '/v1/mandates', asB)).json).toMatchObject({ items: [] });
    const act = await h.call('POST', `/v1/mandates/${id}/actions`, {
      ...asB,
      body: { kind: 'pause' },
    });
    expect(act.status).toBe(404);
    const stolen = await submit(h, b.member, bProject, {
      signingRequestId: pause['id'],
      xdr: signEnvelope(String(pause['xdr'])),
    });
    expect(stolen.status).toBe(404);
    // B naming A's project is refused before any row is read, as if it did not exist.
    for (const path of [`/v1/mandates/${id}`, '/v1/mandates']) {
      const res = await h.call('GET', path, { member: b.member, project: aProject });
      expect([res.status, codeOf(res)]).toEqual([404, 'NOT_FOUND']);
    }
    expect(h.chain.submitted).toHaveLength(1);
  });
});
