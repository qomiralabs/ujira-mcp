// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

import { randomBytes, randomUUID } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import { ChainError } from '../chain/adapter.js';
import type { AgentAccounts } from '../chain/agent-accounts.js';
import { StellarAgentAccounts } from '../chain/stellar/agent-accounts.js';
import type {
  AgentKey,
  FundingAttempt,
  NewAgentKey,
  ProjectContext,
  SealedAgentSecret,
} from '../db/index.js';
import {
  AgentKeyError,
  agentSecretAssociatedData,
  createAgentKeyService,
  MAX_FUNDING_ATTEMPTS,
  type AgentKeyFundingJob,
  type AgentKeyStore,
} from './agent-keys.js';
import { createSealer, type Sealer } from './sealer.js';

const NETWORK = 'stellar:testnet';

interface Row {
  readonly principalId: string;
  readonly projectId: string;
  key: AgentKey;
  ciphertext: Buffer;
  nonce: Buffer;
}

// Answers only for the context's own project, the way the tenant policies do.
class MemoryStore implements AgentKeyStore {
  readonly rows: Row[] = [];

  private mine(context: ProjectContext): Row[] {
    return this.rows.filter(
      (r) => r.principalId === context.principalId && r.projectId === context.projectId,
    );
  }

  active(context: ProjectContext, network: string): Promise<AgentKey | undefined> {
    return Promise.resolve(
      this.mine(context).find((r) => r.key.network === network && r.key.status === 'active')?.key,
    );
  }

  get(context: ProjectContext, id: string): Promise<AgentKey | undefined> {
    return Promise.resolve(this.mine(context).find((r) => r.key.id === id)?.key);
  }

  create(context: ProjectContext, input: NewAgentKey): Promise<AgentKey | undefined> {
    if (
      this.mine(context).some((r) => r.key.network === input.network && r.key.status === 'active')
    ) {
      return Promise.resolve(undefined);
    }
    const key: AgentKey = {
      id: randomUUID(),
      projectId: context.projectId,
      network: input.network,
      publicKey: input.publicKey,
      status: 'active',
      funding: { status: 'pending', attempts: 0, lastError: null, fundedAt: null },
      createdAt: new Date(),
    };
    this.rows.push({
      principalId: context.principalId,
      projectId: context.projectId,
      key,
      ciphertext: input.secretCiphertext,
      nonce: input.secretNonce,
    });
    return Promise.resolve(key);
  }

  recordFunding(
    context: ProjectContext,
    id: string,
    attempt: FundingAttempt,
  ): Promise<AgentKey | undefined> {
    const row = this.mine(context).find((r) => r.key.id === id);
    if (row === undefined || row.key.funding.status === 'funded') return Promise.resolve(undefined);
    const attempts = row.key.funding.attempts + 1;
    row.key = {
      ...row.key,
      funding:
        attempt.kind === 'funded'
          ? { status: 'funded', attempts, lastError: null, fundedAt: new Date() }
          : {
              status: attempt.final ? 'failed' : 'pending',
              attempts,
              lastError: attempt.error,
              fundedAt: null,
            },
    };
    return Promise.resolve(row.key);
  }

  sealedSecret(context: ProjectContext, id: string): Promise<SealedAgentSecret | undefined> {
    const row = this.mine(context).find((r) => r.key.id === id);
    return Promise.resolve(
      row === undefined
        ? undefined
        : {
            id: row.key.id,
            projectId: row.projectId,
            network: row.key.network,
            publicKey: row.key.publicKey,
            ciphertext: row.ciphertext,
            nonce: row.nonce,
          },
    );
  }

  row(id: string): Row {
    const found = this.rows.find((r) => r.key.id === id);
    if (found === undefined) throw new Error('no such row');
    return found;
  }
}

function project(principalId = randomUUID()): ProjectContext {
  return { principalId, projectId: randomUUID() };
}

function network() {
  return {
    friendbot: vi.fn<(address: string) => Promise<void>>(() => Promise.resolve()),
    accountFacts: vi.fn(() =>
      Promise.resolve({ exists: true, trustlines: [] as string[], memoRequired: false }),
    ),
  };
}

function world(options: { sealer?: Sealer; accounts?: AgentAccounts } = {}) {
  const store = new MemoryStore();
  const chain = network();
  const accounts = options.accounts ?? new StellarAgentAccounts({ network: NETWORK, chain });
  const sealer = options.sealer ?? createSealer(randomBytes(32).toString('base64'));
  const lines: string[] = [];
  const jobs: AgentKeyFundingJob[] = [];
  const service = createAgentKeyService({
    store,
    sealer,
    accounts,
    log: (line) => lines.push(line),
    enqueueFunding: (job) => {
      jobs.push(job);
      return Promise.resolve();
    },
  });
  return { store, chain, accounts, sealer, lines, jobs, service };
}

async function agentKeyError(promise: Promise<unknown>): Promise<AgentKeyError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AgentKeyError) return error;
    throw error;
  }
  throw new Error('expected an AgentKeyError');
}

describe('agent key provisioning', () => {
  it('gives a project one key, sealed for that project, and funds its account', async () => {
    const w = world();
    const a = project();
    const key = await w.service.provision(a, 'req-1');

    expect(key.network).toBe(NETWORK);
    expect(key.publicKey).toMatch(/^G[A-Z2-7]{55}$/);
    expect(key.funding).toMatchObject({ status: 'funded', attempts: 1, lastError: null });
    expect(w.chain.friendbot).toHaveBeenCalledWith(key.publicKey);
    expect(w.jobs).toEqual([
      {
        task: 'agent_key.fund',
        queue: null,
        jobKey: `agent-key:${key.id}:fund`,
        payload: { principalId: a.principalId, projectId: a.projectId, agentKeyId: key.id },
      },
    ]);

    const row = w.store.row(key.id);
    const opened = w.sealer.open(row, agentSecretAssociatedData(a, NETWORK, key.publicKey));
    expect(opened).toHaveLength(32);
    // The stored bytes are ciphertext: the seed itself is nowhere in them.
    expect(row.ciphertext.includes(opened)).toBe(false);
    expect(w.lines.some((l) => l.startsWith('event=agent_key_created'))).toBe(true);
  });

  it('zeroes the generated secret once it is sealed', async () => {
    const w = world();
    const generated: Buffer[] = [];
    const generate = w.accounts.generate.bind(w.accounts);
    vi.spyOn(w.accounts, 'generate').mockImplementation(() => {
      const key = generate();
      generated.push(key.secret);
      return key;
    });
    await w.service.provision(project(), 'req-2');
    expect(generated).toHaveLength(1);
    expect(generated[0]?.every((byte) => byte === 0)).toBe(true);
  });

  it('is safe to repeat and to race: a project never holds two active keys', async () => {
    const w = world();
    const a = project();
    const [one, two] = await Promise.all([
      w.service.provision(a, 'req-3'),
      w.service.provision(a, 'req-4'),
    ]);
    const three = await w.service.provision(a, 'req-5');
    expect(two.id).toBe(one.id);
    expect(three.id).toBe(one.id);
    expect(w.store.rows).toHaveLength(1);
    expect(w.jobs).toHaveLength(1);
  });

  it('gives each project its own key, even under one principal', async () => {
    const w = world();
    const principal = randomUUID();
    const a = project(principal);
    const b = project(principal);
    const ka = await w.service.provision(a, 'req-6');
    const kb = await w.service.provision(b, 'req-7');
    expect(ka.id).not.toBe(kb.id);
    expect(ka.publicKey).not.toBe(kb.publicKey);
  });

  it('never writes the secret, the sealed bytes or the key encryption key to a log line', async () => {
    const kek = randomBytes(32).toString('base64');
    const w = world({ sealer: createSealer(kek) });
    const a = project();
    const key = await w.service.provision(a, 'req-8');
    await w.service.signer(a, key.id);
    const row = w.store.row(key.id);
    const seed = w.sealer.open(row, agentSecretAssociatedData(a, NETWORK, key.publicKey));
    const logged = w.lines.join('\n');
    for (const secretish of [
      kek,
      seed.toString('base64'),
      seed.toString('hex'),
      row.ciphertext.toString('base64'),
      row.ciphertext.toString('hex'),
    ]) {
      expect(logged).not.toContain(secretish);
    }
    // Ids and the event, nothing else.
    expect(logged).not.toContain(key.publicKey);
  });
});

describe('agent key signers', () => {
  it('signs with the project own key, and finds no other project key', async () => {
    const w = world();
    const principal = randomUUID();
    const a = project(principal);
    const b = project(principal);
    const c = project();
    const ka = await w.service.provision(a, 'req-9');
    const kb = await w.service.provision(b, 'req-10');
    const kc = await w.service.provision(c, 'req-11');

    expect((await w.service.signer(a, ka.id)).publicKey).toBe(ka.publicKey);
    expect((await w.service.activeSigner(b)).publicKey).toBe(kb.publicKey);

    // A sibling project of the same principal, and another principal altogether.
    for (const foreign of [kb.id, kc.id]) {
      const error = await agentKeyError(w.service.signer(a, foreign));
      expect(error.code).toBe('KEY_NOT_FOUND');
    }
  });

  it('refuses a ciphertext moved onto another project row (associated data)', async () => {
    const w = world();
    const a = project();
    const b = project();
    const ka = await w.service.provision(a, 'req-12');
    const kb = await w.service.provision(b, 'req-13');

    // B's sealed secret copied onto A's row, as a bad update or restore might.
    const rowA = w.store.row(ka.id);
    const rowB = w.store.row(kb.id);
    rowA.ciphertext = rowB.ciphertext;
    rowA.nonce = rowB.nonce;

    const error = await agentKeyError(w.service.signer(a, ka.id));
    expect(error.code).toBe('KEY_UNREADABLE');
    expect(error.message).not.toContain(ka.publicKey);
    expect(error.message).not.toContain(a.projectId);
  });

  it('refuses a row whose account was swapped for another one', async () => {
    const w = world();
    const a = project();
    const ka = await w.service.provision(a, 'req-14');
    const row = w.store.row(ka.id);
    row.key = { ...row.key, publicKey: w.accounts.generate().publicKey };
    expect((await agentKeyError(w.service.signer(a, ka.id))).code).toBe('KEY_UNREADABLE');
  });

  it('refuses a secret sealed under another key encryption key', async () => {
    const w = world();
    const a = project();
    const ka = await w.service.provision(a, 'req-15');
    const rotated = createAgentKeyService({
      store: w.store,
      sealer: createSealer(randomBytes(32).toString('base64')),
      accounts: w.accounts,
    });
    expect((await agentKeyError(rotated.signer(a, ka.id))).code).toBe('KEY_UNREADABLE');
  });

  it('zeroes the opened secret once the signer is made', async () => {
    const w = world();
    const a = project();
    const ka = await w.service.provision(a, 'req-16');
    const opened: Buffer[] = [];
    const spying: Sealer = {
      seal: (p, ad) => w.sealer.seal(p, ad),
      open: (s, ad) => {
        const plain = w.sealer.open(s, ad);
        opened.push(plain);
        return plain;
      },
    };
    const service = createAgentKeyService({ store: w.store, sealer: spying, accounts: w.accounts });
    const signer = await service.signer(a, ka.id);
    expect(signer.publicKey).toBe(ka.publicKey);
    expect(opened).toHaveLength(1);
    expect(opened[0]?.every((byte) => byte === 0)).toBe(true);
  });

  it('answers KEY_NOT_FOUND for a project with no key yet', async () => {
    const w = world();
    expect((await agentKeyError(w.service.activeSigner(project()))).code).toBe('KEY_NOT_FOUND');
  });
});

describe('agent key funding', () => {
  it('records a failed attempt, keeps the key pending, and asks the job to retry', async () => {
    const w = world();
    w.chain.friendbot.mockRejectedValue(new Error('friendbot is down'));
    const a = project();
    const key = await w.service.provision(a, 'req-17');
    expect(key.funding).toMatchObject({ status: 'pending', attempts: 1, lastError: 'UNAVAILABLE' });
    expect(w.lines.some((l) => l.startsWith('event=agent_key_funding_failed'))).toBe(true);
    const error = await agentKeyError(
      w.service.runFundingJob(
        { principalId: a.principalId, projectId: a.projectId, agentKeyId: key.id },
        'job-1',
      ),
    );
    expect(error.code).toBe('FUNDING_PENDING');
    expect((await w.service.active(a))?.funding.attempts).toBe(2);
  });

  it('stops after the last attempt, logs the dead letter, and lets a person retry', async () => {
    const w = world();
    w.chain.friendbot.mockRejectedValue(new Error('friendbot is down'));
    const a = project();
    const key = await w.service.provision(a, 'req-18');
    const payload = { principalId: a.principalId, projectId: a.projectId, agentKeyId: key.id };
    for (let attempt = 2; attempt < MAX_FUNDING_ATTEMPTS; attempt++) {
      await expect(w.service.runFundingJob(payload, `job-${String(attempt)}`)).rejects.toThrow(
        AgentKeyError,
      );
    }
    // The last attempt dead letters, and the job ends rather than retrying.
    await w.service.runFundingJob(payload, 'job-last');
    const failed = await w.service.active(a);
    expect(failed?.funding).toMatchObject({
      status: 'failed',
      attempts: MAX_FUNDING_ATTEMPTS,
      lastError: 'UNAVAILABLE',
    });
    expect(w.lines.filter((l) => l.startsWith('event=agent_key_funding_dead_letter'))).toHaveLength(
      1,
    );

    // Nothing tries again on its own.
    const calls = w.chain.friendbot.mock.calls.length;
    await w.service.runFundingJob(payload, 'job-after');
    await w.service.provision(a, 'req-19');
    expect(w.chain.friendbot.mock.calls.length).toBe(calls);

    // A person asks, the network is back.
    w.chain.friendbot.mockResolvedValue(undefined);
    const funded = await w.service.fund(a, key.id, 'req-20', { retryFailed: true });
    expect(funded.funding).toMatchObject({ status: 'funded', lastError: null });
  });

  it('retries a pending key when it is provisioned again', async () => {
    const w = world();
    w.chain.friendbot.mockRejectedValueOnce(new Error('friendbot is down'));
    const a = project();
    expect((await w.service.provision(a, 'req-21')).funding.status).toBe('pending');
    expect((await w.service.provision(a, 'req-22')).funding.status).toBe('funded');
  });

  it('does not call the network again for a funded key', async () => {
    const w = world();
    const a = project();
    const key = await w.service.provision(a, 'req-23');
    await w.service.runFundingJob(
      { principalId: a.principalId, projectId: a.projectId, agentKeyId: key.id },
      'job-2',
    );
    expect(w.chain.friendbot).toHaveBeenCalledTimes(1);
  });

  it('lets a bug through rather than recording it as an outage', async () => {
    const store = new MemoryStore();
    const real = new StellarAgentAccounts({ network: NETWORK, chain: network() });
    const accounts: AgentAccounts = {
      network: NETWORK,
      generate: () => real.generate(),
      signer: (s, p) => real.signer(s, p),
      fund: () => Promise.reject(new TypeError('a bug')),
    };
    const service = createAgentKeyService({
      store,
      sealer: createSealer(randomBytes(32).toString('base64')),
      accounts,
    });
    const a = project();
    await expect(service.provision(a, 'req-24')).rejects.toThrow(TypeError);
    expect((await service.active(a))?.funding.attempts).toBe(0);
  });

  it('records the chain error code only', async () => {
    const w = world();
    w.chain.friendbot.mockRejectedValue(
      new ChainError('TIMEOUT', 'friendbot at https://example.invalid did not answer'),
    );
    const key = await w.service.provision(project(), 'req-25');
    expect(key.funding.lastError).toBe('TIMEOUT');
  });

  it('ends a job for a key outside its tenant without retrying', async () => {
    const w = world();
    const a = project();
    const key = await w.service.provision(a, 'req-26');
    await w.service.runFundingJob(
      { principalId: a.principalId, projectId: randomUUID(), agentKeyId: key.id },
      'job-3',
    );
    expect(w.lines.some((l) => l.startsWith('event=agent_key_funding_skipped'))).toBe(true);
    await expect(w.service.fund(project(), key.id, 'req-27')).rejects.toMatchObject({
      code: 'KEY_NOT_FOUND',
    });
  });
});
