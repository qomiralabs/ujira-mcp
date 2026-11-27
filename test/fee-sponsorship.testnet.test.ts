// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// Opt in, against testnet: the fee sponsor opens a fresh account with exactly
// its minimum balance, that account signs a mandate create as principal, and
// the create goes out inside a fee bump the sponsor pays. The principal ends
// with the balance it started with. Costs the sponsor test XLM only.
//
//   UJIRA_TESTNET=1 UJIRA_FEE_SPONSOR_KEY_FILE=... npx vitest run test/fee-sponsorship.testnet.test.ts

import { Keypair, Operation, TransactionBuilder, type Transaction } from '@stellar/stellar-sdk';
import { describe, expect, it } from 'vitest';

import { callOptions } from '../src/chain/adapter.js';
import { StellarChainAdapter } from '../src/chain/stellar/adapter.js';
import { RpcGateway, TESTNET_PASSPHRASE, TESTNET_RPC_URL } from '../src/chain/stellar/gateway.js';
import { signerFromEnv, signerFrom } from '../src/chain/stellar/keys.js';
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
import {
  SponsoredSubmitter,
  type FeeLedger,
  type FeeReservation,
} from '../src/payouts/fee-sponsorship.js';

const on = process.env['UJIRA_TESTNET'] === '1';
const UNIT = 10_000_000n;
// Two base reserves of 0.5 XLM: the least an account with no entries may hold.
const MINIMUM = '1';

/** Every reservation fits; the test is about who pays, not the cap. */
class OpenLedger implements FeeLedger {
  settled: bigint[] = [];
  reserve(_t: unknown, entry: { maxFee: bigint }): Promise<FeeReservation> {
    return Promise.resolve({ kind: 'reserved', used: entry.maxFee });
  }
  settle(_t: unknown, entry: { charged: bigint }): Promise<boolean> {
    this.settled.push(entry.charged);
    return Promise.resolve(true);
  }
  release(): Promise<boolean> {
    return Promise.resolve(true);
  }
}

describe.skipIf(!on)('fee sponsorship on testnet', () => {
  it(
    'lets an account holding only its reserve create a mandate',
    { timeout: 300_000 },
    async () => {
      const sponsor = signerFromEnv(process.env, 'UJIRA_FEE_SPONSOR');
      if (sponsor === undefined) throw new Error('set UJIRA_FEE_SPONSOR_KEY_FILE or _SECRET');
      const rpcUrl = process.env['UJIRA_RPC_URL'] ?? TESTNET_RPC_URL;
      const network = new StellarNetwork({
        rpcUrl,
        horizonUrl: TESTNET_HORIZON_URL,
        friendbotUrl: TESTNET_FRIENDBOT_URL,
      });
      const asset = { code: 'USDC', issuer: TESTNET_USDC_ISSUER, contract: TESTNET_USDC_CONTRACT };

      const owner = Keypair.random();
      const open = new TransactionBuilder(await network.loadAccount(sponsor.publicKey), {
        fee: '10000',
        networkPassphrase: TESTNET_PASSPHRASE,
      })
        .addOperation(
          Operation.createAccount({ destination: owner.publicKey(), startingBalance: MINIMUM }),
        )
        .setTimeout(120)
        .build();
      sponsor.sign(open);
      const opened = await network.submit(open);
      expect(opened.status).toBe('SUCCESS');
      // Horizon follows the ledger a few seconds behind RPC.
      let before = await network.account(owner.publicKey(), asset);
      for (let i = 0; i < 20 && !before.exists; i++) {
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        before = await network.account(owner.publicKey(), asset);
      }
      expect(before.xlm).toBe('1.0000000');

      const adapter = new StellarChainAdapter({
        gateway: new RpcGateway({ rpcUrl, readSource: sponsor.publicKey }),
        chain: network,
        factory: TESTNET_FACTORY,
        asset,
        feeSponsor: sponsor,
      });
      const req = await adapter.prepareMandateAction(
        null,
        {
          kind: 'create',
          principal: owner.publicKey(),
          agent: Keypair.random().publicKey(),
          executor: Keypair.random().publicKey(),
          approvers: [owner.publicKey()],
          approvalsRequired: 1,
          limits: {
            totalBudget: 100n * UNIT,
            perPaymentCap: 10n * UNIT,
            perRecipientDailyCap: 20n * UNIT,
            approvalThreshold: 5n * UNIT,
            payoutTtlSeconds: 86_400n,
            expiresAt: BigInt(Math.floor(Date.now() / 1000) + 30 * 86_400),
          },
          recipients: [],
        },
        callOptions('testnet-fee-sponsor', 60_000),
      );
      const tx = TransactionBuilder.fromXdr(req.xdr, TESTNET_PASSPHRASE) as Transaction;
      signerFrom(owner).sign(tx);

      const ledger = new OpenLedger();
      const logs: string[] = [];
      const submitter = new SponsoredSubmitter({
        adapter,
        ledger,
        settings: { dailyCap: 1_000n * UNIT },
        log: (line) => logs.push(line),
      });
      const { txHash } = await submitter.submit(
        {
          principalId: '00000000-0000-4000-8000-000000000001',
          projectId: '00000000-0000-4000-8000-000000000002',
        },
        tx.toXdr(),
        req,
        callOptions('testnet-fee-sponsor', 180_000),
      );
      console.log(`principal ${owner.publicKey()} created a mandate in ${txHash}`);
      console.log(`sponsor charged ${ledger.settled.join(', ')} stroops`);
      for (const line of logs) console.log(line);

      const looked = await adapter.transaction(txHash, callOptions('lookup', 30_000));
      expect(looked.status).toBe('SUCCESS');
      const after = await network.account(owner.publicKey(), asset);
      expect(after.xlm).toBe(before.xlm);
      expect(ledger.settled).toHaveLength(1);
    },
  );
});
