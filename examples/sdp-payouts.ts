// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// Real payouts through the SDP rail on testnet: each one is requested on the
// mandate, paid by the mandate to the SDP distribution account, then paid by
// SDP to the person. The results are added to the evidence file next to the
// other rails' entries.
//
// Settings come from the environment, as for the MCP server (see
// docs/sdp-testnet.md): UJIRA_MANDATE_FILE, UJIRA_AGENT_KEY_FILE,
// UJIRA_EXECUTOR_KEY_FILE, UJIRA_SDP_URL, UJIRA_SDP_API_KEY and
// UJIRA_SDP_DISTRIBUTION. UJIRA_EVIDENCE_FILE names the evidence file.
//
// Task IDs are fixed, so running it again reports the same payouts instead of
// paying them twice.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { z } from 'zod';

import { createEngine, loadSettings } from '../src/config.js';
import { formatUnits, units } from '../src/money.js';

const TASKS = [
  { task_id: 'sdp-demo-2026-11-13-1', recipient: 'recipient-1', amount: units(2) },
  { task_id: 'sdp-demo-2026-11-13-2', recipient: 'recipient-2', amount: units(3) },
] as const;

const mandateFacts = z.object({
  mandate: z.string(),
  factory: z.string().optional(),
  asset: z.object({ code: z.string(), contract: z.string().optional() }).optional(),
  principal: z.string().optional(),
  agent: z.string().optional(),
  recipients: z.array(z.object({ name: z.string().optional(), destination: z.string() })),
});

const evidenceFile = z
  .object({ payouts: z.array(z.record(z.string(), z.unknown())).default([]) })
  .loose();

async function readEvidence(path: string): Promise<z.output<typeof evidenceFile> | undefined> {
  try {
    return evidenceFile.parse(JSON.parse(await readFile(path, 'utf8')));
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  }
}

async function main(): Promise<void> {
  const settings = loadSettings();
  if (settings.sdp === undefined) throw new Error('set UJIRA_SDP_URL and the other SDP settings');
  const mandateFile = process.env['UJIRA_MANDATE_FILE'];
  if (mandateFile === undefined) throw new Error('set UJIRA_MANDATE_FILE');
  const facts = mandateFacts.parse(JSON.parse(await readFile(mandateFile, 'utf8')));
  const wallets = new Map(facts.recipients.map((r) => [r.name ?? r.destination, r.destination]));
  const { engine } = createEngine(settings);

  const entries: Record<string, unknown>[] = [];
  for (const task of TASKS) {
    console.log(`${task.task_id}: ${formatUnits(task.amount)} USDC to ${task.recipient} via SDP`);
    const r = await engine.requestPayout({
      task_id: task.task_id,
      recipient: task.recipient,
      amount: task.amount.toString(),
      rail: 'sdp',
    });
    console.log(
      `  ${r.outcome} mandate tx ${r.tx_hash ?? '-'} sdp tx ${r.sdp_tx_hash ?? '-'} disbursement ${r.sdp_disbursement_id ?? '-'}`,
    );
    entries.push({
      task_id: r.task_id,
      recipient: wallets.get(task.recipient) ?? task.recipient,
      recipient_name: task.recipient,
      amount: r.amount.toString(),
      asset: r.asset,
      rail: 'sdp',
      outcome: r.outcome,
      ...(r.reason === undefined ? {} : { reason: r.reason }),
      payout_id: r.payout_id,
      tx_hash: r.tx_hash,
      request_tx_hash: r.request_tx_hash,
      sdp_distribution: r.destination,
      sdp_disbursement_id: r.sdp_disbursement_id,
      sdp_payment_id: r.sdp_payment_id,
      sdp_tx_hash: r.sdp_tx_hash,
      at: r.updated_at,
    });
  }

  const check = await engine.listReceipts({ verify: true });
  for (const v of check.verification ?? []) {
    console.log(`verify ${v.task_id}: ${v.ok ? 'ok' : 'FAILED'} (${v.onchain_status})`);
    const entry = entries.find((e) => e['task_id'] === v.task_id);
    if (entry !== undefined) entry['verified'] = v.ok;
  }

  const path = process.env['UJIRA_EVIDENCE_FILE'] ?? 'evidence/testnet-run.json';
  const existing = await readEvidence(path);
  // Other rails write to the same file; only this run's own tasks are replaced.
  const ours = new Set(entries.map((e) => e['task_id']));
  const kept = (existing?.payouts ?? []).filter((p) => !ours.has(p['task_id']));
  const evidence = {
    network: 'testnet',
    mandate_contract: facts.mandate,
    factory: facts.factory,
    asset: facts.asset?.contract ?? facts.asset?.code,
    principal: facts.principal,
    agent: facts.agent,
    created_at: new Date().toISOString(),
    ...existing,
    payouts: [...kept, ...entries],
  };
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(`wrote ${entries.length.toString()} sdp entries to ${path}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? `${error.name}: ${error.message}` : 'failed');
  process.exitCode = 1;
});
