// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// Opt in, against testnet: a throwaway wallet, funded by friendbot, prepares
// a mandate through POST /v1/mandates/prepare, signs it, submits it through
// POST /v1/signing/submit, reads it back, then pauses it the same way. Only
// public keys and transaction hashes are printed. The store is the in memory
// one; the chain, the factory and the adapter are the real ones.
//
//   UJIRA_TESTNET=1 npx vitest run test/mandate-routes.testnet.test.ts

import { randomUUID } from 'node:crypto';

import { Keypair } from '@stellar/stellar-sdk';
import { describe, expect, it } from 'vitest';

import { createV1App } from '../src/api/app.js';
import { createAuthenticate } from '../src/api/authenticate.js';
import { memoryIdempotencyStore } from '../src/api/idempotency.js';
import { mandateRoutes } from '../src/api/routes/mandates.js';
import { newSessionToken, sessionTokenHash, SESSION_COOKIE } from '../src/auth/session-token.js';
import { SignIn } from '../src/auth/sign-in.js';
import { StellarChainAdapter } from '../src/chain/stellar/adapter.js';
import { RpcGateway, TESTNET_RPC_URL } from '../src/chain/stellar/gateway.js';
import { signerFrom } from '../src/chain/stellar/keys.js';
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
import { MandateService } from '../src/payouts/mandates.js';
import { MemoryMandateStore, ProjectSignInStore, signEnvelope } from './mandate-helpers.js';
import { ORIGIN, verifier } from './sign-in-helpers.js';

const on = process.env['UJIRA_TESTNET'] === '1';

describe.skipIf(!on)('mandate routes on testnet', () => {
  it(
    'prepares, signs, submits and reads back a mandate, then pauses it',
    { timeout: 300_000 },
    async () => {
      const wallet = Keypair.random();
      // The agent and executor are only named in the mandate; nothing here signs as them.
      const agentKey = Keypair.random().publicKey();
      const executorKey = Keypair.random().publicKey();
      const network = new StellarNetwork({
        rpcUrl: process.env['UJIRA_RPC_URL'] ?? TESTNET_RPC_URL,
        horizonUrl: TESTNET_HORIZON_URL,
        friendbotUrl: TESTNET_FRIENDBOT_URL,
      });
      await network.friendbot(wallet.publicKey());
      const adapter = new StellarChainAdapter({
        gateway: new RpcGateway({ readSource: wallet.publicKey() }),
        chain: network,
        factory: TESTNET_FACTORY,
        asset: { code: 'USDC', issuer: TESTNET_USDC_ISSUER, contract: TESTNET_USDC_CONTRACT },
      });
      const store = new MemoryMandateStore();
      const clock = { now: Date.now() };
      const signIns = new ProjectSignInStore(clock);
      const service = new MandateService({
        adapter,
        store,
        executor: executorKey,
        unit: { code: 'USDC', scale: 7, contract: TESTNET_USDC_CONTRACT },
      });
      const app = createV1App({
        routes: mandateRoutes({
          authenticate: createAuthenticate({
            // No keys on this run; every call is the signed in wallet.
            tokens: {
              authenticate: () => Promise.resolve({ ok: false, code: 'TOKEN_INVALID' }),
              forget: () => undefined,
            },
            session: {
              signIn: new SignIn({ store: signIns, verifier, origin: ORIGIN }),
              origin: ORIGIN,
            },
          }),
          service,
          idempotency: memoryIdempotencyStore(),
          log: () => undefined,
        }),
      }).app;

      const context = { principalId: randomUUID(), projectId: randomUUID() };
      store.addAgentKey(context, agentKey);
      signIns.access.set(`${wallet.publicKey()}|${context.projectId}`, {
        ...context,
        role: 'owner',
      });
      const token = newSessionToken();
      const hash = sessionTokenHash(token);
      if (hash === undefined) throw new Error('a new token did not hash');
      await signIns.createSession({
        tokenSha256: hash,
        walletAddress: wallet.publicKey(),
        idleSeconds: 3_600,
        absoluteSeconds: 3_600,
      });
      const call = async (method: string, path: string, body?: unknown, key?: string) => {
        const res = await app.fetch(
          new Request(`${ORIGIN}${path}`, {
            method,
            headers: {
              origin: ORIGIN,
              cookie: `${SESSION_COOKIE}=${token}`,
              'ujira-project': context.projectId,
              ...(body === undefined ? {} : { 'content-type': 'application/json' }),
              ...(key === undefined ? {} : { 'idempotency-key': key }),
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          }),
        );
        return { status: res.status, json: (await res.json()) as Record<string, unknown> };
      };
      const signed = signerFrom(wallet);
      const token7 = (amount: string) => ({
        amount,
        asset: 'USDC',
        network: 'stellar:testnet',
        scale: 7,
      });

      const prepared = await call('POST', '/v1/mandates/prepare', {
        name: 'Testnet route run',
        limits: {
          totalBudget: token7('1000000000'),
          perPaymentCap: token7('100000000'),
          perRecipientDailyCap: token7('200000000'),
          approvalThreshold: token7('50000000'),
          expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
        },
      });
      expect(prepared.status, JSON.stringify(prepared.json)).toBe(201);
      const create = prepared.json['signingRequest'] as { id: string; xdr: string };
      const sent = await call(
        'POST',
        '/v1/signing/submit',
        { signingRequestId: create.id, xdr: signEnvelope(create.xdr, signed) },
        `submit:${create.id}`,
      );
      expect(sent.status, JSON.stringify(sent.json)).toBe(200);
      const mandateId = String(sent.json['mandateId']);

      const detail = await call('GET', `/v1/mandates/${mandateId}`);
      expect(detail.status, JSON.stringify(detail.json)).toBe(200);
      const mandate = detail.json['mandate'] as {
        contractId: string;
        config: { principal: string; agents: string[]; approvers: string[]; executors: string[] };
        state: { paused: boolean };
      };
      expect(mandate.config).toMatchObject({
        principal: wallet.publicKey(),
        agents: [agentKey],
        // No approvers were named, so the owner's own wallet is the one approver.
        approvers: [wallet.publicKey()],
        executors: [executorKey],
      });

      const pause = await call('POST', `/v1/mandates/${mandateId}/actions`, { kind: 'pause' });
      expect(pause.status, JSON.stringify(pause.json)).toBe(201);
      const pauseReq = pause.json['signingRequest'] as { id: string; xdr: string };
      const paused = await call(
        'POST',
        '/v1/signing/submit',
        { signingRequestId: pauseReq.id, xdr: signEnvelope(pauseReq.xdr, signed) },
        `submit:${pauseReq.id}`,
      );
      expect(paused.status, JSON.stringify(paused.json)).toBe(200);
      const after = await call('GET', `/v1/mandates/${mandateId}`);
      expect((after.json['mandate'] as { state: { paused: boolean } }).state.paused).toBe(true);

      console.log(
        [
          `principal ${wallet.publicKey()}`,
          `mandate ${mandate.contractId}`,
          `create tx ${String(sent.json['txHash'])}`,
          `pause tx ${String(paused.json['txHash'])}`,
        ].join('\n'),
      );
    },
  );
});
