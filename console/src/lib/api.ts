// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// A small typed client for the console API. Every response is checked
// against its schema, and every failure becomes an ApiError carrying a
// sentence a person can act on.

import type * as z from 'zod/mini';

import {
  accountSchema,
  configSchema,
  errorBodySchema,
  faucetSchema,
  mandateListSchema,
  mandateSchema,
  okSchema,
  payoutListSchema,
  quoteSchema,
  receiptListSchema,
  receiptSchema,
  submitSchema,
  testRecipientSchema,
  unsignedTxSchema,
  type Account,
  type Config,
  type Mandate,
  type MandateSummary,
  type Payout,
  type QuoteResult,
  type Receipt,
  type SubmitResult,
  type UnsignedTx,
} from './schemas';
import { apiErrorText } from './words';

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  /** Set when the refusal clears with time, such as the faucet cooldown. */
  readonly retryAfterSeconds: number | undefined;

  constructor(code: string, message: string, status: number, retryAfterSeconds?: number) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export type Rail = 'usdc' | 'sdp';

export type TxAction =
  | 'create_mandate'
  | 'allow_recipients'
  | 'fund_mandate'
  | 'pause'
  | 'resume'
  | 'revoke'
  | 'sweep'
  | 'approve'
  | 'reject'
  | 'withdraw';

export interface CreateMandateParams {
  readonly budget: string;
  readonly perPaymentCap: string;
  readonly dailyCap: string;
  readonly approvalThreshold: string;
  readonly expiresAt: number;
}

export interface AgentCall {
  readonly recipient: string;
  readonly amount: string;
  readonly rail: Rail;
  readonly taskId: string;
}

export interface ConsoleApi {
  config: () => Promise<Config>;
  account: (address: string) => Promise<Account>;
  onboardXlm: (address: string) => Promise<void>;
  trustline: (address: string) => Promise<UnsignedTx>;
  /** Tops the wallet up to the faucet target; amount is what was sent. */
  onboardUsdc: (address: string) => Promise<{ hash: string; amount: string }>;
  testRecipient: () => Promise<{ address: string; hash?: string | null | undefined }>;
  buildTx: (
    action: TxAction,
    source: string,
    params: Record<string, unknown>,
  ) => Promise<UnsignedTx>;
  submitTx: (xdr: string) => Promise<SubmitResult>;
  mandates: (principal: string) => Promise<MandateSummary[]>;
  mandate: (id: string) => Promise<Mandate>;
  payouts: (id: string) => Promise<Payout[]>;
  quote: (
    id: string,
    call: Omit<AgentCall, 'taskId'> & { taskId?: string },
  ) => Promise<QuoteResult>;
  request: (id: string, call: AgentCall) => Promise<Receipt>;
  receipts: (id: string) => Promise<Receipt[]>;
}

export const NETWORK_ERROR =
  'We could not reach the UJIRA server. Check your connection and try again.';

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

async function readError(res: Response): Promise<ApiError> {
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // Not JSON: fall through to the status based message.
  }
  const parsed = errorBodySchema.safeParse(body);
  if (parsed.success) {
    const { code, message, retryAfterSeconds } = parsed.data.error;
    return new ApiError(
      code,
      apiErrorText(code, message, retryAfterSeconds),
      res.status,
      retryAfterSeconds,
    );
  }
  if (res.status === 429) {
    return new ApiError(
      'rate_limited',
      'Too many tries in a short time. Wait a minute and try again.',
      429,
    );
  }
  if (res.status === 504) {
    return new ApiError('timeout', apiErrorText('timeout', ''), 504);
  }
  if (res.status === 404) {
    return new ApiError('not_found', 'The server does not know that address or page.', 404);
  }
  if (res.status >= 500) {
    return new ApiError(
      'server_error',
      'The UJIRA server had a problem. Try again in a moment.',
      res.status,
    );
  }
  return new ApiError(
    'request_failed',
    `The server refused the request (HTTP ${res.status}).`,
    res.status,
  );
}

export function createHttpApi(
  fetchImpl: Fetch = (i, init) => fetch(i, init),
  base = '',
): ConsoleApi {
  async function call<S extends z.ZodMiniType>(
    schema: S,
    path: string,
    body?: unknown,
  ): Promise<z.infer<S>> {
    let res: Response;
    try {
      res = await fetchImpl(
        `${base}${path}`,
        body === undefined
          ? { headers: { accept: 'application/json' } }
          : {
              method: 'POST',
              headers: { accept: 'application/json', 'content-type': 'application/json' },
              body: JSON.stringify(body),
            },
      );
    } catch {
      throw new ApiError('network', NETWORK_ERROR, 0);
    }
    if (!res.ok) throw await readError(res);
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      throw new ApiError(
        'bad_response',
        'The server sent an answer we could not read.',
        res.status,
      );
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      throw new ApiError(
        'bad_response',
        'The server sent an answer in a shape we did not expect.',
        res.status,
      );
    }
    return parsed.data;
  }

  const enc = encodeURIComponent;

  return {
    config: () => call(configSchema, '/api/config'),
    account: (address) => call(accountSchema, `/api/accounts/${enc(address)}`),
    onboardXlm: async (address) => {
      await call(okSchema, '/api/onboard/xlm', { address });
    },
    trustline: (address) => call(unsignedTxSchema, '/api/onboard/trustline', { address }),
    onboardUsdc: (address) => call(faucetSchema, '/api/onboard/usdc', { address }),
    testRecipient: () => call(testRecipientSchema, '/api/recipients/test', {}),
    buildTx: (action, source, params) =>
      call(unsignedTxSchema, '/api/tx/build', { action, source, params }),
    submitTx: (xdr) => call(submitSchema, '/api/tx/submit', { xdr }),
    mandates: async (principal) =>
      (await call(mandateListSchema, `/api/mandates?principal=${enc(principal)}`)).mandates,
    mandate: (id) => call(mandateSchema, `/api/mandates/${enc(id)}`),
    payouts: async (id) =>
      (await call(payoutListSchema, `/api/mandates/${enc(id)}/payouts`)).payouts,
    quote: (id, c) => call(quoteSchema, `/api/mandates/${enc(id)}/agent/quote`, c),
    request: (id, c) => call(receiptSchema, `/api/mandates/${enc(id)}/agent/request`, c),
    receipts: async (id) =>
      (await call(receiptListSchema, `/api/mandates/${enc(id)}/receipts`)).receipts,
  };
}

/** A sentence for any failure: API errors carry their own, the rest get a plain one. */
export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error && error.message !== '') return error.message;
  return 'Something went wrong. Try again.';
}
