// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The boundary between UJIRA and a chain. Payouts, receipts, auth and the API
// talk to a ChainAdapter and never to a chain library, so the rules that move
// money are written once and a second network is a second adapter. Every
// call that reaches the network is bounded by its CallOptions, so a stuck
// RPC can delay a payout but never hold a worker forever.

import type { ContractRefusedError } from '../errors.js';
import type { Hex32 } from '../ids.js';
import type {
  AllowEntry,
  Limits,
  MandateConfigView,
  MandateStateView,
  PayoutEntry,
  PayoutRequest,
  TxLookup,
  TxSigner,
} from './types.js';

export type { AllowEntry, Limits, MandateConfigView, MandateStateView, TxSigner } from './types.js';

export const CHAIN_ADAPTER_VERSION = 1;
export type NetworkId = 'stellar:testnet' | 'stellar:pubnet';
// 64 lower case hex digits, the same type the payout ids already use.
export type { Hex32 } from '../ids.js';

/** How long a chain call may take when the caller names no deadline of its own. */
export const DEFAULT_CALL_TIMEOUT_MS = 10_000;

export interface CallOptions {
  readonly signal: AbortSignal; // every call is bounded; default 10 s
  readonly correlationId: string; // the payout or request id, for logs
}

export interface SigningRequest {
  readonly network: NetworkId;
  readonly xdr: string; // unsigned transaction envelope, base64
  readonly signer: string; // the account that must sign
  readonly action: MandateAction['kind'];
  readonly summary: string; // what the wallet is about to sign, in words
  readonly expiresAt: string; // ISO 8601
}

export type MandateAction =
  | {
      kind: 'create';
      principal: string;
      agent: string;
      executor: string;
      approvers: readonly string[];
      approvalsRequired: number;
      limits: Limits;
      recipients: readonly AllowEntry[];
    }
  | { kind: 'fund'; from: string; amount: bigint }
  | { kind: 'allow_recipients'; entries: readonly AllowEntry[] }
  | { kind: 'pause' }
  | { kind: 'resume' }
  | { kind: 'revoke' }
  | { kind: 'approve'; approver: string; payoutId: Hex32 }
  | { kind: 'reject'; approver: string; payoutId: Hex32 }
  | { kind: 'withdraw'; amount: bigint };

export interface PayoutIntent {
  readonly mandate: string; // contract address
  readonly payoutId: Hex32; // sha256 over the mandate and the task id, as the engine derives it today
  readonly taskRef: Hex32;
  readonly recipientRef: Hex32;
  readonly legs: readonly { readonly destination: string; readonly amount: bigint }[];
  readonly fee: bigint; // 0 on testnet
  readonly deadline: bigint; // unix seconds
}

export type ChainPayoutState =
  | { kind: 'absent' }
  | { kind: 'pending'; approvals: number }
  | { kind: 'approved' }
  | { kind: 'executed' }
  | { kind: 'rejected' }
  | { kind: 'cancelled' };

export type CheckResult = { ok: true } | { ok: false; specError: string }; // e.g. DAILY_CAP_EXCEEDED

export interface ChainAdapter {
  readonly version: typeof CHAIN_ADAPTER_VERSION;
  readonly network: NetworkId;
  health(o: CallOptions): Promise<{ ok: boolean; latestLedger: number }>;
  parseAccount(raw: string): string;
  readMandate(
    contract: string,
    o: CallOptions,
  ): Promise<{ config: MandateConfigView; state: MandateStateView }>;
  prepareMandateAction(
    contract: string | null,
    action: MandateAction,
    o: CallOptions,
  ): Promise<SigningRequest>;
  submitSigned(
    signedXdr: string,
    expected: SigningRequest,
    o: CallOptions,
  ): Promise<{ txHash: string }>;
  sponsorFee(signedXdr: string, principal: string, o: CallOptions): Promise<string>; // fee bump envelope
  checkPayout(intent: PayoutIntent, agent: string, o: CallOptions): Promise<CheckResult>; // simulation only
  requestPayout(intent: PayoutIntent, agent: TxSigner, o: CallOptions): Promise<{ txHash: string }>;
  executePayout(
    contract: string,
    payoutId: Hex32,
    executor: TxSigner,
    o: CallOptions,
  ): Promise<{ txHash: string }>;
  payoutState(contract: string, payoutId: Hex32, o: CallOptions): Promise<ChainPayoutState>;
  transaction(
    txHash: string,
    o: CallOptions,
  ): Promise<{ status: 'SUCCESS' | 'FAILED' | 'NOT_FOUND'; ledger?: number }>;
  checkDestination(
    account: string,
    asset: string,
    o: CallOptions,
  ): Promise<
    | { receivable: true }
    | { receivable: false; reason: 'NO_ACCOUNT' | 'NO_TRUSTLINE' | 'NEEDS_MEMO' }
  >;
  walletProofMessage(p: {
    purpose: 'sign_in' | 'recipient_wallet';
    address: string;
    origin: string;
    nonce: string;
    issuedAt: string;
    expiresAt: string;
  }): string;
  verifyWalletProof(address: string, message: string, signatureBase64: string): boolean; // SEP-53
  receiptRef(txHash: string, eventIndex: number): string; // ujira:tx:v1:stellar:testnet:<hash>:<index>
}

export const CHAIN_ERROR_CODES = [
  'TIMEOUT',
  'UNAVAILABLE',
  'INVALID_ADDRESS',
  'CONTRACT_REFUSED',
  'TX_FAILED',
  'SIGNATURE_INVALID',
  'SIGNING_REQUEST_MISMATCH',
] as const;
export type ChainErrorCode = (typeof CHAIN_ERROR_CODES)[number];

/**
 * The one error an adapter throws. Messages are safe to show a caller: none
 * carries a key, an RPC URL or a raw response body.
 */
export class ChainError extends Error {
  readonly code: ChainErrorCode;
  /** The mandate spec's error name, such as DAILY_CAP_EXCEEDED; set with CONTRACT_REFUSED. */
  readonly specError: string | undefined;
  /**
   * A finer reason in snake case, such as horizon_unavailable, for the
   * console routes, which answered with these codes before the adapter existed.
   */
  readonly reason: string | undefined;
  /** Set when a transaction was sent, so a caller can look it up before trying again. */
  readonly txHash: string | undefined;

  constructor(
    code: ChainErrorCode,
    message: string,
    options: { specError?: string; reason?: string; txHash?: string; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ChainError';
    this.code = code;
    this.specError = options.specError;
    this.reason = options.reason;
    this.txHash = options.txHash;
  }
}

/** Options for one call, bounded by `timeoutMs` from now. */
export function callOptions(
  correlationId: string,
  timeoutMs = DEFAULT_CALL_TIMEOUT_MS,
): CallOptions {
  return { signal: AbortSignal.timeout(timeoutMs), correlationId };
}

/**
 * Runs `work` until it settles or the call's signal aborts, whichever comes
 * first. An abort answers TIMEOUT at once; the work may still finish in the
 * background, so anything it sent must be looked up, never assumed lost.
 */
export async function withDeadline<T>(
  o: CallOptions,
  what: string,
  work: () => Promise<T>,
  mapError: (error: unknown) => ChainError,
): Promise<T> {
  const timeout = () =>
    new ChainError('TIMEOUT', `${what} did not finish before its deadline`, {
      cause: o.signal.reason,
    });
  if (o.signal.aborted) throw timeout();
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => {
      reject(timeout());
    };
    o.signal.addEventListener('abort', onAbort, { once: true });
  });
  const running = work().catch((error: unknown) => {
    throw mapError(error);
  });
  // Whichever loses the race must not surface later as an unhandled rejection.
  running.catch(() => undefined);
  aborted.catch(() => undefined);
  try {
    return await Promise.race([running, aborted]);
  } finally {
    if (onAbort !== undefined) o.signal.removeEventListener('abort', onAbort);
  }
}

export interface StatusTx {
  readonly status: number;
  readonly txHash: string;
}

export type RequestSimulation =
  | { readonly ok: true; readonly status: number }
  | { readonly ok: false; readonly error: ContractRefusedError };

/**
 * One mandate as the single mandate payout engine and the console use it:
 * the full payout record and the contract's numeric answers, which the
 * engine's receipts carry. Reached through an adapter, never built on a
 * gateway outside src/chain. Errors are EngineError and ContractRefusedError,
 * as the engine has always handled them.
 */
export interface MandateContract {
  readonly contractId: string;
  config(): Promise<MandateConfigView>;
  state(): Promise<MandateStateView>;
  /** What the recipient has been paid today, by the mandate's clock. */
  dailyUsed(recipientRef: Hex32): Promise<bigint>;
  isAllowed(recipientRef: Hex32, destination: string): Promise<boolean>;
  payout(payoutId: Hex32): Promise<PayoutEntry | null>;
  transaction(hash: string): Promise<TxLookup>;
  /** The contract's own verdict on a request, without sending it. */
  simulateRequest(agent: string, req: PayoutRequest): Promise<RequestSimulation>;
  requestPayout(agent: TxSigner, req: PayoutRequest): Promise<StatusTx>;
  approve(approver: TxSigner, payoutId: Hex32): Promise<StatusTx>;
  execute(executor: TxSigner, payoutId: Hex32): Promise<{ readonly txHash: string }>;
  cancel(caller: TxSigner, payoutId: Hex32): Promise<{ readonly txHash: string }>;
  allowRecipients(
    principal: TxSigner,
    entries: readonly AllowEntry[],
  ): Promise<{ readonly txHash: string }>;
}
