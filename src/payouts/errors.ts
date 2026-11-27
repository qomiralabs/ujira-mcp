// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// Callers branch on `code`, which stays stable, never on the message. Messages
// only ever name statuses or counts we validated, never caller text.

export type PayoutErrorCode =
  | 'INVALID_TRANSITION'
  | 'INVALID_LEGS'
  | 'FEE_SPONSOR_CAP_REACHED'
  | PayoutRetryCode;

/**
 * Why a payout job stopped without changing anything and must look again
 * later. Each is an attempt the queue retries with backoff.
 *
 * - SETTLEMENT_PENDING: an execute was sent and the network has not settled it either way.
 * - CHAIN_LAGGING: a transaction landed but the payout's state on chain does not show it yet.
 * - STALE_PAYOUT: another run moved the payout while this one was working.
 */
export type PayoutRetryCode = 'SETTLEMENT_PENDING' | 'CHAIN_LAGGING' | 'STALE_PAYOUT';

export class PayoutError extends Error {
  readonly code: PayoutErrorCode;

  constructor(code: PayoutErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'PayoutError';
    this.code = code;
  }
}

/** A status change the payout state machine does not allow. */
export class InvalidTransitionError extends PayoutError {
  constructor(message: string) {
    super('INVALID_TRANSITION', message);
    this.name = 'InvalidTransitionError';
  }
}

/** The job must look again later; nothing was sent and nothing moved. */
export class PayoutRetryError extends PayoutError {
  constructor(code: PayoutRetryCode) {
    super(code, `the payout is not ready to move on (${code})`);
    this.name = 'PayoutRetryError';
  }
}

/** A total and weights that cannot be split into valid payout legs. */
export class InvalidLegsError extends PayoutError {
  constructor(message: string) {
    super('INVALID_LEGS', message);
    this.name = 'InvalidLegsError';
  }
}

/**
 * The principal has used its daily fee sponsorship, so the transaction was
 * not sent. The API answers it as RATE_LIMITED, with Retry-After.
 */
export class FeeSponsorCapError extends PayoutError {
  /** Seconds until the UTC day turns and the cap starts again. */
  readonly retryAfterSeconds: number;

  constructor(retryAfterSeconds: number) {
    super(
      'FEE_SPONSOR_CAP_REACHED',
      'The daily network fee allowance for this principal is used up; try again tomorrow (UTC)',
    );
    this.name = 'FeeSponsorCapError';
    this.retryAfterSeconds = retryAfterSeconds;
  }
}
