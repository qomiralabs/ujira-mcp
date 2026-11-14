// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The console API answers every failure as `{ error: { code, message } }`.
// Messages are written here or come from EngineError, whose messages are
// already safe to show: none carries a key, a URL with a credential or a raw
// response body.

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

/** Any thrown value as the error the API answers with. Unknown failures say nothing specific. */
export function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
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
