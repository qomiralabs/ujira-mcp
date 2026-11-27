// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// Every project gets its own agent key, and its mandates name that key as
// their agent. The chain then refuses one project's key on another project's
// mandate, so tenant isolation holds on chain even if code here picked the
// wrong row.
//
// The secret is sealed under the key encryption key with the tenant, the
// network and the account bound in as associated data, so a ciphertext copied
// onto another project's row does not open there. It is opened only inside
// signer(), held in memory for as long as it takes to make a signer, and the
// plaintext buffer is zeroed after. No method returns it, and no log line or
// error carries it.
//
// Storage is a port, so these rules are tested without a database; the
// Postgres side is postgres-store.ts.

import type { AgentAccounts } from '../chain/agent-accounts.js';
import { callOptions, ChainError } from '../chain/adapter.js';
import type { TxSigner } from '../chain/types.js';
import type {
  AgentKey,
  FundingAttempt,
  NewAgentKey,
  ProjectContext,
  SealedAgentSecret,
} from '../db/index.js';
import { SealError, type Sealer } from './sealer.js';

// Attempts before a key reads as failed. Friendbot outages tend to last
// minutes, and the job runner backs off between attempts, so ten covers a bad
// hour without retrying forever.
export const MAX_FUNDING_ATTEMPTS = 10;

// Friendbot can take tens of seconds on a busy testnet.
export const FUNDING_TIMEOUT_MS = 60_000;

export interface AgentKeyStore {
  active(context: ProjectContext, network: string): Promise<AgentKey | undefined>;
  get(context: ProjectContext, id: string): Promise<AgentKey | undefined>;
  // Undefined when the project already holds an active key on that network,
  // because a concurrent call made it first.
  create(context: ProjectContext, key: NewAgentKey): Promise<AgentKey | undefined>;
  // Undefined when the key is already funded or outside the context.
  recordFunding(
    context: ProjectContext,
    id: string,
    attempt: FundingAttempt,
  ): Promise<AgentKey | undefined>;
  // Only the worker can read this; see the agent_keys grants.
  sealedSecret(context: ProjectContext, id: string): Promise<SealedAgentSecret | undefined>;
}

export type AgentKeyErrorCode = 'KEY_NOT_FOUND' | 'KEY_UNREADABLE' | 'FUNDING_PENDING';

export class AgentKeyError extends Error {
  override readonly name = 'AgentKeyError';

  constructor(
    readonly code: AgentKeyErrorCode,
    message: string,
    options: { cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
  }
}

// Bound into every sealed agent secret. The account is in it as well as the
// tenant, so even inside one project a ciphertext moved to another key's row
// does not open.
export function agentSecretAssociatedData(
  context: ProjectContext,
  network: string,
  publicKey: string,
): string {
  return `ujira/agent-key/v1:${context.principalId}:${context.projectId}:${network}:${publicKey}`;
}

// Ids only, like every job payload, so the job table never holds a key.
export interface AgentKeyFundingPayload {
  readonly principalId: string;
  readonly projectId: string;
  readonly agentKeyId: string;
}

export interface AgentKeyFundingJob {
  readonly task: 'agent_key.fund';
  // Friendbot is not the agent's own sequence number, so no queue is needed.
  readonly queue: null;
  // A second enqueue for the same key collapses into the first.
  readonly jobKey: string;
  readonly payload: AgentKeyFundingPayload;
}

export function agentKeyFundingJob(
  context: ProjectContext,
  agentKeyId: string,
): AgentKeyFundingJob {
  return {
    task: 'agent_key.fund',
    queue: null,
    jobKey: `agent-key:${agentKeyId}:fund`,
    payload: { principalId: context.principalId, projectId: context.projectId, agentKeyId },
  };
}

export interface AgentKeyServiceOptions {
  readonly store: AgentKeyStore;
  readonly sealer: Sealer;
  readonly accounts: AgentAccounts;
  // Hands the funding retries to the job runner. Without one, funding is
  // tried once when the key is made and again on each provision call.
  readonly enqueueFunding?: (job: AgentKeyFundingJob) => Promise<void>;
  readonly fundingTimeoutMs?: number;
  readonly log?: (line: string) => void;
}

export interface AgentKeyService {
  // The project's active key on the adapter's network, made now if it has
  // none, with its account funded or the attempt recorded. Safe to repeat
  // and to race: a project never ends up with two active keys.
  provision(context: ProjectContext, correlationId: string): Promise<AgentKey>;
  active(context: ProjectContext): Promise<AgentKey | undefined>;
  // One funding attempt. A key that ran out of attempts is tried again only
  // when `retryFailed` is set, which is a person asking.
  fund(
    context: ProjectContext,
    agentKeyId: string,
    correlationId: string,
    options?: { readonly retryFailed?: boolean },
  ): Promise<AgentKey>;
  // The job handler. Throws FUNDING_PENDING while the account is still
  // unfunded and attempts remain, so the runner tries again with backoff.
  runFundingJob(payload: AgentKeyFundingPayload, correlationId: string): Promise<void>;
  // A signer for one of the project's keys, active or retired: mandates made
  // before a key was retired still name it.
  signer(context: ProjectContext, agentKeyId: string): Promise<TxSigner>;
  activeSigner(context: ProjectContext): Promise<TxSigner>;
}

const notFound = () => new AgentKeyError('KEY_NOT_FOUND', 'the project has no such agent key');

// Ids only: a public key is not secret, but nothing here needs it in a log.
function tenantFields(context: ProjectContext, keyId: string): string {
  return `principal=${context.principalId} project=${context.projectId} key=${keyId}`;
}

export function createAgentKeyService(o: AgentKeyServiceOptions): AgentKeyService {
  const log = o.log ?? (() => undefined);
  const network = o.accounts.network;
  const timeoutMs = o.fundingTimeoutMs ?? FUNDING_TIMEOUT_MS;

  function sealed(context: ProjectContext): NewAgentKey {
    const key = o.accounts.generate();
    try {
      const box = o.sealer.seal(
        key.secret,
        agentSecretAssociatedData(context, network, key.publicKey),
      );
      return {
        network,
        publicKey: key.publicKey,
        secretCiphertext: box.ciphertext,
        secretNonce: box.nonce,
      };
    } finally {
      key.secret.fill(0);
    }
  }

  async function fund(
    context: ProjectContext,
    agentKeyId: string,
    correlationId: string,
    retryFailed = false,
  ): Promise<AgentKey> {
    const key = await o.store.get(context, agentKeyId);
    if (key === undefined) throw notFound();
    if (key.funding.status === 'funded') return key;
    if (key.funding.status === 'failed' && !retryFailed) return key;

    let attempt: FundingAttempt;
    try {
      await o.accounts.fund(key.publicKey, callOptions(correlationId, timeoutMs));
      attempt = { kind: 'funded' };
    } catch (error) {
      // Only the chain's own failures are a failed attempt. Anything else is a
      // bug, and recording it as an outage would hide it.
      if (!(error instanceof ChainError)) throw error;
      const attempts = key.funding.attempts + 1;
      const final = key.funding.status === 'failed' || attempts >= MAX_FUNDING_ATTEMPTS;
      attempt = { kind: 'failed', error: error.code, final };
      log(
        `event=agent_key_funding_failed ${tenantFields(context, key.id)} code=${error.code} attempt=${String(attempts)} final=${String(final)} correlationId=${correlationId}`,
      );
      if (final && key.funding.status !== 'failed') {
        log(
          `event=agent_key_funding_dead_letter ${tenantFields(context, key.id)} correlationId=${correlationId}`,
        );
      }
    }
    // Undefined means a concurrent attempt funded it first, which is the
    // outcome either way; read what stands.
    const recorded =
      (await o.store.recordFunding(context, key.id, attempt)) ??
      (await o.store.get(context, key.id));
    if (recorded === undefined) throw notFound();
    if (attempt.kind === 'funded') {
      log(`event=agent_key_funded ${tenantFields(context, key.id)} correlationId=${correlationId}`);
    }
    return recorded;
  }

  async function signer(context: ProjectContext, agentKeyId: string): Promise<TxSigner> {
    const box = await o.store.sealedSecret(context, agentKeyId);
    if (box === undefined) throw notFound();
    let secret: Buffer;
    try {
      // The context, not the row, names the tenant here: a row that reached
      // this project by any route still has to have been sealed for it.
      secret = o.sealer.open(box, agentSecretAssociatedData(context, box.network, box.publicKey));
    } catch (error) {
      if (!(error instanceof SealError)) throw error;
      throw new AgentKeyError(
        'KEY_UNREADABLE',
        'the agent key does not open under this key encryption key',
        { cause: error },
      );
    }
    try {
      return o.accounts.signer(secret, box.publicKey);
    } finally {
      secret.fill(0);
    }
  }

  return {
    async provision(context, correlationId) {
      let key = await o.store.active(context, network);
      if (key === undefined) {
        const made = await o.store.create(context, sealed(context));
        if (made === undefined) {
          // Lost a race to a concurrent provision, whose key stands.
          key = await o.store.active(context, network);
          if (key === undefined) throw notFound();
        } else {
          key = made;
          log(
            `event=agent_key_created ${tenantFields(context, key.id)} network=${network} correlationId=${correlationId}`,
          );
          // Before the first attempt, so a crash during it still leaves the
          // retries queued.
          await o.enqueueFunding?.(agentKeyFundingJob(context, key.id));
        }
      }
      return key.funding.status === 'pending' ? fund(context, key.id, correlationId) : key;
    },

    active: (context) => o.store.active(context, network),

    fund: (context, agentKeyId, correlationId, options = {}) =>
      fund(context, agentKeyId, correlationId, options.retryFailed ?? false),

    async runFundingJob(payload, correlationId) {
      const context = { principalId: payload.principalId, projectId: payload.projectId };
      let key: AgentKey;
      try {
        key = await fund(context, payload.agentKeyId, correlationId);
      } catch (error) {
        // A key that is not there will not appear by retrying.
        if (error instanceof AgentKeyError && error.code === 'KEY_NOT_FOUND') {
          log(
            `event=agent_key_funding_skipped ${tenantFields(context, payload.agentKeyId)} reason=not_found correlationId=${correlationId}`,
          );
          return;
        }
        throw error;
      }
      if (key.funding.status === 'pending') {
        throw new AgentKeyError('FUNDING_PENDING', 'the agent account is not funded yet');
      }
    },

    signer,

    async activeSigner(context) {
      const key = await o.store.active(context, network);
      if (key === undefined) throw notFound();
      return signer(context, key.id);
    },
  };
}
