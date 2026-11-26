// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The console API answers every failure as `{ error: { code, message } }`.
// Messages are written here or come from EngineError, whose messages are
// already safe to show: none carries a key, a URL with a credential or a raw
// response body.

import { ChainError, type ChainErrorCode } from '../chain/adapter.js';
import { ContractRefusedError, EngineError, type EngineErrorCode } from '../errors.js';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  /** For a refusal that clears with time, so a page can say when to try again. */
  readonly retryAfterSeconds: number | undefined;

  constructor(
    status: number,
    code: string,
    message: string,
    options?: { cause?: unknown; retryAfterSeconds?: number },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.retryAfterSeconds = options?.retryAfterSeconds;
  }
}

const ENGINE_STATUS: Record<EngineErrorCode, number> = {
  config_invalid: 500,
  input_invalid: 400,
  contract_refused: 400,
  rpc_unavailable: 502,
  rpc_timeout: 504,
  tx_failed: 502,
  submission_unknown: 504,
  task_conflict: 409,
  rail_unavailable: 400,
};

/** The console's answer for a chain failure that carries one of its older codes. */
const CHAIN_REASON_STATUS: Readonly<Record<string, number>> = {
  horizon_unavailable: 502,
  network_unavailable: 502,
  friendbot_failed: 502,
  account_not_found: 400,
  simulation_failed: 400,
  tx_rejected: 400,
  tx_not_allowed: 400,
  invalid_xdr: 400,
  restore_needed: 409,
  submission_unknown: 504,
};

const CHAIN_STATUS: Record<ChainErrorCode, number> = {
  TIMEOUT: 504,
  UNAVAILABLE: 502,
  INVALID_ADDRESS: 400,
  CONTRACT_REFUSED: 400,
  TX_FAILED: 502,
  SIGNATURE_INVALID: 400,
  SIGNING_REQUEST_MISMATCH: 400,
};

function fromChain(error: ChainError): ApiError {
  const code = error.reason ?? error.code.toLowerCase();
  const status =
    error.code === 'CONTRACT_REFUSED'
      ? 400
      : (CHAIN_REASON_STATUS[code] ?? CHAIN_STATUS[error.code]);
  return new ApiError(status, code, error.message, { cause: error });
}

/** Any thrown value as the error the API answers with. Unknown failures say nothing specific. */
export function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  if (error instanceof ChainError) return fromChain(error);
  if (error instanceof ContractRefusedError) {
    return new ApiError(400, error.reason, error.message, { cause: error });
  }
  if (error instanceof EngineError) {
    return new ApiError(ENGINE_STATUS[error.code], error.code, error.message, { cause: error });
  }
  return new ApiError(500, 'internal_error', 'Something went wrong on the server', {
    cause: error,
  });
}
