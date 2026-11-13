// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// Typed failures. Every message is safe to hand back to a caller: none of them
// carries a key, an RPC URL or a raw response body.

export type EngineErrorCode =
  | 'config_invalid'
  | 'input_invalid'
  | 'contract_refused'
  | 'rpc_unavailable'
  | 'rpc_timeout'
  | 'tx_failed'
  | 'submission_unknown'
  | 'task_conflict'
  | 'rail_unavailable';

export class EngineError extends Error {
  readonly code: EngineErrorCode;

  constructor(code: EngineErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'EngineError';
    this.code = code;
  }
}

/**
 * The mandate's error codes, as the contract's `MandateError` enum numbers
 * them. The snake case name doubles as the reason a payout was blocked, so a
 * prediction and the contract's own answer read the same.
 */
export const MANDATE_ERRORS: Readonly<Record<number, string>> = {
  10: 'unauthorized',
  11: 'role_conflict',
  12: 'role_set_full',
  20: 'mandate_revoked',
  21: 'mandate_expired',
  22: 'mandate_paused',
  23: 'already_paused',
  24: 'not_paused',
  25: 'mandate_active',
  26: 'principal_change_pending',
  27: 'sweep_grace_period',
  30: 'amount_invalid',
  31: 'legs_invalid',
  32: 'legs_sum_mismatch',
  33: 'batch_invalid',
  34: 'config_invalid',
  35: 'request_deadline_passed',
  40: 'budget_exceeded',
  41: 'payment_cap_exceeded',
  42: 'daily_cap_exceeded',
  43: 'insufficient_funds',
  44: 'budget_below_reserved',
  45: 'nothing_to_sweep',
  46: 'fee_exceeds_cap',
  50: 'recipient_not_allowed',
  51: 'attestation_invalid',
  52: 'attestation_expired',
  53: 'policy_changed',
  54: 'wrong_recipient_mode',
  60: 'payout_id_exists',
  61: 'payout_not_found',
  62: 'payout_wrong_status',
  63: 'payout_lapsed',
  64: 'already_approved',
  65: 'agent_removed',
  70: 'asset_not_supported',
  71: 'wrong_asset',
  72: 'transfer_failed',
  90: 'internal_invariant',
};

export function mandateErrorName(code: number): string {
  return MANDATE_ERRORS[code] ?? `mandate_error_${code}`;
}

/** The mandate refused a call, in simulation or on chain. */
export class ContractRefusedError extends EngineError {
  readonly contractCode: number;
  readonly method: string;
  readonly reason: string;
  /** Set when a transaction landed and failed; absent when only the simulation refused. */
  readonly txHash: string | undefined;

  constructor(method: string, contractCode: number, txHash?: string) {
    const reason = mandateErrorName(contractCode);
    super('contract_refused', `The mandate refused ${method}: ${reason} (#${contractCode})`);
    this.name = 'ContractRefusedError';
    this.method = method;
    this.contractCode = contractCode;
    this.reason = reason;
    this.txHash = txHash;
  }
}

/** Finds the contract error code in a host error, such as `Error(Contract, #41)`. */
export function contractCodeIn(text: string): number | undefined {
  const match = /Error\(Contract, #(\d+)\)/.exec(text);
  return match?.[1] === undefined ? undefined : Number(match[1]);
}
