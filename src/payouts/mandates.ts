// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// Mandates for a signed in member: prepare one for their wallet to sign,
// attach one they already own, read them, and turn an action into a signing
// request. Then relay what the wallet signed, once, and only if it is exactly
// what was prepared.
//
// The chain is the source of every rule and every amount. Rows here hold only
// what the chain cannot: which project a contract belongs to, its name and the
// key that drives it. UJIRA never holds the principal's funds or key: the
// server shapes the call, the wallet signs it, the chain enforces it.

import {
  callOptions,
  ChainError,
  type ChainAdapter,
  type Limits,
  type MandateAction,
  type MandateConfigView,
  type MandateStateView,
  type NetworkId,
  type SigningRequest,
  type SubmitResult,
  type CallOptions,
} from '../chain/adapter.js';
import { RECIPIENT_MODE } from '../chain/types.js';
import type { Mandate, NewMandate, ProjectContext, StoredSigningRequest } from '../db/index.js';
import { MandateTakenError, type MandateStore, type RecipientWallet } from './mandate-store.js';

/** The longest a submit waits for the chain: a send, then the ledger, inside the HTTP deadline. */
export const SUBMIT_TIMEOUT_MS = 100_000;

/** The chain allows recipients in batches of this size. */
export const MAX_ALLOW_RECIPIENTS = 10;

/** How many recipients a mandate's detail lists. */
export const DETAIL_RECIPIENTS = 100;

/** How many mandates of one page are read from the chain at a time. */
const READ_CONCURRENCY = 4;

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/**
 * Who is asking, in one project. A signed in member has a wallet; an API key
 * has none, so it can read mandates but never prepare anything to sign.
 */
export interface MandateCaller extends ProjectContext {
  readonly wallet: string | null;
}

/** The token a project's mandates hold, as the chain and the database name it. */
export interface MandateUnit {
  /** The code on the wire and in the database, such as USDC. */
  readonly code: string;
  readonly scale: number;
  /** The token contract a mandate must hold to be one of ours. */
  readonly contract: string;
}

export type MandateErrorCode =
  | 'INVALID_REQUEST'
  | 'NOT_FOUND'
  | 'FORBIDDEN'
  | 'AGENT_KEY_MISSING'
  | 'MANDATE_TAKEN'
  | 'MANDATE_PRINCIPAL_MISMATCH'
  | 'MANDATE_AGENT_MISMATCH'
  | 'RECIPIENT_MODE_UNSUPPORTED'
  | 'SIGNING_REQUEST_USED'
  | 'SIGNING_REQUEST_EXPIRED'
  | 'CHAIN_UNAVAILABLE';

/** A refusal with a fixed message; `details` name where, never what was sent. */
export class MandateServiceError extends Error {
  readonly code: MandateErrorCode;
  readonly details: readonly { readonly path: string; readonly issue: string }[];

  constructor(
    code: MandateErrorCode,
    message: string,
    details: readonly { readonly path: string; readonly issue: string }[] = [],
  ) {
    super(message);
    this.name = 'MandateServiceError';
    this.code = code;
    this.details = details;
  }
}

const invalid = (path: string, issue: string, message = 'The request is not valid') =>
  new MandateServiceError('INVALID_REQUEST', message, [{ path, issue }]);

export type RecipientMode = 'allowlist' | 'attested' | 'both';

export interface PrepareInput {
  readonly name: string | null;
  readonly approvers: readonly string[];
  readonly approvalsRequired: number;
  readonly limits: {
    readonly totalBudget: bigint;
    readonly perPaymentCap: bigint;
    readonly perRecipientDailyCap: bigint;
    readonly approvalThreshold: bigint;
    readonly payoutTtlSeconds: number;
    readonly expiresAt: Date;
  };
  readonly recipientMode: RecipientMode;
}

export type ActionInput =
  | { readonly kind: 'fund'; readonly amount: bigint }
  | { readonly kind: 'withdraw'; readonly amount: bigint }
  | { readonly kind: 'allow_recipients'; readonly recipientIds: readonly string[] }
  | { readonly kind: 'pause' }
  | { readonly kind: 'resume' }
  | { readonly kind: 'revoke' }
  | { readonly kind: 'approve'; readonly payoutId: string }
  | { readonly kind: 'reject'; readonly payoutId: string };

export interface TokenAmountView {
  readonly amount: string;
  readonly asset: string;
  readonly network: string;
  readonly scale: number;
}

export interface MandateView {
  readonly id: string;
  readonly name: string;
  readonly contractId: string;
  readonly network: string;
  readonly asset: string;
  readonly status: 'active' | 'paused' | 'revoked' | 'expired';
  readonly depositAddress: string;
  readonly createdAt: string;
  readonly config: {
    readonly principal: string;
    readonly agents: string[];
    readonly approvers: string[];
    readonly approvalsRequired: number;
    readonly executors: string[];
    readonly recipientMode: RecipientMode | 'unknown';
    readonly limits: {
      readonly totalBudget: TokenAmountView;
      readonly perPaymentCap: TokenAmountView;
      readonly perRecipientDailyCap: TokenAmountView;
      readonly approvalThreshold: TokenAmountView;
      readonly payoutTtlSeconds: number;
      readonly expiresAt: string;
    };
  };
  readonly state: {
    readonly balance: TokenAmountView;
    readonly committed: TokenAmountView;
    readonly spent: TokenAmountView;
    readonly pending: TokenAmountView;
    readonly free: TokenAmountView;
    readonly paused: boolean;
    readonly revoked: boolean;
    readonly expired: boolean;
  };
}

export interface RecipientView {
  readonly id: string;
  readonly label: string;
  /** Masked, so a list never shows a whole wallet; null until it has one. */
  readonly address: string | null;
  readonly status: string;
}

export interface MandateDetail extends MandateView {
  readonly recipients: RecipientView[];
}

export interface SigningRequestView extends SigningRequest {
  readonly id: string;
}

export interface SubmitAnswer {
  readonly txHash: string;
  /** The mandate the transaction was for; for a create, the one it made. */
  readonly mandateId: string | null;
}

/**
 * Sends a signed envelope the adapter has checked against its request. The
 * fee sponsor wraps this to pay the network fee and hold each principal to a
 * daily cap; without one the signer pays its own fee.
 */
export type Relay = (
  signedXdr: string,
  expected: SigningRequest,
  caller: MandateCaller,
  o: CallOptions,
) => Promise<SubmitResult>;

/** The part of the agent key service a mandate needs. */
export interface AgentKeyProvisioner {
  provision(
    context: ProjectContext,
    correlationId: string,
  ): Promise<{ readonly id: string; readonly publicKey: string }>;
}

export interface MandateServiceOptions {
  readonly adapter: ChainAdapter;
  readonly store: MandateStore;
  /** The UJIRA executor every mandate names. */
  readonly executor: string;
  readonly unit: MandateUnit;
  readonly relay?: Relay;
  /**
   * Makes the project's own agent key if it has none yet, so a new mandate
   * always names it. Without it only a key the project already has is named.
   */
  readonly agentKeys?: AgentKeyProvisioner;
  readonly now?: () => Date;
}

const MODE_NAMES: Readonly<Record<number, RecipientMode>> = {
  [RECIPIENT_MODE.allowlist]: 'allowlist',
  [RECIPIENT_MODE.attested]: 'attested',
  [RECIPIENT_MODE.both]: 'both',
};

/** A name for a mandate nobody named, the one the console shows too. */
export function defaultMandateName(contract: string): string {
  return `Mandate ${contract.slice(-4)}`;
}

/** The first and last characters of an address, enough to tell two apart. */
export function maskAddress(address: string): string {
  return address.length <= 12 ? address : `${address.slice(0, 4)}...${address.slice(-4)}`;
}

function isoFromUnixSeconds(seconds: bigint): string {
  const ms = seconds * 1000n;
  // Beyond what a Date can hold the chain value is not one a person set.
  if (ms > 8_640_000_000_000_000n) return new Date(8_640_000_000_000_000).toISOString();
  return new Date(Number.parseInt(ms.toString(), 10)).toISOString();
}

function wholeSeconds(value: bigint): number {
  const max = BigInt(Number.MAX_SAFE_INTEGER);
  return Number.parseInt((value > max ? max : value).toString(), 10);
}

async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next;
      next += 1;
      // The index was read from the list just above.
      out[i] = await work(items[i] as T);
    }
  });
  await Promise.all(lanes);
  return out;
}

export class MandateService {
  private readonly o: MandateServiceOptions;
  private readonly now: () => Date;
  private readonly relay: Relay;

  constructor(options: MandateServiceOptions) {
    this.o = options;
    this.now = options.now ?? (() => new Date());
    this.relay =
      options.relay ??
      ((signed, expected, _caller, o) => options.adapter.submitSigned(signed, expected, o));
  }

  get network(): NetworkId {
    return this.o.adapter.network;
  }

  get unit(): MandateUnit {
    return this.o.unit;
  }

  /** The member's wallet as the chain spells it; the route has already checked the role. */
  private writer(caller: MandateCaller): string {
    if (caller.wallet === null) {
      throw new MandateServiceError(
        'FORBIDDEN',
        'This takes a dashboard session, signed in with a wallet',
      );
    }
    return this.account(caller.wallet, 'wallet');
  }

  private account(raw: string, path: string): string {
    try {
      return this.o.adapter.parseAccount(raw);
    } catch (error) {
      if (error instanceof ChainError) throw invalid(path, 'invalid_address');
      throw error;
    }
  }

  private token(amount: bigint): TokenAmountView {
    return {
      amount: amount.toString(),
      asset: this.o.unit.code,
      network: this.network,
      scale: this.o.unit.scale,
    };
  }

  private view(m: Mandate, config: MandateConfigView, state: MandateStateView): MandateView {
    const status = state.revoked
      ? 'revoked'
      : state.expired
        ? 'expired'
        : state.paused
          ? 'paused'
          : 'active';
    const l = config.limits;
    return {
      id: m.id,
      name: m.name,
      contractId: m.contractAddress,
      network: m.network,
      asset: m.asset,
      status,
      // Funding is a token transfer to the contract itself.
      depositAddress: m.contractAddress,
      createdAt: m.createdAt.toISOString(),
      config: {
        principal: config.principal,
        agents: [...config.agents],
        approvers: [...config.approvers],
        approvalsRequired: config.approvalsRequired,
        executors: [...config.executors],
        recipientMode: MODE_NAMES[config.recipientMode] ?? 'unknown',
        limits: {
          totalBudget: this.token(l.totalBudget),
          perPaymentCap: this.token(l.perPaymentCap),
          perRecipientDailyCap: this.token(l.perRecipientDailyCap),
          approvalThreshold: this.token(l.approvalThreshold),
          payoutTtlSeconds: wholeSeconds(l.payoutTtlSeconds),
          expiresAt: isoFromUnixSeconds(l.expiresAt),
        },
      },
      state: {
        balance: this.token(state.balance),
        committed: this.token(state.committed),
        spent: this.token(state.spent),
        pending: this.token(state.pending),
        free: this.token(state.free),
        paused: state.paused,
        revoked: state.revoked,
        expired: state.expired,
      },
    };
  }

  private requestView(stored: StoredSigningRequest, req: SigningRequest): SigningRequestView {
    return { id: stored.id, ...req };
  }

  private async read(contract: string, correlationId: string) {
    return this.o.adapter.readMandate(contract, callOptions(correlationId));
  }

  private async agentKey(caller: MandateCaller, requestId: string) {
    const tenant = { principalId: caller.principalId, projectId: caller.projectId };
    const key =
      this.o.agentKeys === undefined
        ? await this.o.store.activeAgentKey(tenant, this.network)
        : await this.o.agentKeys.provision(tenant, requestId);
    if (key === undefined) {
      throw new MandateServiceError(
        'AGENT_KEY_MISSING',
        'This project has no agent key on this network yet',
      );
    }
    return key;
  }

  private checkLimits(l: PrepareInput['limits']): Limits {
    const now = this.now().getTime();
    if (l.totalBudget <= 0n) throw invalid('body.limits.totalBudget', 'not_positive');
    if (l.perPaymentCap <= 0n) throw invalid('body.limits.perPaymentCap', 'not_positive');
    if (l.perPaymentCap > l.totalBudget) {
      throw invalid('body.limits.perPaymentCap', 'above_total_budget');
    }
    if (l.perRecipientDailyCap <= 0n) {
      throw invalid('body.limits.perRecipientDailyCap', 'not_positive');
    }
    if (l.approvalThreshold < 0n) throw invalid('body.limits.approvalThreshold', 'negative');
    const expires = l.expiresAt.getTime();
    if (expires < now + HOUR_MS) throw invalid('body.limits.expiresAt', 'too_soon');
    if (expires > now + 366 * DAY_MS) throw invalid('body.limits.expiresAt', 'too_late');
    return {
      totalBudget: l.totalBudget,
      perPaymentCap: l.perPaymentCap,
      perRecipientDailyCap: l.perRecipientDailyCap,
      approvalThreshold: l.approvalThreshold,
      payoutTtlSeconds: BigInt(l.payoutTtlSeconds),
      expiresAt: BigInt(Math.floor(expires / 1000)),
    };
  }

  /**
   * The mandate's own recipients among `ids`. A recipient belongs to one
   * mandate, so one of another mandate is refused as if it did not exist.
   */
  private async recipientsOf(
    caller: MandateCaller,
    mandateId: string,
    ids: readonly string[],
    path: string,
  ): Promise<RecipientWallet[]> {
    const unique = [...new Set(ids)];
    const found = await this.o.store.recipients(caller, unique);
    const byId = new Map(found.map((r) => [r.id, r]));
    return unique.map((id, i) => {
      const r = byId.get(id);
      if (r?.mandateId !== mandateId) throw invalid(`${path}.${String(i)}`, 'not_found');
      return r;
    });
  }

  /** The factory call for a new mandate, naming the project's agent key and the UJIRA executor. */
  async prepare(
    caller: MandateCaller,
    input: PrepareInput,
    requestId: string,
  ): Promise<SigningRequestView> {
    const principal = this.writer(caller);
    if (input.recipientMode !== 'allowlist') {
      // UJIRA holds the agent key, so a mandate that trusts attestations alone
      // would let UJIRA vouch for its own payouts.
      throw new MandateServiceError(
        'RECIPIENT_MODE_UNSUPPORTED',
        'Mandates on UJIRA pay only recipients on their allowlist',
      );
    }
    // The owner's own wallet approves when no one else is named.
    const named = input.approvers.length === 0 ? [principal] : input.approvers;
    const approvers = named.map((a, i) => this.account(a, `body.approvers.${String(i)}`));
    if (new Set(approvers).size !== approvers.length) throw invalid('body.approvers', 'duplicate');
    if (input.approvalsRequired < 1 || input.approvalsRequired > approvers.length) {
      throw invalid('body.approvalsRequired', 'out_of_range');
    }
    const limits = this.checkLimits(input.limits);
    const key = await this.agentKey(caller, requestId);
    if (principal === key.publicKey || principal === this.o.executor) {
      throw invalid('wallet', 'role_conflict', "The owner wallet cannot be UJIRA's own key");
    }
    const req = await this.o.adapter.prepareMandateAction(
      null,
      {
        kind: 'create',
        principal,
        agent: key.publicKey,
        executor: this.o.executor,
        approvers,
        approvalsRequired: input.approvalsRequired,
        limits,
        recipients: [],
      },
      callOptions(requestId),
    );
    const stored = await this.o.store.createSigningRequest(caller, {
      mandateId: null,
      action: 'create',
      network: req.network,
      signer: req.signer,
      envelope: req.xdr,
      summary: req.summary,
      expiresAt: new Date(req.expiresAt),
      mandateName: input.name,
      agentKeyId: key.id,
    });
    return this.requestView(stored, req);
  }

  /** Attaches a contract the member's wallet owns and the project's key drives. */
  async importMandate(
    caller: MandateCaller,
    input: { readonly contractId: string; readonly name: string | null },
    requestId: string,
  ): Promise<{ readonly mandate: MandateDetail; readonly created: boolean }> {
    const wallet = this.writer(caller);
    const contract = input.contractId.trim();
    let read: { config: MandateConfigView; state: MandateStateView };
    try {
      read = await this.read(contract, requestId);
    } catch (error) {
      if (error instanceof ChainError && error.code === 'INVALID_ADDRESS') {
        throw invalid('body.contractId', 'invalid_address');
      }
      throw error;
    }
    const { config, state } = read;
    if (config.principal !== wallet) {
      throw new MandateServiceError(
        'MANDATE_PRINCIPAL_MISMATCH',
        'That mandate is not owned by your wallet',
      );
    }
    if (config.recipientMode === RECIPIENT_MODE.attested) {
      throw new MandateServiceError(
        'RECIPIENT_MODE_UNSUPPORTED',
        'Mandates on UJIRA pay only recipients on their allowlist',
      );
    }
    if (config.asset !== this.o.unit.contract) {
      throw invalid('body.contractId', 'unsupported_asset');
    }
    const key = await this.agentKey(caller, requestId);
    if (!config.agents.includes(key.publicKey) || !config.executors.includes(this.o.executor)) {
      throw new MandateServiceError(
        'MANDATE_AGENT_MISMATCH',
        "That mandate does not name this project's agent key and the UJIRA executor",
      );
    }
    let added: { mandate: Mandate; created: boolean };
    try {
      added = await this.o.store.addMandate(caller, {
        name: input.name ?? defaultMandateName(contract),
        network: this.network,
        contractAddress: contract,
        asset: this.o.unit.code,
        scale: this.o.unit.scale,
        agent: { keyId: key.id },
        principalWallet: config.principal,
      });
    } catch (error) {
      if (error instanceof MandateTakenError) {
        throw new MandateServiceError('MANDATE_TAKEN', 'That mandate is in another project');
      }
      throw error;
    }
    return {
      mandate: await this.detailOf(caller, added.mandate, config, state),
      created: added.created,
    };
  }

  async list(
    caller: MandateCaller,
    page: { readonly limit: number; readonly after?: string },
    requestId: string,
  ): Promise<{ readonly items: MandateView[]; readonly next: string | null }> {
    const rows = await this.o.store.mandates(caller, page);
    const items = await mapLimit(rows.items, READ_CONCURRENCY, async (m) => {
      const { config, state } = await this.read(m.contractAddress, requestId);
      return this.view(m, config, state);
    });
    return { items, next: rows.next };
  }

  private async detailOf(
    caller: MandateCaller,
    m: Mandate,
    config: MandateConfigView,
    state: MandateStateView,
  ): Promise<MandateDetail> {
    const people = await this.o.store.mandateRecipients(caller, m.id, DETAIL_RECIPIENTS);
    return {
      ...this.view(m, config, state),
      recipients: people.map((r) => ({
        id: r.id,
        label: r.label,
        address: r.destination === null ? null : maskAddress(r.destination),
        status: r.status,
      })),
    };
  }

  async detail(caller: MandateCaller, id: string, requestId: string): Promise<MandateDetail> {
    const m = await this.mandateOf(caller, id);
    const { config, state } = await this.read(m.contractAddress, requestId);
    return this.detailOf(caller, m, config, state);
  }

  private async mandateOf(caller: MandateCaller, id: string): Promise<Mandate> {
    const m = await this.o.store.mandate(caller, id);
    if (m === undefined) throw new MandateServiceError('NOT_FOUND', 'No such mandate');
    return m;
  }

  /** One action on a mandate, as a transaction for the right wallet to sign. */
  async action(
    caller: MandateCaller,
    id: string,
    input: ActionInput,
    requestId: string,
  ): Promise<SigningRequestView> {
    const wallet = this.writer(caller);
    const m = await this.mandateOf(caller, id);
    const approving = input.kind === 'approve' || input.kind === 'reject';
    if (approving) {
      // Approving is the approver's own wallet signing; one the chain does not
      // name would sign something the contract refuses, so nothing is prepared.
      const { config } = await this.read(m.contractAddress, requestId);
      if (!config.approvers.includes(wallet)) {
        throw new MandateServiceError(
          'FORBIDDEN',
          'Only an approver this mandate names can do that',
        );
      }
    } else if (wallet !== m.principalWallet) {
      throw new MandateServiceError(
        'FORBIDDEN',
        'Only the wallet that owns this mandate can sign that',
      );
    }
    let action: MandateAction;
    switch (input.kind) {
      case 'approve':
      case 'reject': {
        const payout = await this.o.store.payout(caller, input.payoutId);
        if (payout?.mandateId !== m.id) {
          throw new MandateServiceError('NOT_FOUND', 'No such payout on this mandate');
        }
        action = { kind: input.kind, approver: wallet, payoutId: payout.onchainPayoutId };
        break;
      }
      case 'fund':
        action = { kind: 'fund', from: wallet, amount: input.amount };
        break;
      case 'withdraw':
        action = { kind: 'withdraw', amount: input.amount };
        break;
      case 'allow_recipients': {
        const picked = await this.recipientsOf(
          caller,
          m.id,
          input.recipientIds,
          'body.recipientIds',
        );
        const entries = picked.map((r, i) => {
          if (r.destination === null) {
            throw invalid(`body.recipientIds.${String(i)}`, 'no_wallet');
          }
          return { recipientRef: r.recipientRef, destination: r.destination };
        });
        if (entries.length > MAX_ALLOW_RECIPIENTS) throw invalid('body.recipientIds', 'too_many');
        action = { kind: 'allow_recipients', entries };
        break;
      }
      case 'pause':
      case 'resume':
      case 'revoke':
        action = { kind: input.kind };
        break;
    }
    const req = await this.o.adapter.prepareMandateAction(
      m.contractAddress,
      action,
      callOptions(requestId),
    );
    const stored = await this.o.store.createSigningRequest(caller, {
      mandateId: m.id,
      action: input.kind,
      network: req.network,
      signer: req.signer,
      envelope: req.xdr,
      summary: req.summary,
      expiresAt: new Date(req.expiresAt),
    });
    return this.requestView(stored, req);
  }

  /**
   * Relays what the wallet signed and answers once the chain has it. A
   * request is used up by the first transaction the chain takes for it,
   * whether that transaction succeeded or failed on chain.
   */
  async submit(
    caller: MandateCaller,
    input: { readonly signingRequestId: string; readonly xdr: string },
    requestId: string,
  ): Promise<SubmitAnswer> {
    this.writer(caller);
    const stored = await this.o.store.signingRequest(caller, input.signingRequestId);
    if (stored === undefined) throw new MandateServiceError('NOT_FOUND', 'No such signing request');
    if (stored.submittedTxHash !== null) {
      throw new MandateServiceError(
        'SIGNING_REQUEST_USED',
        'That signing request was already submitted',
      );
    }
    if (stored.expiresAt.getTime() <= this.now().getTime()) {
      throw new MandateServiceError(
        'SIGNING_REQUEST_EXPIRED',
        'That signing request ran out of time; prepare it again',
      );
    }
    const expected: SigningRequest = {
      // A row for another network is refused by the adapter as a mismatch.
      network: stored.network as NetworkId,
      xdr: stored.envelope,
      signer: stored.signer,
      action: stored.action,
      summary: stored.summary,
      expiresAt: stored.expiresAt.toISOString(),
    };
    let sent: SubmitResult;
    try {
      sent = await this.relay(
        input.xdr,
        expected,
        caller,
        callOptions(requestId, SUBMIT_TIMEOUT_MS),
      );
    } catch (error) {
      // A transaction that failed on chain used up its sequence number, so the
      // request can never be submitted again; record which one it was.
      if (
        error instanceof ChainError &&
        (error.code === 'CONTRACT_REFUSED' || error.code === 'TX_FAILED') &&
        error.txHash !== undefined
      ) {
        await this.o.store.markSubmitted(caller, stored.id, error.txHash);
      }
      throw error;
    }
    if (stored.action !== 'create') {
      await this.o.store.markSubmitted(caller, stored.id, sent.txHash);
      return { txHash: sent.txHash, mandateId: stored.mandateId };
    }
    return this.created(caller, stored, sent, requestId);
  }

  private async created(
    caller: MandateCaller,
    stored: StoredSigningRequest,
    sent: SubmitResult,
    requestId: string,
  ): Promise<SubmitAnswer> {
    const contract = sent.contract;
    if (contract === undefined || stored.agentKeyId === null) {
      await this.o.store.markSubmitted(caller, stored.id, sent.txHash);
      throw new MandateServiceError(
        'CHAIN_UNAVAILABLE',
        'The mandate was created but the network did not say where; import it to finish',
      );
    }
    // Read back before it is stored, so the row holds the address the chain
    // answers to and a contract that exists.
    try {
      await this.read(contract, requestId);
    } catch (error) {
      if (!(error instanceof ChainError)) throw error;
      await this.o.store.markSubmitted(caller, stored.id, sent.txHash);
      // The address comes from the chain, not the caller, and is what they need to import it.
      throw new MandateServiceError(
        'CHAIN_UNAVAILABLE',
        `The mandate was created at ${contract} but could not be read back; import it to finish`,
      );
    }
    const row: NewMandate = {
      name: stored.mandateName ?? defaultMandateName(contract),
      network: stored.network,
      contractAddress: contract,
      asset: this.o.unit.code,
      scale: this.o.unit.scale,
      agent: { keyId: stored.agentKeyId },
      principalWallet: stored.signer,
      createdTxHash: sent.txHash,
    };
    let m: Mandate;
    try {
      m = await this.o.store.recordCreated(caller, stored.id, sent.txHash, row);
    } catch (error) {
      if (error instanceof MandateTakenError) {
        throw new MandateServiceError('MANDATE_TAKEN', 'That mandate is in another project');
      }
      throw error;
    }
    return { txHash: sent.txHash, mandateId: m.id };
  }
}
