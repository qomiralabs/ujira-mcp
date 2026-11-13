// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// A rail is how an approved payout reaches the person. The mandate check is
// the same for every rail: the engine requests the payout against the
// mandate first, and only a payout the mandate approved is handed to a rail.
// A rail decides two things: which on-chain destination the mandate pays for
// a recipient, and how the approved payout is then settled.

import { EngineError, type EngineErrorCode } from '../errors.js';
import type { Hex32 } from '../ids.js';

export const RAIL_NAMES = ['usdc', 'sdp'] as const;
export type RailName = (typeof RAIL_NAMES)[number];

/** An approved payout, as the engine hands it to a rail. Amounts are minor units. */
export interface RailPayment {
  readonly taskId: string;
  readonly payoutId: Hex32;
  /** What the caller named: an account for the USDC rail, a rail specific handle otherwise. */
  readonly recipient: string;
  /** The on-chain destination the mandate pays, as `destinationFor` chose it. */
  readonly destination: string;
  readonly amount: bigint;
  /** The asset code, such as USDC. */
  readonly asset: string;
}

export interface RailSettlement {
  /** The transaction that moved the money out of the mandate. */
  readonly txHash: string;
  /** Set by the SDP rail: the disbursement that pays the person from there. */
  readonly sdpDisbursementId?: string;
  /** Set by the SDP rail: the one payment inside that disbursement. */
  readonly sdpPaymentId?: string;
  /** Set by the SDP rail: the transaction in which SDP paid the person. */
  readonly sdpTxHash?: string;
}

export interface PayoutRail {
  readonly name: RailName;
  /**
   * The on-chain address the mandate pays for this recipient. Throws an
   * EngineError with code input_invalid when the rail cannot pay it.
   */
  destinationFor(recipient: string): string;
  /**
   * The account that finally receives the money, when that is not the
   * destination. The mandate's recipient reference and daily cap follow the
   * person, and a rail like SDP pays everyone through one shared destination.
   */
  payee?(recipient: string): string;
  /** Settles a payout the mandate approved. Called once per payout; a retry calls it again. */
  settle(payment: RailPayment): Promise<RailSettlement>;
  /**
   * Finishes a payout whose mandate leg already landed, for rails that settle
   * in more than one step. `txHash` is that mandate transaction.
   */
  resume?(payment: RailPayment, txHash: string): Promise<RailSettlement>;
}

/** How far a settlement got before it failed. */
export interface SettlementProgress {
  /** Set once the money left the mandate. */
  readonly mandateTxHash?: string;
  readonly sdpDisbursementId?: string;
  readonly sdpPaymentId?: string;
}

/**
 * A settlement that failed part way. When `progress.mandateTxHash` is set the
 * mandate already paid, so the payout must be finished with `resume`, never
 * settled again.
 */
export class PartialSettlementError extends EngineError {
  readonly progress: SettlementProgress;

  constructor(
    code: EngineErrorCode,
    message: string,
    progress: SettlementProgress,
    options?: { cause?: unknown },
  ) {
    super(code, message, options);
    this.name = 'PartialSettlementError';
    this.progress = progress;
  }
}
