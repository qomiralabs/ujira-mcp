// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The ChainAdapter for Stellar and Soroban. It is built on two ports, the
// SorobanGateway for contract calls and the StellarNetworkPort for whole
// transactions and accounts, so tests run it against memory.
//
// Checks that need no network (addresses, the shape of an envelope, its
// signature) run before the call's deadline starts and throw at once.
// Everything that waits on the network runs inside withDeadline.

import {
  BASE_FEE,
  FeeBumpTransaction,
  Keypair,
  Networks,
  TransactionBuilder,
  type Transaction,
  type xdr,
} from '@stellar/stellar-sdk';

import { WALLET_MESSAGE_VERSION, formatWalletMessage } from '../../auth/wallet-message.js';
import { ContractRefusedError, EngineError, mandateErrorName } from '../../errors.js';
import { formatUnits } from '../../money.js';
import {
  CHAIN_ADAPTER_VERSION,
  ChainError,
  withDeadline,
  type CallOptions,
  type ChainAdapter,
  type ChainPayoutState,
  type CheckResult,
  type FeeBudget,
  type Hex32,
  type MandateAction,
  type NetworkId,
  type PayoutIntent,
  type RequestedState,
  type SendHooks,
  type SigningRequest,
  type SponsoredFee,
  type SubmitResult,
} from '../adapter.js';
import {
  PAYOUT_STATUS,
  type MandateConfigView,
  type MandateStateView,
  type PayoutRequest,
  type TxSigner,
} from '../types.js';
import { isAccountAddress, isContractAddress } from './addresses.js';
import { address, bytes32, encodeAllowEntries, i128, nativeOf } from './codec.js';
import type { SorobanGateway } from './gateway.js';
import { MandateClient } from './mandate-client.js';
import type { StellarNetworkPort, Submitted } from './network.js';
import {
  MAX_ALLOW_ENTRIES,
  SIGN_WINDOW_SECONDS,
  factoryConfig,
  invokeTx,
  newSalt,
} from './txbuild.js';
import { receiptRef, verifyWalletProof } from './wallet-proof.js';

const PASSPHRASES: Record<NetworkId, string> = {
  'stellar:testnet': Networks.TESTNET,
  'stellar:pubnet': Networks.PUBLIC,
};

const HEX32 = /^[0-9a-f]{64}$/;
const ASSET_CODE = /^[A-Za-z0-9]{1,12}$/;

/** What request_payout returns, by the contract's status number. */
const REQUESTED_STATES: ReadonlyMap<number, RequestedState> = new Map([
  [PAYOUT_STATUS.pending, 'pending'],
  [PAYOUT_STATUS.approved, 'approved'],
]);

export interface StellarAdapterOptions {
  readonly network?: NetworkId;
  readonly gateway: SorobanGateway;
  readonly chain: StellarNetworkPort;
  /** The mandate factory every new mandate is created through. */
  readonly factory: string;
  /** The one asset mandates hold, as its classic code and issuer and its contract. */
  readonly asset: { readonly code: string; readonly issuer: string; readonly contract: string };
  /**
   * Pays the fee of every envelope principals sign, so a principal never needs
   * XLM. Without it a principal pays its own fee and sponsorFee is unavailable.
   */
  readonly feeSponsor?: TxSigner;
  /** Milliseconds since the epoch; the server clock unless a test sets one. */
  readonly now?: () => number;
}

/** The mandate spec's name for a contract error code, such as DAILY_CAP_EXCEEDED. */
export function specErrorOf(contractCode: number): string {
  return mandateErrorName(contractCode).toUpperCase();
}

/** Any failure below the adapter as the one error it throws. */
export function toChainError(error: unknown, what: string): ChainError {
  if (error instanceof ChainError) return error;
  if (error instanceof ContractRefusedError) {
    return new ChainError('CONTRACT_REFUSED', error.message, {
      specError: specErrorOf(error.contractCode),
      reason: error.reason,
      ...(error.txHash === undefined ? {} : { txHash: error.txHash }),
      cause: error,
    });
  }
  if (error instanceof EngineError) {
    switch (error.code) {
      // A send whose answer was lost is as unknown as one that timed out:
      // the caller must look the transaction up before trying again.
      case 'rpc_timeout':
      case 'submission_unknown':
        return new ChainError('TIMEOUT', error.message, { reason: error.code, cause: error });
      case 'tx_failed':
        return new ChainError('TX_FAILED', error.message, { reason: error.code, cause: error });
      default:
        return new ChainError('UNAVAILABLE', error.message, { reason: error.code, cause: error });
    }
  }
  return new ChainError('UNAVAILABLE', `${what} failed`, { cause: error });
}

const mismatch = (why: string, reason?: string) =>
  new ChainError(
    'SIGNING_REQUEST_MISMATCH',
    `The signed transaction was refused: ${why}`,
    reason === undefined ? {} : { reason },
  );

/** One plain transaction envelope for this network; anything else is refused. */
function envelope(text: string, passphrase: string): Transaction {
  let tx: Transaction | FeeBumpTransaction;
  try {
    tx = TransactionBuilder.fromXdr(text, passphrase);
  } catch {
    throw mismatch('it cannot be read as a transaction envelope', 'invalid_xdr');
  }
  if (tx instanceof FeeBumpTransaction) throw mismatch('a fee bump envelope is not accepted');
  return tx;
}

/** The resource fee a Soroban transaction carries; a fee bump passes it on as it is. */
function resourceFeeOf(tx: Transaction): bigint {
  const env = tx.toEnvelope();
  if (env.type !== 'envelopeTypeTx') return 0n;
  const ext = env.value.tx.ext;
  return ext.type === 'sorobanData' ? ext.sorobanData.resourceFee : 0n;
}

/**
 * The network refused it before applying it, so no fee was taken. Anything
 * else, a timeout above all, may have landed and been paid for.
 */
function neverApplied(error: unknown): boolean {
  return (
    error instanceof ChainError && error.code === 'TX_FAILED' && error.reason === 'tx_rejected'
  );
}

function hex32Of(value: string, field: string): Hex32 {
  if (!HEX32.test(value)) throw new RangeError(`${field} must be 64 lower case hex digits`);
  return value;
}

/** The largest i128, the contract's amount type. */
const I128_MAX = (1n << 127n) - 1n;

function positive(amount: bigint, field: string): bigint {
  if (amount <= 0n || amount > I128_MAX) {
    throw new RangeError(`${field} must be a positive number of minor units within i128`);
  }
  return amount;
}

/** How an action becomes one contract call, before the principal is known. */
interface Plan {
  readonly target: string;
  readonly method: string;
  /** The account that signs; absent for the principal, whom only the chain can name. */
  readonly signer?: string;
  readonly args: (signer: string) => xdr.ScVal[];
  readonly summary: (signer: string) => string;
}

export class StellarChainAdapter implements ChainAdapter {
  readonly version = CHAIN_ADAPTER_VERSION;
  readonly network: NetworkId;
  readonly passphrase: string;
  private readonly o: StellarAdapterOptions;
  private readonly now: () => number;

  constructor(options: StellarAdapterOptions) {
    this.o = options;
    this.network = options.network ?? 'stellar:testnet';
    this.passphrase = PASSPHRASES[this.network];
    this.now = options.now ?? Date.now;
  }

  /**
   * One mandate as the single mandate engine and the console use it. Each
   * gateway call there is bounded by the gateway's own timeout.
   */
  mandate(contract: string): MandateClient {
    return new MandateClient(this.o.gateway, contract);
  }

  parseAccount(raw: string): string {
    const value = raw.trim();
    if (!isAccountAddress(value)) {
      throw new ChainError(
        'INVALID_ADDRESS',
        'The address is not a Stellar account address (G...)',
      );
    }
    return value;
  }

  private parseContract(raw: string): string {
    const value = raw.trim();
    if (!isContractAddress(value)) {
      throw new ChainError(
        'INVALID_ADDRESS',
        'The address is not a Stellar contract address (C...)',
      );
    }
    return value;
  }

  async health(o: CallOptions): Promise<{ ok: boolean; latestLedger: number }> {
    return withDeadline(
      o,
      'the health check',
      async () => {
        try {
          return { ok: true, latestLedger: await this.o.chain.latestLedger() };
        } catch {
          // An RPC that answers with an error is an unhealthy chain, not a failed check.
          return { ok: false, latestLedger: 0 };
        }
      },
      (e) => toChainError(e, 'the health check'),
    );
  }

  async readMandate(
    contract: string,
    o: CallOptions,
  ): Promise<{ config: MandateConfigView; state: MandateStateView }> {
    const m = this.mandate(this.parseContract(contract));
    return withDeadline(
      o,
      'read the mandate',
      async () => {
        const [config, state] = await Promise.all([m.config(), m.state()]);
        return { config, state };
      },
      (e) => toChainError(e, 'read the mandate'),
    );
  }

  private usdc(amount: bigint): string {
    return `${formatUnits(amount)} ${this.o.asset.code}`;
  }

  private plan(contract: string | null, action: MandateAction): Plan {
    if (action.kind === 'create') {
      if (contract !== null) {
        throw new ChainError('INVALID_ADDRESS', 'A new mandate has no address yet; pass null');
      }
      if (action.recipients.length > 0) {
        throw new RangeError(
          'recipients are allowed after the mandate exists, with allow_recipients',
        );
      }
      const n = action.approvalsRequired;
      if (!Number.isInteger(n) || n < 0 || n > 0xffff_ffff) {
        throw new RangeError('approvalsRequired must be a whole number');
      }
      const principal = this.parseAccount(action.principal);
      const agent = this.parseAccount(action.agent);
      const executor = this.parseAccount(action.executor);
      const approvers = action.approvers.map((a) => this.parseAccount(a));
      const l = action.limits;
      const config = factoryConfig({
        principal,
        asset: this.o.asset.contract,
        agents: [agent],
        approvers,
        approvalsRequired: n,
        executors: [executor],
        limits: l,
        // The take rate is zero for now; the fee leg arrives with the fee terms.
        maxFeeBps: 0,
      });
      const salt = bytes32(newSalt());
      const expires = new Date(Number(l.expiresAt) * 1000).toISOString().slice(0, 10);
      return {
        target: this.o.factory,
        method: 'create',
        signer: principal,
        args: () => [config, salt],
        summary: () =>
          `Create a mandate you own: total budget ${this.usdc(l.totalBudget)}, at most ` +
          `${this.usdc(l.perPaymentCap)} per payment and ${this.usdc(l.perRecipientDailyCap)} per ` +
          `recipient per day, payments from ${this.usdc(l.approvalThreshold)} wait for approval, ` +
          `valid until ${expires}. The agent key ${agent} may request payouts only within these rules.`,
      };
    }
    if (contract === null) {
      throw new ChainError('INVALID_ADDRESS', `${action.kind} needs the mandate's address`);
    }
    const mandate = this.parseContract(contract);
    switch (action.kind) {
      case 'fund': {
        const from = this.parseAccount(action.from);
        const amount = positive(action.amount, 'amount');
        return {
          target: this.o.asset.contract,
          method: 'transfer',
          signer: from,
          args: () => [address(from), address(mandate), i128(amount)],
          summary: () => `Send ${this.usdc(amount)} from your wallet to mandate ${mandate}`,
        };
      }
      case 'allow_recipients': {
        if (action.entries.length === 0 || action.entries.length > MAX_ALLOW_ENTRIES) {
          throw new RangeError(`allow 1 to ${String(MAX_ALLOW_ENTRIES)} recipients at a time`);
        }
        const entries = action.entries.map((e) => ({
          recipientRef: hex32Of(e.recipientRef, 'recipientRef'),
          destination: this.parseAccount(e.destination),
        }));
        return {
          target: mandate,
          method: 'allow_recipients',
          args: () => [encodeAllowEntries(entries)],
          summary: () =>
            `Allow ${entries.map((e) => e.destination).join(', ')} to be paid from mandate ${mandate}`,
        };
      }
      case 'pause':
        return {
          target: mandate,
          method: 'pause',
          args: (signer) => [address(signer)],
          summary: () =>
            `Pause mandate ${mandate}: no payout can be requested or paid until you resume it`,
        };
      case 'resume':
        return {
          target: mandate,
          method: 'resume',
          args: () => [],
          summary: () => `Resume mandate ${mandate} so payouts within its rules can go out again`,
        };
      case 'revoke':
        return {
          target: mandate,
          method: 'revoke',
          args: () => [],
          summary: () =>
            `Revoke mandate ${mandate} for good. Its balance can then be swept back to you`,
        };
      case 'approve':
      case 'reject': {
        const approver = this.parseAccount(action.approver);
        const id = hex32Of(action.payoutId, 'payoutId');
        const verb = action.kind === 'approve' ? 'Approve' : 'Reject';
        return {
          target: mandate,
          method: action.kind,
          signer: approver,
          args: () => [address(approver), bytes32(id)],
          summary: () => `${verb} payout ${id} on mandate ${mandate}`,
        };
      }
      case 'withdraw': {
        const amount = positive(action.amount, 'amount');
        return {
          target: mandate,
          method: 'withdraw',
          args: () => [i128(amount)],
          summary: () => `Withdraw ${this.usdc(amount)} from mandate ${mandate} to your wallet`,
        };
      }
    }
  }

  async prepareMandateAction(
    contract: string | null,
    action: MandateAction,
    o: CallOptions,
  ): Promise<SigningRequest> {
    const plan = this.plan(contract, action);
    const what = `prepare ${action.kind}`;
    return withDeadline(
      o,
      what,
      async () => {
        // The principal is whoever the chain says it is, never what a caller claims.
        const signer = plan.signer ?? (await this.mandate(plan.target).config()).principal;
        const tx = invokeTx(
          await this.o.chain.loadAccount(signer),
          plan.target,
          plan.method,
          plan.args(signer),
          this.passphrase,
        );
        const prepared = await this.o.chain.prepare(tx);
        return {
          network: this.network,
          xdr: prepared.toXdr(),
          signer,
          action: action.kind,
          summary: plan.summary(signer),
          expiresAt: new Date(this.now() + SIGN_WINDOW_SECONDS * 1000).toISOString(),
        };
      },
      (e) => toChainError(e, what),
    );
  }

  async submitSigned(
    signedXdr: string,
    expected: SigningRequest,
    o: CallOptions,
    budget?: FeeBudget,
  ): Promise<SubmitResult> {
    if (expected.network !== this.network)
      throw mismatch(`it was prepared for ${expected.network}`);
    const expires = Date.parse(expected.expiresAt);
    if (Number.isNaN(expires) || expires <= this.now()) {
      throw mismatch('its signing request has expired; prepare it again');
    }
    const want = envelope(expected.xdr, this.passphrase);
    const signed = envelope(signedXdr, this.passphrase);
    if (want.source !== expected.signer || signed.source !== expected.signer) {
      throw mismatch('its source is not the account the request names');
    }
    // The hash covers the source, sequence, fee, time bounds, memo and every
    // operation with its contract and arguments. An equal hash means the
    // wallet signed exactly what was prepared.
    const hash = signed.hash();
    if (!Buffer.from(hash).equals(Buffer.from(want.hash()))) {
      throw mismatch('its operations, source, contract or arguments differ from the request');
    }
    const key = Keypair.fromPublicKey(expected.signer);
    if (!signed.signatures.some((s) => key.verify(hash, s.signature))) {
      throw new ChainError(
        'SIGNATURE_INVALID',
        `The transaction is not signed by ${expected.signer}`,
      );
    }

    const sponsor = this.o.feeSponsor;
    let outgoing: Transaction | FeeBumpTransaction = signed;
    let charge: { fee: SponsoredFee; budget: FeeBudget } | undefined;
    if (sponsor !== undefined) {
      // An unmetered sponsor could be drained by one principal, so a sponsored
      // send always names what it is charged to.
      if (budget === undefined) {
        throw new ChainError('UNAVAILABLE', 'A sponsored transaction needs a fee budget');
      }
      let bump: FeeBumpTransaction;
      try {
        bump = this.bump(signed, sponsor);
      } catch (error) {
        throw toChainError(error, 'sponsor the fee');
      }
      charge = {
        fee: { innerTxHash: Buffer.from(hash).toString('hex'), maxFee: BigInt(bump.fee) },
        budget,
      };
      outgoing = bump;
      if (o.signal.aborted) {
        throw new ChainError(
          'TIMEOUT',
          'submit the transaction did not finish before its deadline',
        );
      }
      // Before anything leaves, so a refused fee sends nothing. The budget's
      // own error is the answer, not a chain error.
      await budget.reserve(charge.fee);
    }

    let sent: Submitted;
    try {
      sent = await withDeadline(
        o,
        'submit the transaction',
        () => this.o.chain.submit(outgoing),
        (e) => toChainError(e, 'submit the transaction'),
      );
    } catch (error) {
      if (charge !== undefined && neverApplied(error)) {
        // The transaction's own outcome is the answer; the budget reports its
        // failures itself.
        await charge.budget.release(charge.fee).catch(() => undefined);
      }
      throw error;
    }
    if (charge !== undefined) {
      await charge.budget
        .settle(charge.fee, sent.feeCharged ?? charge.fee.maxFee)
        .catch(() => undefined);
    }
    if (sent.status === 'SUCCESS') {
      // The factory answers with the address it deployed. The hash check above
      // already tied this envelope to the factory call we built.
      const contract =
        expected.action === 'create' ? this.deployedAddress(sent.returnValue) : undefined;
      return contract === undefined ? { txHash: sent.hash } : { txHash: sent.hash, contract };
    }
    if (sent.reason !== undefined) {
      throw new ChainError('CONTRACT_REFUSED', `The mandate refused it: ${sent.reason}`, {
        specError: sent.reason.toUpperCase(),
        reason: sent.reason,
        txHash: sent.hash,
      });
    }
    throw new ChainError('TX_FAILED', `The transaction failed on chain (${sent.hash})`, {
      txHash: sent.hash,
    });
  }

  private deployedAddress(value: xdr.ScVal | undefined): string | undefined {
    if (value === undefined) return undefined;
    let native: unknown;
    try {
      native = nativeOf(value);
    } catch {
      return undefined;
    }
    return typeof native === 'string' && isContractAddress(native) ? native : undefined;
  }

  /**
   * The inner transaction inside a fee bump the sponsor signs. The bump bids
   * the inner transaction's own inclusion fee per operation, and never less
   * than the network minimum, and passes the resource fee on as it is. The
   * bid is a ceiling: the network charges what inclusion costs.
   */
  private bump(inner: Transaction, sponsor: TxSigner): FeeBumpTransaction {
    const ops = BigInt(inner.operations.length);
    if (ops === 0n) throw mismatch('it has no operations');
    const inclusion = BigInt(inner.fee) - resourceFeeOf(inner);
    const perOp = (inclusion + ops - 1n) / ops;
    const base = perOp > BigInt(BASE_FEE) ? perOp : BigInt(BASE_FEE);
    const bump = TransactionBuilder.buildFeeBumpTransaction(
      sponsor.publicKey,
      base.toString(),
      inner,
      this.passphrase,
    );
    sponsor.sign(bump);
    return bump;
  }

  async sponsorFee(signedXdr: string, principal: string, o: CallOptions): Promise<string> {
    const sponsor = this.o.feeSponsor;
    if (sponsor === undefined) {
      throw new ChainError('UNAVAILABLE', 'No fee sponsor is set up on this server');
    }
    const owner = this.parseAccount(principal);
    const inner = envelope(signedXdr, this.passphrase);
    if (inner.source !== owner) throw mismatch('only a principal own transaction is sponsored');
    if (inner.signatures.length === 0) {
      throw new ChainError('SIGNATURE_INVALID', 'The transaction has no signature');
    }
    return withDeadline(
      o,
      'sponsor the fee',
      // An executor's throw becomes the promise's rejection, so it maps like any other.
      () =>
        new Promise<string>((resolve) => {
          resolve(this.bump(inner, sponsor).toXdr());
        }),
      (e) => toChainError(e, 'sponsor the fee'),
    );
  }

  private requestOf(intent: PayoutIntent): PayoutRequest {
    const legs = intent.legs.map((l) => ({
      destination: this.parseAccount(l.destination),
      amount: l.amount,
    }));
    // The contract checks the legs against the total; the total is their sum.
    const total = legs.reduce((sum, l) => sum + l.amount, 0n);
    return {
      payoutId: hex32Of(intent.payoutId, 'payoutId'),
      recipientRef: hex32Of(intent.recipientRef, 'recipientRef'),
      taskRef: hex32Of(intent.taskRef, 'taskRef'),
      total,
      fee: intent.fee,
      legs,
      deadline: intent.deadline,
    };
  }

  async checkPayout(intent: PayoutIntent, agent: string, o: CallOptions): Promise<CheckResult> {
    const m = this.mandate(this.parseContract(intent.mandate));
    const caller = this.parseAccount(agent);
    const req = this.requestOf(intent);
    return withDeadline(
      o,
      'check the payout',
      async (): Promise<CheckResult> => {
        const sim = await m.simulateRequest(caller, req);
        return sim.ok
          ? { ok: true }
          : { ok: false, specError: specErrorOf(sim.error.contractCode) };
      },
      (e) => toChainError(e, 'check the payout'),
    );
  }

  async requestPayout(
    intent: PayoutIntent,
    agent: TxSigner,
    o: CallOptions,
  ): Promise<{ txHash: string; state?: RequestedState }> {
    const m = this.mandate(this.parseContract(intent.mandate));
    const req = this.requestOf(intent);
    return withDeadline(
      o,
      'request the payout',
      async () => {
        const sent = await m.requestPayout(agent, req);
        const state = REQUESTED_STATES.get(sent.status);
        return state === undefined ? { txHash: sent.txHash } : { txHash: sent.txHash, state };
      },
      (e) => toChainError(e, 'request the payout'),
    );
  }

  async executePayout(
    contract: string,
    payoutId: Hex32,
    executor: TxSigner,
    o: CallOptions,
    hooks: SendHooks = {},
  ): Promise<{ txHash: string }> {
    const m = this.mandate(this.parseContract(contract));
    const id = hex32Of(payoutId, 'payoutId');
    const record = hooks.beforeSend;
    // A failed record is the caller's own failure and means nothing was sent,
    // so it is told apart from anything the network did.
    let recordFailed: unknown;
    const beforeSend =
      record === undefined
        ? undefined
        : async (txHash: string) => {
            try {
              await record(txHash);
            } catch (error) {
              recordFailed = error;
              throw error;
            }
          };
    return withDeadline(
      o,
      'execute the payout',
      async () => {
        const sent = await m.execute(executor, id, beforeSend === undefined ? {} : { beforeSend });
        return { txHash: sent.txHash };
      },
      (e) =>
        e !== undefined && e === recordFailed
          ? new ChainError('UNAVAILABLE', 'The payout was not executed: recording the send failed', {
              reason: 'before_send_failed',
              cause: e,
            })
          : toChainError(e, 'execute the payout'),
    );
  }

  async payoutState(contract: string, payoutId: Hex32, o: CallOptions): Promise<ChainPayoutState> {
    const m = this.mandate(this.parseContract(contract));
    const id = hex32Of(payoutId, 'payoutId');
    return withDeadline(
      o,
      'read the payout',
      async (): Promise<ChainPayoutState> => {
        const entry = await m.payout(id);
        if (entry === null) return { kind: 'absent' };
        switch (entry.status) {
          case PAYOUT_STATUS.pending:
            return {
              kind: 'pending',
              approvals: entry.kind === 'record' ? entry.approvals.length : 0,
            };
          case PAYOUT_STATUS.approved:
            return { kind: 'approved' };
          case PAYOUT_STATUS.executed:
            return { kind: 'executed' };
          case PAYOUT_STATUS.rejected:
            return { kind: 'rejected' };
          case PAYOUT_STATUS.cancelled:
            return { kind: 'cancelled' };
          default:
            throw new ChainError(
              'UNAVAILABLE',
              `The mandate answered an unknown payout status (${String(entry.status)})`,
            );
        }
      },
      (e) => toChainError(e, 'read the payout'),
    );
  }

  async transaction(
    txHash: string,
    o: CallOptions,
  ): Promise<{ status: 'SUCCESS' | 'FAILED' | 'NOT_FOUND'; ledger?: number }> {
    const hash = txHash.toLowerCase();
    if (!HEX32.test(hash)) throw new RangeError('txHash must be 64 hex digits');
    return withDeadline(
      o,
      'look up the transaction',
      async () => {
        const got = await this.o.gateway.transaction(hash);
        return got.status === 'NOT_FOUND'
          ? { status: got.status }
          : { status: got.status, ledger: got.ledger };
      },
      (e) => toChainError(e, 'look up the transaction'),
    );
  }

  async checkDestination(
    account: string,
    asset: string,
    o: CallOptions,
  ): Promise<
    | { receivable: true }
    | { receivable: false; reason: 'NO_ACCOUNT' | 'NO_TRUSTLINE' | 'NEEDS_MEMO' }
  > {
    const who = this.parseAccount(account);
    const wanted = this.parseAsset(asset);
    return withDeadline(
      o,
      'check the destination',
      async () => {
        const facts = await this.o.chain.accountFacts(who);
        if (!facts.exists) return { receivable: false, reason: 'NO_ACCOUNT' } as const;
        if (wanted !== 'native' && !facts.trustlines.includes(wanted)) {
          return { receivable: false, reason: 'NO_TRUSTLINE' } as const;
        }
        // A wallet rail payout carries no memo, so an account that needs one cannot take it.
        if (facts.memoRequired) return { receivable: false, reason: 'NEEDS_MEMO' } as const;
        return { receivable: true } as const;
      },
      (e) => toChainError(e, 'check the destination'),
    );
  }

  /** 'native' or CODE:ISSUER, the forms checkDestination takes. */
  private parseAsset(asset: string): string {
    if (asset === 'native') return asset;
    const [code, issuer, extra] = asset.split(':');
    if (
      code === undefined ||
      issuer === undefined ||
      extra !== undefined ||
      !ASSET_CODE.test(code) ||
      !isAccountAddress(issuer)
    ) {
      throw new RangeError('asset must be native or CODE:ISSUER');
    }
    return asset;
  }

  /**
   * The text is the one src/auth formats and parses, so a message built here
   * verifies there. Only the address is checked as a Stellar account first;
   * every other field is the auth format's to refuse (MESSAGE_MALFORMED).
   */
  walletProofMessage(p: Parameters<ChainAdapter['walletProofMessage']>[0]): string {
    return formatWalletMessage({
      version: WALLET_MESSAGE_VERSION,
      ...p,
      address: this.parseAccount(p.address),
    });
  }

  verifyWalletProof(address: string, message: string, signatureBase64: string): boolean {
    return verifyWalletProof(address, message, signatureBase64);
  }

  receiptRef(txHash: string, eventIndex: number): string {
    return receiptRef(this.network, txHash, eventIndex);
  }
}
