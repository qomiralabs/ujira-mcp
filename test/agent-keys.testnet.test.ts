// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// Opt in, against testnet: a new project gets its agent key, friendbot opens
// the account, and the account exists on chain with no trustline, since an
// agent never holds USDC. The key lives only in memory for the run; the store
// stands in for Postgres, which the db tests cover.
//
//   UJIRA_TESTNET=1 npx vitest run test/agent-keys.testnet.test.ts

import { randomBytes, randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { StellarAgentAccounts } from '../src/chain/stellar/agent-accounts.js';
import { TESTNET_RPC_URL } from '../src/chain/stellar/gateway.js';
import {
  StellarNetwork,
  TESTNET_FRIENDBOT_URL,
  TESTNET_HORIZON_URL,
} from '../src/chain/stellar/network.js';
import type { AgentKey, ProjectContext, SealedAgentSecret } from '../src/db/index.js';
import { createAgentKeyService, type AgentKeyStore } from '../src/keys/agent-keys.js';
import { createSealer } from '../src/keys/sealer.js';

const on = process.env['UJIRA_TESTNET'] === '1';

// One project, one row: enough to drive the service against the real network.
function oneProjectStore(owner: ProjectContext): AgentKeyStore {
  let row: { key: AgentKey; ciphertext: Buffer; nonce: Buffer } | undefined;
  const mine = (c: ProjectContext) =>
    c.principalId === owner.principalId && c.projectId === owner.projectId ? row : undefined;
  return {
    active: (c) => Promise.resolve(mine(c)?.key),
    get: (c, id) => Promise.resolve(mine(c)?.key.id === id ? mine(c)?.key : undefined),
    create(c, input) {
      if (mine(c) !== undefined) return Promise.resolve(undefined);
      row = {
        key: {
          id: randomUUID(),
          projectId: c.projectId,
          network: input.network,
          publicKey: input.publicKey,
          status: 'active',
          funding: { status: 'pending', attempts: 0, lastError: null, fundedAt: null },
          createdAt: new Date(),
        },
        ciphertext: input.secretCiphertext,
        nonce: input.secretNonce,
      };
      return Promise.resolve(row.key);
    },
    recordFunding(c, id, attempt) {
      const found = mine(c);
      if (found === undefined || found.key.id !== id) return Promise.resolve(undefined);
      const attempts = found.key.funding.attempts + 1;
      found.key = {
        ...found.key,
        funding:
          attempt.kind === 'funded'
            ? { status: 'funded', attempts, lastError: null, fundedAt: new Date() }
            : { status: 'pending', attempts, lastError: attempt.error, fundedAt: null },
      };
      return Promise.resolve(found.key);
    },
    sealedSecret(c, id): Promise<SealedAgentSecret | undefined> {
      const found = mine(c);
      return Promise.resolve(
        found === undefined || found.key.id !== id
          ? undefined
          : {
              id,
              projectId: c.projectId,
              network: found.key.network,
              publicKey: found.key.publicKey,
              ciphertext: found.ciphertext,
              nonce: found.nonce,
            },
      );
    },
  };
}

describe.skipIf(!on)('agent keys on testnet', () => {
  it(
    'opens a funded account for a new project, with no trustline',
    { timeout: 120_000 },
    async () => {
      const network = new StellarNetwork({
        rpcUrl: TESTNET_RPC_URL,
        horizonUrl: TESTNET_HORIZON_URL,
        friendbotUrl: TESTNET_FRIENDBOT_URL,
      });
      const project = { principalId: randomUUID(), projectId: randomUUID() };
      const service = createAgentKeyService({
        store: oneProjectStore(project),
        sealer: createSealer(randomBytes(32).toString('base64')),
        accounts: new StellarAgentAccounts({ network: 'stellar:testnet', chain: network }),
      });

      const key = await service.provision(project, 'testnet-run');
      expect(key.funding.status).toBe('funded');

      const facts = await network.accountFacts(key.publicKey);
      expect(facts.exists).toBe(true);
      expect(facts.trustlines).toEqual([]);
      expect((await service.activeSigner(project)).publicKey).toBe(key.publicKey);
      // The account address is public; it is printed so a run can be checked on an explorer.
      process.stdout.write(`agent account ${key.publicKey}\n`);
    },
  );
});
