// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// Runs real payouts on Stellar testnet through a demo mandate and writes the
// evidence: evidence/testnet-run.json, evidence/RUN.md and the receipt log.
//
//   UJIRA_DEMO_DIR=~/.config/ujira-testnet/demo npm run demo
//
// UJIRA_DEMO_DIR holds mandate.json and the stellar CLI identities
// (stellar/identity/{agent,executor,approver}.toml). Each setting can also
// be given on its own: UJIRA_MANDATE_FILE, UJIRA_AGENT_KEY_FILE,
// UJIRA_EXECUTOR_KEY_FILE and UJIRA_APPROVER_KEY_FILE.
//
// The approval step is a person's action. The demo plays that person with
// the approver key; the MCP server has no tool for it.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Keypair } from '@stellar/stellar-sdk';

import {
  EngineError,
  createEngine,
  formatUnits,
  loadSettings,
  payoutIdFor,
  receiptToJson,
  signerFromEnv,
  type Receipt,
} from '../src/index.js';

const UNIT = 10_000_000n;
/** The demo never spends more than this, whatever the mandate allows. */
const MAX_SPEND = 150n * UNIT;
/** "7.5" to minor units, parsed as text so no float ever holds an amount. */
function usdc(amount: string): bigint {
  const [whole = '0', frac = ''] = amount.split('.');
  return BigInt(whole) * UNIT + BigInt(frac.padEnd(7, '0').slice(0, 7));
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const evidenceDir = join(root, 'evidence');

function demoEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  const dir = env['UJIRA_DEMO_DIR'];
  if (dir !== undefined && dir !== '') {
    const id = (name: string) => join(dir, 'stellar', 'identity', `${name}.toml`);
    env['UJIRA_MANDATE_FILE'] ??= join(dir, 'mandate.json');
    env['UJIRA_AGENT_KEY_FILE'] ??= id('agent');
    env['UJIRA_EXECUTOR_KEY_FILE'] ??= id('executor');
    env['UJIRA_APPROVER_KEY_FILE'] ??= id('approver');
  }
  env['UJIRA_RECEIPTS_FILE'] ??= join(evidenceDir, 'receipts.json');
  return env;
}

interface MandateFacts {
  factory?: string;
  principal?: string;
  asset?: { code: string; issuer?: string; contract?: string };
  recipients?: { name?: string; destination: string }[];
}

interface Step {
  readonly label: string;
  readonly recipient: string;
  readonly amount: bigint;
  /** What the run expects, so a surprise is visible in the log. */
  readonly expect: 'paid' | 'blocked' | 'approval_required';
}

interface EvidencePayout {
  task_id: string;
  recipient: string;
  amount: string;
  asset: string;
  rail: 'usdc' | 'sdp';
  outcome: string;
  reason?: string;
  payout_id?: string;
  tx_hash?: string;
  request_tx_hash?: string;
  approve_tx_hash?: string;
  sdp_disbursement_id?: string;
  blocked_by?: string;
  contract_error?: number;
  verified?: boolean;
  at: string;
}

async function main(): Promise<void> {
  const env = demoEnv();
  const settings = loadSettings(env);
  const approver = signerFromEnv(env, 'UJIRA_APPROVER');
  if (approver === undefined) {
    throw new EngineError('config_invalid', 'set UJIRA_APPROVER_KEY_FILE for the approval step');
  }
  const facts = JSON.parse(readFileSync(env['UJIRA_MANDATE_FILE'] ?? '', 'utf8')) as MandateFacts;
  const recipients = (facts.recipients ?? []).map((r) => r.destination);
  const [r1, r2, r3] = recipients;
  if (r1 === undefined || r2 === undefined || r3 === undefined) {
    throw new EngineError('config_invalid', 'the mandate file must list three recipients');
  }
  const { engine, mandate } = createEngine(settings);
  const config = await mandate.config();
  const state = await mandate.state();
  console.log(`mandate ${settings.mandateId}`);
  console.log(
    `budget left ${formatUnits(config.limits.totalBudget - state.spent - state.pending - state.committed)} USDC, cap ${formatUnits(config.limits.perPaymentCap)}, daily ${formatUnits(config.limits.perRecipientDailyCap)}, approval at ${formatUnits(config.limits.approvalThreshold)}`,
  );

  // A fresh address, never on the allowlist.
  const outsider = Keypair.random().publicKey();
  const run = new Date().toISOString().replace(/[-:]/g, '').slice(0, 13);
  let n = 0;
  const task = () => `demo-${run}-${String(++n).padStart(2, '0')}`;

  const steps: Step[] = [
    { label: 'normal payment', recipient: r1, amount: usdc('5'), expect: 'paid' },
    { label: 'normal payment', recipient: r2, amount: usdc('7.5'), expect: 'paid' },
    { label: 'normal payment', recipient: r3, amount: usdc('3'), expect: 'paid' },
    { label: 'normal payment', recipient: r1, amount: usdc('2.5'), expect: 'paid' },
    { label: 'over the per-payment cap', recipient: r2, amount: usdc('60'), expect: 'blocked' },
    { label: 'recipient not allowed', recipient: outsider, amount: usdc('1'), expect: 'blocked' },
    { label: 'needs approval', recipient: r3, amount: usdc('22'), expect: 'approval_required' },
    { label: 'needs approval', recipient: r2, amount: usdc('21'), expect: 'approval_required' },
  ];

  const planned = steps
    .filter((s) => s.expect !== 'blocked')
    .reduce((sum, s) => sum + s.amount, 0n);
  if (planned > MAX_SPEND) throw new Error('the plan spends more than the demo allows');

  const payouts: EvidencePayout[] = [];
  const approveTx = new Map<string, string>();
  const results: { step: Step; receipt: Receipt }[] = [];

  const runStep = async (step: Step): Promise<Receipt> => {
    const taskId = task();
    const q = await engine.quotePayout({
      recipient: step.recipient,
      amount: step.amount.toString(),
    });
    const receipt = await engine.requestPayout({
      task_id: taskId,
      recipient: step.recipient,
      amount: step.amount.toString(),
    });
    const mark = receipt.outcome === step.expect ? 'ok' : `UNEXPECTED (wanted ${step.expect})`;
    console.log(
      `${taskId} ${step.label}: ${formatUnits(step.amount)} USDC, quote ${q.decision}${q.reason === undefined ? '' : ` (${q.reason})`}, outcome ${receipt.outcome}${receipt.reason === undefined ? '' : ` (${receipt.reason})`} ${mark}`,
    );
    results.push({ step, receipt });
    return receipt;
  };

  for (const step of steps) await runStep(step);

  // Bring one recipient close to the daily limit with small payments, then
  // ask for more than is left today, still under the per-payment cap.
  const ref = engine.recipientRefFor(r1);
  const cap = config.limits.perRecipientDailyCap;
  let left = cap - (await mandate.dailyUsed(ref));
  const target = config.limits.perPaymentCap - UNIT;
  while (left > target) {
    const chunk = left - target > usdc('19') ? usdc('19') : left - target;
    const r = await runStep({
      label: 'payment toward the daily limit',
      recipient: r1,
      amount: chunk,
      expect: 'paid',
    });
    if (r.outcome !== 'paid') break;
    left = cap - (await mandate.dailyUsed(ref));
  }
  await runStep({
    label: 'over the daily limit',
    recipient: r1,
    amount: left + UNIT,
    expect: 'blocked',
  });

  // A person approves the waiting payouts; the agent then asks again and the
  // engine pays each exactly once.
  for (const { receipt } of results.filter((r) => r.receipt.outcome === 'approval_required')) {
    const id = payoutIdFor(settings.mandateId, receipt.task_id);
    const approved = await mandate.approve(approver, id);
    approveTx.set(receipt.task_id, approved.txHash);
    console.log(`${receipt.task_id} approved by the approver key (${approved.txHash})`);
    const paid = await engine.requestPayout({
      task_id: receipt.task_id,
      recipient: receipt.recipient,
      amount: receipt.amount.toString(),
    });
    console.log(`${receipt.task_id} outcome ${paid.outcome} (${paid.tx_hash ?? 'no tx'})`);
    const i = results.findIndex((r) => r.receipt.task_id === receipt.task_id);
    const prior = results[i];
    if (prior !== undefined) results[i] = { step: prior.step, receipt: paid };
  }

  for (const { receipt } of results) {
    const check = await engine.verifyReceipt(receipt);
    if (!check.ok)
      console.log(`${receipt.task_id} cross-check FAILED: ${JSON.stringify(check.checks)}`);
    const j = receiptToJson(receipt);
    const approve = approveTx.get(receipt.task_id);
    payouts.push({
      task_id: receipt.task_id,
      recipient: receipt.recipient,
      amount: String(j['amount']),
      asset: receipt.asset,
      rail: receipt.rail,
      outcome: receipt.outcome,
      ...(receipt.reason === undefined ? {} : { reason: receipt.reason }),
      ...(receipt.payout_id === undefined ? {} : { payout_id: receipt.payout_id }),
      ...(receipt.tx_hash === undefined ? {} : { tx_hash: receipt.tx_hash }),
      ...(receipt.request_tx_hash === undefined
        ? {}
        : { request_tx_hash: receipt.request_tx_hash }),
      ...(approve === undefined ? {} : { approve_tx_hash: approve }),
      ...(receipt.blocked_by === undefined ? {} : { blocked_by: receipt.blocked_by }),
      ...(receipt.contract_error === undefined ? {} : { contract_error: receipt.contract_error }),
      verified: check.ok,
      at: receipt.updated_at,
    });
  }

  writeEvidence(settings.mandateId, config.principal, settings.agent.publicKey, facts, payouts);
  const after = await mandate.state();
  console.log(`spent by the mandate so far: ${formatUnits(after.spent)} USDC`);
}

function writeEvidence(
  mandateId: string,
  principal: string,
  agent: string,
  facts: MandateFacts,
  payouts: EvidencePayout[],
): void {
  mkdirSync(evidenceDir, { recursive: true });
  const path = join(evidenceDir, 'testnet-run.json');
  // Other rails write to the same file; their entries are kept.
  let others: EvidencePayout[] = [];
  try {
    const prior = JSON.parse(readFileSync(path, 'utf8')) as { payouts?: EvidencePayout[] };
    others = (prior.payouts ?? []).filter((p) => p.rail !== 'usdc');
  } catch (error) {
    // Only a missing file means there is nothing to keep; anything else stops
    // the run rather than overwrite another rail's evidence.
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }
  const all = [...payouts, ...others];
  const doc = {
    network: 'testnet',
    mandate_contract: mandateId,
    factory: facts.factory ?? null,
    asset: facts.asset ?? { code: 'USDC' },
    principal,
    agent,
    created_at: new Date().toISOString(),
    payouts: all,
  };
  writeFileSync(path, `${JSON.stringify(doc, null, 2)}\n`);

  const tx = (h?: string) =>
    h === undefined ? '' : `[${h.slice(0, 8)}](https://stellar.expert/explorer/testnet/tx/${h})`;
  const short = (a: string) => (a.length > 12 ? `${a.slice(0, 4)}...${a.slice(-4)}` : a);
  const rows = all.map(
    (p, i) =>
      `| ${String(i + 1)} | ${p.task_id} | ${p.rail} | ${short(p.recipient)} | ${formatUnits(BigInt(p.amount))} ${p.asset} | ${p.outcome} | ${p.reason ?? ''} | ${tx(p.request_tx_hash)} | ${tx(p.approve_tx_hash)} | ${tx(p.tx_hash)} | ${p.verified === true ? 'yes' : p.verified === false ? 'NO' : ''} |`,
  );
  const md = [
    '# Testnet run',
    '',
    `Mandate [${mandateId}](https://stellar.expert/explorer/testnet/contract/${mandateId}) on Stellar testnet, written ${doc.created_at}.`,
    'Amounts are USDC (7 decimals); the raw integer minor units are in testnet-run.json.',
    "Blocked payouts send nothing: the engine asks the mandate by simulation, and the reason is the contract's own error.",
    'Verified means the receipt matches the payout record on the mandate and every listed transaction succeeded on the ledger.',
    '',
    '| # | Task | Rail | Recipient | Amount | Outcome | Reason | Request tx | Approve tx | Payment tx | Verified |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...rows,
    '',
  ].join('\n');
  writeFileSync(join(evidenceDir, 'RUN.md'), md);
  console.log(`wrote ${path} and RUN.md (${String(all.length)} payouts)`);
}

main().catch((error: unknown) => {
  console.error(error instanceof EngineError ? `${error.code}: ${error.message}` : error);
  process.exit(1);
});
