// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// Walks the console story end to end on Stellar testnet, against a running
// server, the way a reviewer's wallet would: every owner transaction is
// built by the server, signed here by a throwaway keypair, and relayed back.
//
//   UJIRA_CONSOLE_URL=http://127.0.0.1:8787 npx tsx examples/console-e2e.ts
//
// It ends by waiting for the server's recycler to send the test recipient's
// USDC back to the faucet, and for the faucet cooldown to pass so it can top
// up again, so a full run takes about as long as the longer of the two
// (UJIRA_RECYCLE_INTERVAL_SECONDS here should match the server's, default 300).
//
// The keypair is generated for this run and never written anywhere. Only
// public facts (addresses, contract IDs, transaction hashes) are printed and
// saved to evidence/console-e2e.json.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { Keypair, TransactionBuilder, type Transaction } from '@stellar/stellar-sdk';

const base = (process.env['UJIRA_CONSOLE_URL'] ?? 'http://127.0.0.1:8787').replace(/\/+$/, '');
const UNIT = 10_000_000n;
const usdc = (n: bigint) => (n * UNIT).toString();
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

type Json = Record<string, unknown>;

class ApiFailure extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
  }
}

async function call(path: string, body?: unknown): Promise<Json> {
  const res = await fetch(`${base}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(180_000),
  });
  const json = (await res.json()) as Json;
  if (!res.ok) {
    const error = json['error'] as
      { code?: string; message?: string; retryAfterSeconds?: number } | undefined;
    throw new ApiFailure(
      res.status,
      error?.code ?? 'unknown',
      error?.message ?? res.statusText,
      error?.retryAfterSeconds,
    );
  }
  return json;
}

/** Public reads from Horizon, for checking where the recycled USDC went. */
async function horizon(url: string): Promise<Json> {
  const res = await fetch(url, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`Horizon answered HTTP ${res.status}`);
  return (await res.json()) as Json;
}

const sleep = (ms: number) =>
  new Promise<void>((r) => {
    setTimeout(r, ms);
  });

/** Retries while the new account has not reached RPC yet. */
async function retrying<T>(work: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await work();
    } catch (error) {
      if (!(error instanceof ApiFailure && error.code === 'account_not_found') || attempt >= 6) {
        throw error;
      }
      await sleep(3_000);
    }
  }
}

const hashes: { step: string; hash: string }[] = [];
const log = (line: string) => {
  process.stdout.write(`${line}\n`);
};

function check(ok: boolean, what: string): void {
  if (!ok) throw new Error(`check failed: ${what}`);
  log(`  ok: ${what}`);
}

async function main(): Promise<void> {
  const config = await call('/api/config');
  const passphrase = String(config['networkPassphrase']);
  const owner = Keypair.random();
  const me = owner.publicKey();
  log(`console ${base}, owner wallet ${me} (throwaway)`);

  async function signAndSubmit(step: string, built: Json): Promise<Json> {
    const tx = TransactionBuilder.fromXdr(String(built['xdr']), passphrase) as Transaction;
    tx.sign(owner);
    const sent = await call('/api/tx/submit', { xdr: tx.toXdr() });
    const hash = String(sent['hash']);
    hashes.push({ step, hash });
    log(`${step}: ${String(sent['status'])} ${hash}`);
    check(sent['status'] === 'SUCCESS', `${step} landed`);
    return sent;
  }

  const build = (action: string, params: Json) =>
    retrying(() => call('/api/tx/build', { action, source: me, params }));

  // 1. Onboard: test XLM, a USDC trustline, a top up to the faucet target.
  const faucetConfig = config['faucet'] as { target?: string; cooldownSeconds?: number };
  const target = BigInt(faucetConfig.target ?? '0');
  check(target > 0n, `the faucet tops up to ${String(faucetConfig.target)} minor units`);
  await call('/api/onboard/xlm', { address: me });
  await signAndSubmit(
    'trustline',
    await retrying(() => call('/api/onboard/trustline', { address: me })),
  );
  const faucet = await call('/api/onboard/usdc', { address: me });
  const faucetAt = Date.now();
  hashes.push({ step: 'faucet_top_up_1', hash: String(faucet['hash']) });
  log(`faucet: ${String(faucet['amount'])} minor units, ${String(faucet['hash'])}`);
  check(faucet['amount'] === target.toString(), 'an empty wallet gets the whole target');
  const account = await call(`/api/accounts/${me}`);
  check(account['usdc'] === target.toString(), 'the wallet holds the faucet target');

  // Asking again at once is refused with the time left, and sends nothing.
  let cooldownSeconds = 0;
  try {
    await call('/api/onboard/usdc', { address: me });
  } catch (error) {
    if (!(error instanceof ApiFailure) || error.code !== 'faucet_cooldown') throw error;
    cooldownSeconds = error.retryAfterSeconds ?? 0;
  }
  check(cooldownSeconds > 0, `a second top up waits out the cooldown (${cooldownSeconds}s left)`);

  // 2. A test recipient made by the server.
  const recipient = await call('/api/recipients/test', {});
  const tester = String(recipient['address']);
  hashes.push({ step: 'test_recipient_trustline', hash: String(recipient['hash']) });
  log(`test recipient ${tester}`);

  // 3. Create, allow, fund.
  const expiresAt = Math.floor(Date.now() / 1000) + 7 * 86_400;
  const created = await signAndSubmit(
    'create_mandate',
    await build('create_mandate', {
      budget: usdc(20n),
      perPaymentCap: usdc(5n),
      dailyCap: usdc(10n),
      approvalThreshold: usdc(2n),
      expiresAt,
    }),
  );
  const mandate = String(created['mandate']);
  check(mandate.startsWith('C'), `mandate ${mandate} created and returned`);
  await signAndSubmit(
    'allow_recipients',
    await build('allow_recipients', {
      mandate,
      recipients: [{ label: 'tester', address: tester }],
    }),
  );
  await signAndSubmit('fund_mandate', await build('fund_mandate', { mandate, amount: usdc(10n) }));
  const view = await call(`/api/mandates/${mandate}`);
  const state = view['state'] as Json;
  check(state['balance'] === usdc(10n), 'the mandate holds 10 USDC');
  check(
    (view['recipients'] as { label: string }[]).some((r) => r.label === 'tester'),
    'the recipient label is stored',
  );
  log(`mcp url ${String(view['mcpUrl'])}`);

  const run = Date.now().toString(36);
  const agent = (taskId: string, amount: bigint, rail = 'usdc') =>
    call(`/api/mandates/${mandate}/agent/request`, {
      recipient: 'tester',
      amount: usdc(amount),
      rail,
      taskId,
    });

  // 4. Pay 1 USDC.
  const quote = await call(`/api/mandates/${mandate}/agent/quote`, {
    recipient: 'tester',
    amount: usdc(1n),
    rail: 'usdc',
  });
  check(quote['decision'] === 'allowed', 'quote for 1 USDC says allowed');
  const paid = await agent(`console-e2e-${run}-1`, 1n);
  check(paid['outcome'] === 'paid', 'the 1 USDC payout is paid');
  hashes.push({ step: 'payout_1_usdc', hash: String(paid['tx_hash']) });

  // 5. Approval required, approved in the wallet, then paid.
  const bigTask = `console-e2e-${run}-2`;
  const waiting = await agent(bigTask, 3n);
  check(waiting['outcome'] === 'approval_required', 'the 3 USDC payout waits for approval');
  hashes.push({ step: 'payout_3_usdc_request', hash: String(waiting['request_tx_hash']) });
  const payouts = (await call(`/api/mandates/${mandate}/payouts`))['payouts'] as Json[];
  const pending = payouts.find((p) => p['taskId'] === bigTask);
  check(pending?.['status'] === 'pending_approval', 'the inbox shows it as pending_approval');
  await signAndSubmit(
    'approve',
    await build('approve', { mandate, payoutId: String(pending?.['payoutId']) }),
  );
  const approved = await agent(bigTask, 3n);
  check(approved['outcome'] === 'approved_then_paid', 'pay now settles the approved payout');
  hashes.push({ step: 'payout_3_usdc_paid', hash: String(approved['tx_hash']) });

  // 6. SDP, when this server has it.
  if (config['sdpAvailable'] === true) {
    const sdp = await agent(`console-e2e-${run}-sdp`, 1n, 'sdp');
    check(sdp['outcome'] === 'paid', 'the SDP payout is paid');
    hashes.push({ step: 'sdp_mandate_leg', hash: String(sdp['tx_hash']) });
    hashes.push({ step: 'sdp_payment', hash: String(sdp['sdp_tx_hash']) });
  } else {
    log('sdp: not available on this server, skipped');
  }

  // 7. Pause blocks, resume.
  await signAndSubmit('pause', await build('pause', { mandate }));
  const blocked = await agent(`console-e2e-${run}-3`, 1n);
  check(
    blocked['outcome'] === 'blocked' && blocked['reason'] === 'mandate_paused',
    'a payout while paused is blocked with mandate_paused',
  );
  await signAndSubmit('resume', await build('resume', { mandate }));

  // 8. Receipts, from the API and through the mandate's own MCP URL.
  const receipts = (await call(`/api/mandates/${mandate}/receipts`))['receipts'] as Json[];
  // One per task: paid, approved then paid, blocked while paused, and the SDP one when it ran.
  const expected = config['sdpAvailable'] === true ? 4 : 3;
  check(receipts.length === expected, `${receipts.length} receipts listed`);
  const client = new Client({ name: 'console-e2e', version: '0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${base}/m/${mandate}/mcp`)) as Transport,
  );
  const tools = await client.listTools();
  check(tools.tools.length === 4, 'the mandate MCP URL serves four tools');
  const viaMcp = await client.callTool({
    name: 'quote_payout',
    arguments: { recipient: 'tester', amount: usdc(1n) },
  });
  const quoteText = (viaMcp.content as { text: string }[])[0]?.text ?? '{}';
  check(
    (JSON.parse(quoteText) as Json)['decision'] === 'allowed',
    'quote_payout over MCP says allowed',
  );
  await client.close();

  // 9. The owner closes the mandate and takes the rest back.
  await signAndSubmit('revoke', await build('revoke', { mandate }));
  await signAndSubmit('sweep', await build('sweep', { mandate }));
  const closed = await call(`/api/mandates/${mandate}`);
  check((closed['state'] as Json)['revoked'] === true, 'the mandate is revoked');
  check((closed['state'] as Json)['balance'] === '0', 'the balance went back to the owner');

  // 10. The test recipient sends what it was paid back to the faucet treasury.
  // The treasury is whoever paid the first top up, read from the chain.
  const horizonUrl = String(config['horizonUrl']).replace(/\/+$/, '');
  const faucetTx = await horizon(`${horizonUrl}/transactions/${String(faucet['hash'])}`);
  const treasury = String(faucetTx['source_account']);
  const intervalSeconds = Number(process.env['UJIRA_RECYCLE_INTERVAL_SECONDS'] ?? '300');
  const recycleDeadline = Date.now() + (intervalSeconds + 120) * 1000;
  log(`waiting up to ${intervalSeconds + 120}s for the test recipient to recycle to ${treasury}`);
  let testerUsdc = String((await call(`/api/accounts/${tester}`))['usdc']);
  while (testerUsdc !== '0' && Date.now() < recycleDeadline) {
    await sleep(10_000);
    testerUsdc = String((await call(`/api/accounts/${tester}`))['usdc']);
  }
  check(testerUsdc === '0', 'the test recipient holds no USDC after recycling');
  const payments = await horizon(`${horizonUrl}/accounts/${tester}/payments?order=desc&limit=50`);
  const records = ((payments['_embedded'] as Json | undefined)?.['records'] ?? []) as Json[];
  const recycled = records.filter(
    (p) =>
      p['type'] === 'payment' &&
      p['from'] === tester &&
      p['to'] === treasury &&
      p['asset_code'] === 'USDC',
  );
  check(recycled.length > 0, `${recycled.length} recycle payment(s) went back to the treasury`);
  for (const p of recycled.reverse()) {
    hashes.push({ step: 'recycle_to_treasury', hash: String(p['transaction_hash']) });
    log(`recycled ${String(p['amount'])} USDC: ${String(p['transaction_hash'])}`);
  }

  // 11. Once the cooldown is over, a top up sends only what is missing.
  const readyAt = faucetAt + (cooldownSeconds + 5) * 1000;
  if (Date.now() < readyAt) {
    log(`waiting ${Math.ceil((readyAt - Date.now()) / 1000)}s for the faucet cooldown`);
    await sleep(readyAt - Date.now());
  }
  const before = BigInt(String((await call(`/api/accounts/${me}`))['usdc']));
  check(before < target, `the wallet holds ${before} minor units, below the target`);
  const topUp = await call('/api/onboard/usdc', { address: me });
  hashes.push({ step: 'faucet_top_up_2', hash: String(topUp['hash']) });
  log(`top up: ${String(topUp['amount'])} minor units, ${String(topUp['hash'])}`);
  check(topUp['amount'] === (target - before).toString(), 'the top up is target minus balance');
  const after = await call(`/api/accounts/${me}`);
  check(after['usdc'] === target.toString(), 'the wallet is back at the faucet target');

  const out = {
    network: 'testnet',
    console: base,
    owner: me,
    mandate,
    test_recipient: tester,
    treasury,
    sdp: config['sdpAvailable'] === true,
    at: new Date().toISOString(),
    transactions: hashes,
  };
  mkdirSync(join(root, 'evidence'), { recursive: true });
  writeFileSync(join(root, 'evidence', 'console-e2e.json'), `${JSON.stringify(out, null, 2)}\n`);
  log('done; transactions:');
  for (const h of hashes) log(`  ${h.step}: https://stellar.expert/explorer/testnet/tx/${h.hash}`);
}

main().catch((error: unknown) => {
  const message =
    error instanceof ApiFailure
      ? `${error.code} (${error.status}): ${error.message}`
      : error instanceof Error
        ? error.message
        : 'failed';
  process.stderr.write(`console-e2e: ${message}\n`);
  process.exit(1);
});
