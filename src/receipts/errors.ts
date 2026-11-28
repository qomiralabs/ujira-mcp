// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

export type ReceiptErrorCode =
  | 'RECEIPT_NOT_CANONICAL'
  | 'RECEIPT_NOT_FOUND'
  | 'RECEIPT_NOT_FINISHED'
  | 'RECEIPT_NO_TRANSACTION'
  | 'RECEIPT_NETWORK_NOT_SERVED'
  | 'RECEIPT_LEGACY_INVALID';

/**
 * Base class for every receipt failure. Callers branch on `code`, which
 * stays stable across releases, rather than on message text. Messages name
 * the field that was wrong and never its value: a receipt holds destinations
 * and labels that have no place in a log line.
 */
export abstract class ReceiptError extends Error {
  abstract readonly code: ReceiptErrorCode;
}

// Each subclass spells its own name out so minified builds keep readable names.

/** A value that has no single canonical JSON form, such as a float or a Date. */
export class ReceiptNotCanonicalError extends ReceiptError {
  override readonly name = 'ReceiptNotCanonicalError';
  readonly code = 'RECEIPT_NOT_CANONICAL';
  readonly path: string;

  constructor(path: string, reason: string) {
    super(`not canonical at ${path}: ${reason}`);
    this.path = path;
  }
}

/** No such receipt for this tenant, which is also the answer for another tenant's. */
export class ReceiptNotFoundError extends ReceiptError {
  override readonly name = 'ReceiptNotFoundError';
  readonly code = 'RECEIPT_NOT_FOUND';

  constructor() {
    super('no such receipt');
  }
}

/**
 * The payout has not reached a final status. The job that issues a receipt
 * is only queued once it has, so this is a bug or a race the queue's bounded
 * retries settle.
 */
export class ReceiptNotFinishedError extends ReceiptError {
  override readonly name = 'ReceiptNotFinishedError';
  readonly code = 'RECEIPT_NOT_FINISHED';

  constructor() {
    super('the payout has not finished, so it has no receipt yet');
  }
}

/** A paid payout whose leg has no transaction recorded: it cannot be referenced. */
export class ReceiptNoTransactionError extends ReceiptError {
  override readonly name = 'ReceiptNoTransactionError';
  readonly code = 'RECEIPT_NO_TRANSACTION';

  constructor() {
    super('the paid payout has no transaction recorded on its leg');
  }
}

/** The receipt settled on a network this server's adapter does not serve. */
export class ReceiptNetworkNotServedError extends ReceiptError {
  override readonly name = 'ReceiptNetworkNotServedError';
  readonly code = 'RECEIPT_NETWORK_NOT_SERVED';

  constructor() {
    super('the receipt is on a network this server does not serve');
  }
}

/** A receipt from the old log that cannot be read as a receipt. `field` names why. */
export class ReceiptLegacyInvalidError extends ReceiptError {
  override readonly name = 'ReceiptLegacyInvalidError';
  readonly code = 'RECEIPT_LEGACY_INVALID';

  constructor(readonly field: string) {
    super(`the old receipt cannot be read: ${field}`);
  }
}
