// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The one error shape every /v1 answer uses. A code maps to exactly one
// status, so clients can branch on the code alone and the OpenAPI document
// can list what each route may answer.
//
// Messages are fixed strings chosen by the server. Nothing a caller sent is
// copied into a message, and `details` only ever names where a problem is,
// never what the value was.

import { z } from 'zod';

export const API_ERROR_STATUS = {
  INVALID_REQUEST: 400,
  IDEMPOTENCY_KEY_REQUIRED: 400,
  IDEMPOTENCY_KEY_INVALID: 400,
  TOKEN_MALFORMED: 401,
  TOKEN_INVALID: 401,
  SESSION_INVALID: 401,
  FORBIDDEN: 403,
  ORIGIN_NOT_ALLOWED: 403,
  NOT_FOUND: 404,
  IDEMPOTENCY_IN_PROGRESS: 409,
  TASK_ID_REUSED: 409,
  RECIPIENT_LABEL_TAKEN: 409,
  MANDATE_REFUSED: 409,
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  IDEMPOTENCY_KEY_REUSED: 422,
  RATE_LIMITED: 429,
  INTERNAL: 500,
  CHAIN_UNAVAILABLE: 503,
  DB_UNAVAILABLE: 503,
} as const;

export type ApiErrorCode = keyof typeof API_ERROR_STATUS;
export type ApiErrorStatus = (typeof API_ERROR_STATUS)[ApiErrorCode];

export const API_ERROR_CODES = Object.keys(API_ERROR_STATUS) as readonly ApiErrorCode[];

/** Where a request failed validation: a dotted path and the kind of problem. */
export interface ErrorDetail {
  readonly path: string;
  readonly issue: string;
}

export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly status: ApiErrorStatus;
  readonly details: readonly ErrorDetail[] | undefined;
  /** Extra response headers, such as Retry-After on RATE_LIMITED. */
  readonly headers: Readonly<Record<string, string>>;

  constructor(
    code: ApiErrorCode,
    message: string,
    options: {
      details?: readonly ErrorDetail[];
      headers?: Record<string, string>;
      cause?: unknown;
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ApiError';
    this.code = code;
    this.status = API_ERROR_STATUS[code];
    this.details = options.details;
    this.headers = options.headers ?? {};
  }
}

export const errorEnvelopeSchema = z
  .object({
    error: z
      .object({
        code: z.enum(API_ERROR_CODES as [ApiErrorCode, ...ApiErrorCode[]]),
        message: z.string(),
        requestId: z.string(),
        details: z.array(z.object({ path: z.string(), issue: z.string() }).strict()).optional(),
      })
      .strict(),
  })
  .strict();

export type ErrorEnvelope = z.infer<typeof errorEnvelopeSchema>;

export function envelope(
  code: ApiErrorCode,
  message: string,
  requestId: string,
  details?: readonly ErrorDetail[],
): ErrorEnvelope {
  return {
    error: {
      code,
      message,
      requestId,
      ...(details === undefined || details.length === 0 ? {} : { details: [...details] }),
    },
  };
}

/** Enough to locate every problem in a real request, small enough that a hostile one cannot blow up the answer. */
const MAX_DETAILS = 20;
const MAX_SEGMENT = 64;

function segment(part: PropertyKey): string {
  if (typeof part === 'number') return String(part);
  const text = typeof part === 'symbol' ? '?' : part;
  return text.length > MAX_SEGMENT ? `${text.slice(0, MAX_SEGMENT)}...` : text;
}

function joinPath(prefix: string, parts: readonly PropertyKey[]): string {
  return [prefix, ...parts.map(segment)].filter((p) => p !== '').join('.');
}

/**
 * Turns a zod failure into details. Only paths and issue codes leave: zod
 * messages can quote the input, so they are dropped. An unknown key is
 * reported at its own path, since the key is the problem.
 */
export function validationDetails(error: z.ZodError, prefix: string): ErrorDetail[] {
  const out: ErrorDetail[] = [];
  for (const issue of error.issues) {
    if (issue.code === 'unrecognized_keys') {
      for (const key of issue.keys) {
        out.push({ path: joinPath(prefix, [...issue.path, key]), issue: issue.code });
      }
    } else {
      out.push({ path: joinPath(prefix, issue.path), issue: issue.code });
    }
  }
  return out.slice(0, MAX_DETAILS);
}
