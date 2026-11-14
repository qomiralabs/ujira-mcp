// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// An in-memory stand in for the console API, opened with ?mock=1. It follows
// the same contract and the same rules as the real server closely enough to
// walk every screen without a network, a wallet or test money. Nothing here
// touches a chain; "transactions" are JSON the mock signs by echoing back.

import { ApiError, type AgentCall, type ConsoleApi, type TxAction } from './api';
import { compareMinor, subMinor, addMinor, wholeUnits } from './money';
import type { Config, Mandate, Payout, Receipt } from './schemas';
import { encodeAddress, isAccountAddress } from './strkey';
import { cooldownText } from './words';

const PASSPHRASE = 'Test SDF Network ; September 2015';

function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (x) => x.toString(16).padStart(2, '0')).join('');
}

const newHash = () => hex(randomBytes(32));
export const newAccount = () => encodeAddress('account', randomBytes(32));
const newContract = () => encodeAddress('contract', randomBytes(32));

interface MockAccount {
  exists: boolean;
  usdc: string | null;
  /** When the faucet last topped it up, in ms; null when never. */
  lastTopUp: number | null;
}

interface MockMandate {
  id: string;
  principal: string;
  createdAt: string;
  createTx: string;
  rules: Mandate['rules'];
  balance: string;
  spent: string;
  paused: boolean;
  revoked: boolean;
  recipients: { label: string; address: string }[];
  payouts: Payout[];
  receipts: Receipt[];
}

interface Envelope {
  readonly action: TxAction | 'trustline';
  readonly source: string;
  readonly params: Record<string, unknown>;
}

function encodeEnvelope(e: Envelope): string {
  return `mock:${btoa(JSON.stringify(e))}`;
}

function decodeEnvelope(xdr: string): Envelope {
  if (!xdr.startsWith('mock:')) throw new ApiError('tx_invalid', 'That is not a transaction.', 400);
  return JSON.parse(atob(xdr.slice(5))) as Envelope;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const DESCRIPTIONS: Record<Envelope['action'], string> = {
  trustline: 'Lets your wallet hold test USDC (a USDC trustline).',
  create_mandate: 'Creates your mandate contract with the rules you chose.',
  allow_recipients: "Adds your recipients to the mandate's allowed list.",
  fund_mandate: 'Moves test USDC from your wallet into the mandate.',
  pause: 'Pauses the mandate so every payout is blocked.',
  resume: 'Resumes the mandate so the agent can pay inside the rules again.',
  revoke: 'Revokes the mandate for good. Nothing can be paid from it again.',
  sweep: 'Moves everything the revoked mandate holds back to your wallet.',
  approve: 'Approves the waiting payout.',
  reject: 'Rejects the waiting payout.',
  withdraw: 'Moves USDC from the mandate back to your wallet.',
};

export function createMockApi(options: { delayMs?: number; now?: () => number } = {}): ConsoleApi {
  const delay = options.delayMs ?? 350;
  const now = options.now ?? (() => Date.now());
  const accounts = new Map<string, MockAccount>();
  const mandates = new Map<string, MockMandate>();
  const config: Config = {
    network: 'testnet',
    networkPassphrase: PASSPHRASE,
    rpcUrl: 'https://soroban-testnet.stellar.org',
    horizonUrl: 'https://horizon-testnet.stellar.org',
    explorerTxBase: 'https://stellar.expert/explorer/testnet/tx/',
    factory: newContract(),
    asset: { code: 'USDC', issuer: newAccount(), contract: newContract(), decimals: 7 },
    agent: newAccount(),
    executor: newAccount(),
    sdpAvailable: false,
    sdpProofUrl: 'https://github.com/qomiralabs/ujira-mcp#sdp-rail',
    faucet: {
      amount: wholeUnits(50),
      target: wholeUnits(50),
      cooldownSeconds: 600,
      enabled: true,
    },
  };

  const acct = (address: string): MockAccount => {
    let a = accounts.get(address);
    if (a === undefined) {
      a = { exists: false, usdc: null, lastTopUp: null };
      accounts.set(address, a);
    }
    return a;
  };

  const mandateOf = (id: string): MockMandate => {
    const m = mandates.get(id);
    if (m === undefined)
      throw new ApiError('mandate_not_found', 'There is no mandate with that ID.', 404);
    return m;
  };

  const expired = (m: MockMandate) => now() / 1000 >= Number(m.rules.expiresAt);

  const view = (m: MockMandate): Mandate => ({
    id: m.id,
    principal: m.principal,
    approver: m.principal,
    agent: config.agent ?? null,
    executor: config.executor ?? null,
    rules: m.rules,
    state: {
      balance: m.balance,
      spent: m.spent,
      remaining: subMinor(m.rules.budget, m.spent),
      paused: m.paused,
      revoked: m.revoked,
      expired: expired(m),
    },
    recipients: m.recipients.map((r) => ({ ...r, recipientRef: hex(randomBytes(32)) })),
    mcpUrl: `${location.origin}/m/${m.id}/mcp`,
    sdpAvailable: config.sdpAvailable,
    explorerContractUrl: `https://stellar.expert/explorer/testnet/contract/${m.id}`,
  });

  const dailyUsed = (m: MockMandate, address: string) =>
    m.payouts
      .filter((p) => p.recipient === address && (p.status === 'paid' || p.status === 'approved'))
      .reduce((sum, p) => addMinor(sum, p.amount), '0');

  const resolveRecipient = (m: MockMandate, recipient: string) =>
    m.recipients.find((r) => r.address === recipient || r.label === recipient);

  function decide(m: MockMandate, call: { recipient: string; amount: string; rail: string }) {
    const r = resolveRecipient(m, call.recipient);
    const remaining = subMinor(m.rules.budget, m.spent);
    const pendingTotal = m.payouts
      .filter((p) => p.status === 'pending_approval' || p.status === 'approved')
      .reduce((s, p) => addMinor(s, p.amount), '0');
    const budgetLeft = subMinor(remaining, pendingTotal);
    const dailyLeft =
      r === undefined ? m.rules.dailyCap : subMinor(m.rules.dailyCap, dailyUsed(m, r.address));
    const headroom = {
      perPaymentCap: m.rules.perPaymentCap,
      approvalThreshold: m.rules.approvalThreshold,
      budgetLeft,
      dailyLeft,
      free: m.balance,
    };
    const blocked = (reason: string) => ({
      decision: 'blocked',
      reason,
      headroom,
      address: r?.address,
    });
    if (call.rail === 'sdp' && !config.sdpAvailable) return blocked('rail_unavailable');
    if (m.revoked) return blocked('mandate_revoked');
    if (expired(m)) return blocked('mandate_expired');
    if (m.paused) return blocked('mandate_paused');
    if (!/^\d+$/.test(call.amount) || call.amount === '0') return blocked('amount_invalid');
    if (r === undefined) return blocked('recipient_not_allowed');
    if (compareMinor(call.amount, m.rules.perPaymentCap) > 0)
      return blocked('payment_cap_exceeded');
    if (compareMinor(call.amount, budgetLeft) > 0) return blocked('budget_exceeded');
    if (compareMinor(call.amount, dailyLeft) > 0) return blocked('daily_cap_exceeded');
    if (compareMinor(call.amount, m.balance) > 0) return blocked('insufficient_funds');
    return {
      decision:
        compareMinor(call.amount, m.rules.approvalThreshold) >= 0 ? 'approval_required' : 'allowed',
      headroom,
      address: r.address,
    };
  }

  function receiptFor(m: MockMandate, call: AgentCall, extra: Partial<Receipt>): Receipt {
    const at = new Date(now()).toISOString();
    const existing = m.receipts.findIndex((x) => x.task_id === call.taskId);
    const receipt: Receipt = {
      task_id: call.taskId,
      recipient: call.recipient,
      destination: extra.destination ?? null,
      amount: call.amount,
      asset: 'USDC',
      rail: call.rail,
      outcome: 'blocked',
      created_at: existing >= 0 ? (m.receipts[existing]?.created_at ?? at) : at,
      updated_at: at,
      ...extra,
    };
    if (existing >= 0) m.receipts.splice(existing, 1);
    m.receipts.unshift(receipt);
    return receipt;
  }

  function pay(m: MockMandate, p: Payout): string {
    const hash = newHash();
    m.balance = subMinor(m.balance, p.amount);
    m.spent = addMinor(m.spent, p.amount);
    const r = accounts.get(p.recipient);
    if (r !== undefined && r.usdc !== null) r.usdc = addMinor(r.usdc, p.amount);
    p.status = 'paid';
    p.paidTx = hash;
    return hash;
  }

  function apply(e: Envelope): { mandate?: string } {
    const params = e.params;
    const mandateId = typeof params['mandate'] === 'string' ? params['mandate'] : '';
    switch (e.action) {
      case 'trustline': {
        acct(e.source).usdc ??= '0';
        return {};
      }
      case 'create_mandate': {
        const id = newContract();
        mandates.set(id, {
          id,
          principal: e.source,
          createdAt: new Date(now()).toISOString(),
          createTx: newHash(),
          rules: {
            budget: String(params['budget']),
            perPaymentCap: String(params['perPaymentCap']),
            dailyCap: String(params['dailyCap']),
            approvalThreshold: String(params['approvalThreshold']),
            expiresAt: Number(params['expiresAt']),
            feeCapBps: 0,
          },
          balance: '0',
          spent: '0',
          paused: false,
          revoked: false,
          recipients: [],
          payouts: [],
          receipts: [],
        });
        return { mandate: id };
      }
      case 'allow_recipients': {
        const m = mandateOf(mandateId);
        const list = params['recipients'] as { label: string; address: string }[];
        for (const r of list) {
          if (!m.recipients.some((x) => x.address === r.address)) m.recipients.push(r);
        }
        return {};
      }
      case 'fund_mandate': {
        const m = mandateOf(mandateId);
        const amount = String(params['amount']);
        const a = acct(e.source);
        if (a.usdc === null || compareMinor(a.usdc, amount) < 0) {
          throw new ApiError(
            'tx_failed',
            'Your wallet does not hold enough test USDC for this.',
            400,
          );
        }
        a.usdc = subMinor(a.usdc, amount);
        m.balance = addMinor(m.balance, amount);
        return {};
      }
      case 'pause':
        mandateOf(mandateId).paused = true;
        return {};
      case 'resume':
        mandateOf(mandateId).paused = false;
        return {};
      case 'revoke': {
        const m = mandateOf(mandateId);
        m.revoked = true;
        for (const p of m.payouts) if (p.status === 'pending_approval') p.status = 'cancelled';
        return {};
      }
      case 'sweep': {
        const m = mandateOf(mandateId);
        const a = acct(e.source);
        a.usdc = addMinor(a.usdc ?? '0', m.balance);
        m.balance = '0';
        return {};
      }
      case 'approve':
      case 'reject': {
        const m = mandateOf(mandateId);
        const p = m.payouts.find((x) => x.payoutId === params['payoutId']);
        if (p?.status !== 'pending_approval') {
          throw new ApiError(
            'payout_not_pending',
            'That payout is no longer waiting for approval.',
            400,
          );
        }
        p.status = e.action === 'approve' ? 'approved' : 'rejected';
        if (e.action === 'reject') {
          receiptFor(
            m,
            {
              taskId: p.taskId,
              recipient: p.recipient,
              amount: p.amount,
              rail: p.rail === 'sdp' ? 'sdp' : 'usdc',
            },
            { outcome: 'blocked', reason: 'rejected', payout_id: p.payoutId ?? null },
          );
        }
        return {};
      }
      case 'withdraw': {
        const m = mandateOf(mandateId);
        const amount = String(params['amount']);
        m.balance = subMinor(m.balance, amount);
        const a = acct(e.source);
        a.usdc = addMinor(a.usdc ?? '0', amount);
        return {};
      }
    }
  }

  async function wait<T>(fn: () => T): Promise<T> {
    await sleep(delay);
    return fn();
  }

  return {
    config: () => wait(() => config),
    account: (address) =>
      wait(() => {
        if (!isAccountAddress(address)) {
          throw new ApiError('address_invalid', 'That is not a valid Stellar wallet address.', 400);
        }
        const a = acct(address);
        return { address, exists: a.exists, xlm: a.exists ? '10000.0000000' : null, usdc: a.usdc };
      }),
    onboardXlm: (address) =>
      wait(() => {
        acct(address).exists = true;
      }),
    trustline: (address) =>
      wait(() => {
        if (!acct(address).exists) {
          throw new ApiError(
            'account_missing',
            'Get test XLM first; the account does not exist yet.',
            400,
          );
        }
        return {
          xdr: encodeEnvelope({ action: 'trustline', source: address, params: {} }),
          description: DESCRIPTIONS.trustline,
        };
      }),
    onboardUsdc: (address) =>
      wait(() => {
        const a = acct(address);
        if (a.usdc === null) {
          throw new ApiError(
            'no_trustline',
            'Add the USDC trustline first, then ask for test USDC.',
            400,
          );
        }
        const target = config.faucet?.target ?? '0';
        const cooldownMs = (config.faucet?.cooldownSeconds ?? 0) * 1000;
        if (a.lastTopUp !== null && now() - a.lastTopUp < cooldownMs) {
          const left = Math.ceil((a.lastTopUp + cooldownMs - now()) / 1000);
          throw new ApiError('faucet_cooldown', cooldownText(left), 429, left);
        }
        if (compareMinor(a.usdc, target) >= 0) {
          throw new ApiError(
            'faucet_not_needed',
            'Your wallet already holds the full test amount or more, so there is nothing to top up.',
            409,
          );
        }
        const amount = subMinor(target, a.usdc);
        a.lastTopUp = now();
        a.usdc = target;
        return { hash: newHash(), amount };
      }),
    testRecipient: () =>
      wait(() => {
        const address = newAccount();
        accounts.set(address, { exists: true, usdc: '0', lastTopUp: null });
        return { address, hash: newHash() };
      }),
    buildTx: (action, source, params) =>
      wait(() => {
        if (!(action in DESCRIPTIONS)) throw new ApiError('unknown_action', 'Unknown action.', 400);
        return {
          xdr: encodeEnvelope({ action, source, params }),
          description: DESCRIPTIONS[action],
        };
      }),
    submitTx: (xdr) =>
      wait(() => {
        const result = apply(decodeEnvelope(xdr));
        return {
          hash: newHash(),
          status: 'SUCCESS',
          returnValue: null,
          mandate: result.mandate ?? null,
        };
      }),
    mandates: (principal) =>
      wait(() =>
        [...mandates.values()]
          .filter((m) => m.principal === principal)
          .reverse()
          .map((m) => ({ id: m.id, createdAt: m.createdAt, createTx: m.createTx })),
      ),
    mandate: (id) => wait(() => view(mandateOf(id))),
    payouts: (id) => wait(() => [...mandateOf(id).payouts].reverse()),
    quote: (id, call) =>
      wait(() => {
        const m = mandateOf(id);
        const d = decide(m, call);
        return {
          decision: d.decision,
          ...('reason' in d ? { reason: d.reason } : {}),
          amount: call.amount,
          asset: 'USDC',
          rail: call.rail,
          destination: d.address ?? null,
          headroom: d.headroom,
        };
      }),
    request: (id, call) =>
      wait(() => {
        const m = mandateOf(id);
        const existing = m.payouts.find((p) => p.taskId === call.taskId);
        if (existing !== undefined) {
          if (existing.status === 'approved') {
            const hash = pay(m, existing);
            return receiptFor(m, call, {
              outcome: 'approved_then_paid',
              tx_hash: hash,
              payout_id: existing.payoutId ?? null,
              destination: existing.recipient,
              recipient: existing.recipientLabel ?? existing.recipient,
            });
          }
          const prior = m.receipts.find((r) => r.task_id === call.taskId);
          if (prior !== undefined) return prior;
        }
        const d = decide(m, call);
        const payoutId = hex(randomBytes(32));
        const label = resolveRecipient(m, call.recipient)?.label ?? null;
        const payout: Payout = {
          taskId: call.taskId,
          payoutId,
          recipient: d.address ?? call.recipient,
          recipientLabel: label,
          amount: call.amount,
          rail: call.rail,
          status: 'blocked',
          at: new Date(now()).toISOString(),
        };
        m.payouts.push(payout);
        if (d.decision === 'blocked') {
          payout.reason = 'reason' in d ? d.reason : null;
          return receiptFor(m, call, { outcome: 'blocked', reason: payout.reason });
        }
        payout.requestTx = newHash();
        if (d.decision === 'approval_required') {
          payout.status = 'pending_approval';
          return receiptFor(m, call, {
            outcome: 'approval_required',
            payout_id: payoutId,
            request_tx_hash: payout.requestTx,
            destination: payout.recipient,
          });
        }
        const hash = pay(m, payout);
        return receiptFor(m, call, {
          outcome: 'paid',
          payout_id: payoutId,
          tx_hash: hash,
          request_tx_hash: payout.requestTx,
          destination: payout.recipient,
        });
      }),
    receipts: (id) => wait(() => mandateOf(id).receipts),
  };
}
