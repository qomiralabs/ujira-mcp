// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// Opt in, against testnet: creates a throwaway mandate through the factory,
// funds it with exactly what the run pays, allows one recipient, and then runs
// the payout jobs for five payouts, one of them above the approval threshold,
// plus one the mandate refuses. Payouts are held in memory by the database's
// rules; the chain, the agent, the executor and the approver are real.
//
//   UJIRA_TESTNET=1 \
//   UJIRA_TESTNET_PRINCIPAL_KEY_FILE=... UJIRA_TESTNET_AGENT_KEY_FILE=... \
//   UJIRA_TESTNET_APPROVER_KEY_FILE=... UJIRA_EXECUTOR_KEY_FILE=... \
//   UJIRA_TESTNET_RECIPIENT=G... [UJIRA_TESTNET_OUT=run.json] \
//   npx vitest run test/payout-jobs.testnet.test.ts
//
// The principal needs 3 testnet USDC and the recipient a USDC trustline.

import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';

import { TransactionBuilder, scValToNative, type Transaction } from '@stellar/stellar-sdk';
import { describe, expect, it } from 'vitest';

import { callOptions, type SigningRequest, type TxSigner } from '../src/chain/adapter.js';
import { StellarChainAdapter } from '../src/chain/stellar/adapter.js';
import { RpcGateway, TESTNET_RPC_URL } from '../src/chain/stellar/gateway.js';
import { signerFromEnv } from '../src/chain/stellar/keys.js';
import {
  StellarNetwork,
  TESTNET_FRIENDBOT_URL,
  TESTNET_HORIZON_URL,
} from '../src/chain/stellar/network.js';
import {
  TESTNET_FACTORY,
  TESTNET_USDC_CONTRACT,
  TESTNET_USDC_ISSUER,
} from '../src/chain/stellar/testnet.js';
import { payoutSigners } from '../src/payouts/signers.js';
import { PayoutWorkflow, type StepOutcome } from '../src/payouts/workflow.js';
import { MemoryPayoutStore, PRINCIPAL, PROJECT } from './payout-memory-store.js';

const on = process.env['UJIRA_TESTNET'] === '1';
const UNIT = 10_000_000n;
// A tenth of a USDC.
const TENTH = UNIT / 10n;

function required(prefix: string): TxSigner {
  const signer = signerFromEnv(process.env, prefix);
  if (signer === undefined) throw new Error(`set ${prefix}_KEY_FILE`);
  return signer;
}

describe.skipIf(!on)('payout jobs on testnet', () => {
  it(
    'requests, waits for approval, executes and records five payouts',
    { timeout: 900_000 },
    async () => {
      const principal = required('UJIRA_TESTNET_PRINCIPAL');
      const agent = required('UJIRA_TESTNET_AGENT');
      const approver = required('UJIRA_TESTNET_APPROVER');
      const executor = required('UJIRA_EXECUTOR');
      const recipient = process.env['UJIRA_TESTNET_RECIPIENT'] ?? '';
      const rpcUrl = process.env['UJIRA_RPC_URL'] ?? TESTNET_RPC_URL;
      const network = new StellarNetwork({
        rpcUrl,
        horizonUrl: TESTNET_HORIZON_URL,
        friendbotUrl: TESTNET_FRIENDBOT_URL,
      });
      const adapter = new StellarChainAdapter({
        gateway: new RpcGateway({ rpcUrl, readSource: executor.publicKey }),
        chain: network,
        factory: TESTNET_FACTORY,
        asset: { code: 'USDC', issuer: TESTNET_USDC_ISSUER, contract: TESTNET_USDC_CONTRACT },
      });
      const opts = (id: string) => callOptions(id, 180_000);

      // Signs a prepared request and sends it, keeping what the contract returned.
      const signAndSend = async (request: SigningRequest, signer: TxSigner) => {
        const tx = TransactionBuilder.fromXdr(request.xdr, adapter.passphrase) as Transaction;
        signer.sign(tx);
        const sent = await network.submit(tx);
        expect(sent.status).toBe('SUCCESS');
        return sent;
      };

      const amounts = [3n * TENTH, 4n * TENTH, 5n * TENTH, 6n * TENTH, 12n * TENTH];
      const funded = amounts.reduce((sum, amount) => sum + amount, 0n);
      const now = BigInt(Math.floor(Date.now() / 1000));
      const created = await signAndSend(
        await adapter.prepareMandateAction(
          null,
          {
            kind: 'create',
            principal: principal.publicKey,
            agent: agent.publicKey,
            executor: executor.publicKey,
            approvers: [approver.publicKey],
            approvalsRequired: 1,
            limits: {
              totalBudget: funded,
              perPaymentCap: 2n * UNIT,
              perRecipientDailyCap: funded,
              approvalThreshold: UNIT,
              payoutTtlSeconds: 86_400n,
              expiresAt: now + 7n * 86_400n,
            },
            recipients: [],
          },
          opts('testnet-create'),
        ),
        principal,
      );
      const mandate = String(scValToNative(created.returnValue as never));
      expect(mandate).toMatch(/^C[A-Z2-7]{55}$/);
      const fund = await signAndSend(
        await adapter.prepareMandateAction(
          mandate,
          { kind: 'fund', from: principal.publicKey, amount: funded },
          opts('testnet-fund'),
        ),
        principal,
      );
      const recipientRef = randomBytes(32).toString('hex');
      const allow = await signAndSend(
        await adapter.prepareMandateAction(
          mandate,
          { kind: 'allow_recipients', entries: [{ recipientRef, destination: recipient }] },
          opts('testnet-allow'),
        ),
        principal,
      );

      const lines: string[] = [];
      const workflow = new PayoutWorkflow({
        chain: adapter,
        signers: payoutSigners({ executor, projectKeys: { signer: () => Promise.resolve(agent) } }),
        log: (line) => lines.push(line),
        readTimeoutMs: 30_000,
        sendTimeoutMs: 180_000,
      });

      const run = async (amount: bigint) => {
        const store = new MemoryPayoutStore(
          {
            amount,
            destination: recipient,
            recipientRef,
            onchainPayoutId: randomBytes(32).toString('hex'),
            contractAddress: mandate,
            agentAddress: agent.publicKey,
          },
          () => new Date(),
        );
        const job = {
          principalId: PRINCIPAL,
          projectId: PROJECT,
          payoutId: store.payout.id,
          signal: new AbortController().signal,
        };
        const outcomes: StepOutcome[] = [await workflow.advance(job, store)];
        let approveTx: string | undefined;
        if (outcomes[0] === 'waiting') {
          const approved = await signAndSend(
            await adapter.prepareMandateAction(
              mandate,
              {
                kind: 'approve',
                approver: approver.publicKey,
                payoutId: store.payout.onchainPayoutId,
              },
              opts('testnet-approve'),
            ),
            approver,
          );
          approveTx = approved.hash;
          outcomes.push(await workflow.advance(job, store));
        }
        if (store.payout.status === 'approved') outcomes.push(await workflow.execute(job, store));
        return {
          amount: amount.toString(),
          outcomes,
          history: store.history,
          status: store.payout.status,
          blockedBy: store.payout.blockedBy,
          onchainPayoutId: store.payout.onchainPayoutId,
          requestTx: store.payout.requestTxHash,
          approveTx: approveTx ?? null,
          executeTx: store.legs[0]?.txHash ?? null,
        };
      };

      const payouts = [];
      for (const amount of amounts) payouts.push(await run(amount));
      // Over the per payment cap: refused by the contract, nothing sent.
      const refused = await run(3n * UNIT);

      const result = {
        network: adapter.network,
        mandate,
        transactions: { create: created.hash, fund: fund.hash, allow: allow.hash },
        payouts,
        refused,
        log: lines,
      };
      const out = process.env['UJIRA_TESTNET_OUT'];
      if (out !== undefined && out !== '')
        writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);

      for (const p of payouts) expect(p.status).toBe('paid');
      expect(payouts.filter((p) => p.approveTx !== null)).toHaveLength(1);
      expect(payouts.at(-1)?.history).toEqual([
        'queued',
        'submitting',
        'pending_approval',
        'approved',
        'settling',
        'paid',
      ]);
      expect(payouts[0]?.history).toEqual(['queued', 'submitting', 'approved', 'settling', 'paid']);
      expect(refused).toMatchObject({ status: 'blocked', blockedBy: 'PAYMENT_CAP_EXCEEDED' });
      const state = await adapter.readMandate(mandate, opts('testnet-read'));
      expect(state.state.spent).toBe(funded);
    },
  );
});
