// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// Callers branch on `code`, which stays stable, never on the message. Messages
// only ever name statuses or counts we validated, never caller text.

export type PayoutErrorCode = 'INVALID_TRANSITION';

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
