// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The client for the public API under /v1. One transport carries every call,
// sign in included: same origin, so the browser sends the HttpOnly session
// cookie and the Origin itself; the open project in the Ujira-Project header;
// one error envelope. Every answer is checked against its schema before a
// screen sees it. An answer in the wrong shape becomes an error that carries
// the request id and none of the data.

import * as z from 'zod/mini';

import { ApiError, NETWORK_ERROR } from './api';
import {
  apiKeyEnvelope,
  apiKeyPageSchema,
  createdApiKeySchema,
  createdEmbedSessionSchema,
  createdRecipientSchema,
  embedSessionPageSchema,
  mandateEnvelope,
  mandatePageSchema,
  overviewSchema,
  payoutEnvelope,
  payoutPageSchema,
  receiptEnvelope,
  receiptPageSchema,
  receiptVerificationSchema,
  recipientEnvelope,
  recipientPageSchema,
  signingRequestEnvelope,
  submittedSchema,
  type ApiKey,
  type EmbedSession,
  type Overview,
  type Page,
  type PayoutDetail,
  type ReceiptVerification,
  type SigningRequest,
  type Submitted,
  type TokenAmount,
  type V1Mandate,
  type V1Receipt,
  type V1Recipient,
} from './v1Schemas';
import { waitWords } from './words';

export const PROJECT_HEADER = 'Ujira-Project';
export const REQUEST_ID_HEADER = 'Ujira-Request-Id';
export const IDEMPOTENCY_HEADER = 'Idempotency-Key';

/** The one error envelope every /v1 route uses. */
export const v1ErrorSchema = z.looseObject({
  error: z.looseObject({
    code: z.string(),
    message: z.string(),
    requestId: z.optional(z.string()),
  }),
});

// Request ids are shown on screen, so only ones that look like an id are kept.
const REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;

function cleanRequestId(raw: string | null | undefined): string | undefined {
  return raw !== null && raw !== undefined && REQUEST_ID.test(raw) ? raw : undefined;
}

// Sentences for the /v1 codes a person can meet. Codes without one keep the
// server's own message, which is a fixed string that never quotes input.
const V1_ERRORS: Record<string, string> = {
  SESSION_INVALID: 'Your session has ended. Sign in again.',
  TOKEN_MALFORMED: 'Your session has ended. Sign in again.',
  TOKEN_INVALID: 'Your session has ended. Sign in again.',
  SIGNATURE_INVALID: 'The wallet signature did not match. Sign in again.',
  CHALLENGE_EXPIRED: 'The sign in message ran out of time. Sign in again.',
  FORBIDDEN: 'Your role cannot do that here.',
  ORIGIN_NOT_ALLOWED: 'This page is not allowed to sign you in. Open UJIRA from ujira.co.',
  NOT_FOUND: 'We could not find that. Reload the page and try again.',
  PAYLOAD_TOO_LARGE: 'That request is too large to send.',
  IDEMPOTENCY_KEY_REUSED: 'That request was already sent with different details. Start it again.',
  IDEMPOTENCY_IN_PROGRESS: 'That request is still being handled. Wait a moment and refresh.',
  TASK_ID_REUSED: 'This task already has a payout on this mandate. Use a new task ID.',
  API_KEY_LIMIT_REACHED: 'This project has 20 active keys. Revoke one to make another.',
  TOKEN_ENVIRONMENT_MISMATCH:
    'That key is for the other network. Test keys work on testnet, live keys on mainnet.',
  RECIPIENT_LABEL_TAKEN: 'Someone on this mandate already has that name.',
  MANDATE_REFUSED: 'The mandate refused this change.',
  RATE_LIMITED: 'Too many tries in a short time. Wait a minute and try again.',
  CHAIN_UNAVAILABLE: 'The Stellar network is not answering right now. Try again in a moment.',
  DB_UNAVAILABLE: 'UJIRA is busy for a moment. Try again shortly.',
  INTERNAL: 'The UJIRA server had a problem. Try again in a moment.',
};

/** The sentence for a /v1 error code; the server's own words when we have none. */
export function v1ErrorText(
  code: string,
  serverMessage: string,
  retryAfterSeconds?: number,
): string {
  if (code === 'RATE_LIMITED' && retryAfterSeconds !== undefined) {
    return `Too many tries in a short time. Try again in ${waitWords(retryAfterSeconds)}.`;
  }
  return (
    V1_ERRORS[code] ?? (serverMessage === '' ? 'That did not work. Try again.' : serverMessage)
  );
}

/** Seconds from a Retry-After header, which is either a number of seconds or a date. */
export function retryAfterSeconds(
  value: string | null,
  now: number = Date.now(),
): number | undefined {
  if (value === null) return undefined;
  const raw = value.trim();
  if (/^\d{1,9}$/.test(raw)) return Number.parseInt(raw, 10);
  const at = Date.parse(raw);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, Math.ceil((at - now) / 1000));
}

const UNREADABLE = 'The server sent an answer we could not read.';
const UNEXPECTED = 'The server sent an answer in a shape we did not expect.';

async function readV1Error(res: Response): Promise<ApiError> {
  const headerId = cleanRequestId(res.headers.get(REQUEST_ID_HEADER));
  const retry = res.status === 429 ? retryAfterSeconds(res.headers.get('retry-after')) : undefined;
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // No JSON body: the status decides.
  }
  const parsed = v1ErrorSchema.safeParse(body);
  if (parsed.success) {
    const { code, message, requestId } = parsed.data.error;
    return new ApiError(
      code,
      v1ErrorText(code, message, retry),
      res.status,
      retry,
      cleanRequestId(requestId) ?? headerId,
    );
  }
  const byStatus = (code: string) =>
    new ApiError(code, v1ErrorText(code, '', retry), res.status, retry, headerId);
  if (res.status === 401) return byStatus('SESSION_INVALID');
  if (res.status === 429) return byStatus('RATE_LIMITED');
  if (res.status >= 500) return byStatus('INTERNAL');
  return new ApiError(
    'REQUEST_FAILED',
    `The server refused the request (HTTP ${res.status}).`,
    res.status,
    undefined,
    headerId,
  );
}

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export type Query = Readonly<Record<string, string | number | undefined>>;

export interface V1Request {
  readonly method: 'GET' | 'POST' | 'DELETE';
  readonly path: string;
  readonly query?: Query | undefined;
  readonly body?: unknown;
  readonly idempotencyKey?: string | undefined;
}

export interface V1Transport {
  /** Sends the request and returns the body, checked against `schema`. */
  json: <S extends z.ZodMiniType>(schema: S, request: V1Request) => Promise<z.output<S>>;
  /** Sends the request and returns a text body, such as a CSV export. */
  text: (request: V1Request, contentType: RegExp) => Promise<string>;
  /** Sends the request and ignores any body. */
  send: (request: V1Request) => Promise<void>;
  /** The project every later request names; null for none. */
  useProject: (projectId: string | null) => void;
  /** Called on every 401, from any route, so the console can send the person to sign in. */
  onSessionLost: (listener: () => void) => () => void;
}

function withQuery(path: string, query: Query | undefined): string {
  if (query === undefined) return path;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== '') params.set(key, String(value));
  }
  const qs = params.toString();
  return qs === '' ? path : `${path}?${qs}`;
}

// Amounts are bigint in the console and decimal strings on the wire.
function toJson(body: unknown): string {
  return JSON.stringify(body, (_key, value: unknown) =>
    typeof value === 'bigint' ? value.toString() : value,
  );
}

export function createV1Transport(
  fetchImpl: Fetch = (i, init) => fetch(i, init),
  base = '',
): V1Transport {
  let project: string | null = null;
  const listeners = new Set<() => void>();

  async function request(r: V1Request): Promise<Response> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (r.body !== undefined) headers['content-type'] = 'application/json';
    if (project !== null) headers[PROJECT_HEADER] = project;
    if (r.idempotencyKey !== undefined) headers[IDEMPOTENCY_HEADER] = r.idempotencyKey;
    let res: Response;
    try {
      res = await fetchImpl(`${base}${withQuery(r.path, r.query)}`, {
        method: r.method,
        headers,
        credentials: 'same-origin',
        ...(r.body === undefined ? {} : { body: toJson(r.body) }),
      });
    } catch {
      throw new ApiError('network', NETWORK_ERROR, 0);
    }
    if (res.ok) return res;
    const error = await readV1Error(res);
    if (res.status === 401) for (const listener of [...listeners]) listener();
    throw error;
  }

  return {
    json: async (schema, r) => {
      const res = await request(r);
      const requestId = cleanRequestId(res.headers.get(REQUEST_ID_HEADER));
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        throw new ApiError('bad_response', UNREADABLE, res.status, undefined, requestId);
      }
      const parsed = schema.safeParse(body);
      if (!parsed.success) {
        throw new ApiError('bad_response', UNEXPECTED, res.status, undefined, requestId);
      }
      return parsed.data;
    },
    text: async (r, contentType) => {
      const res = await request(r);
      const requestId = cleanRequestId(res.headers.get(REQUEST_ID_HEADER));
      if (!contentType.test(res.headers.get('content-type') ?? '')) {
        throw new ApiError('bad_response', UNEXPECTED, res.status, undefined, requestId);
      }
      return res.text();
    },
    send: async (r) => {
      await request(r);
    },
    useProject: (projectId) => {
      project = projectId;
    },
    onSessionLost: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export interface PageQuery {
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
}

export interface RecipientQuery extends PageQuery {
  /** Only the recipients of this mandate. */
  readonly mandateId?: string | undefined;
}

export interface CreateRecipientInput {
  /** The mandate the recipient belongs to; the label is unique there. */
  readonly mandateId: string;
  readonly label: string;
  /** A Stellar account. Without one, the recipient adds a wallet through an invite link. */
  readonly address?: string | undefined;
  /** Stored sealed and shown only on the recipient's own page. */
  readonly email?: string | undefined;
}

export interface CreateEmbedSessionInput {
  readonly recipientId: string;
  /** How long the invite link works. */
  readonly expiresInSeconds: number;
}

export interface PayoutQuery extends PageQuery {
  readonly status?: string | undefined;
  readonly mandateId?: string | undefined;
  readonly recipientId?: string | undefined;
  readonly createdFrom?: string | undefined;
  readonly createdTo?: string | undefined;
}

export interface MandateLimitsInput {
  readonly totalBudget: TokenAmount;
  readonly perPaymentCap: TokenAmount;
  readonly perRecipientDailyCap: TokenAmount;
  readonly approvalThreshold: TokenAmount;
  readonly payoutTtlSeconds: number;
  readonly expiresAt: string;
}

/** A new mandate. The server names the project's agent key and the UJIRA executor. */
export interface PrepareMandateInput {
  /** What the principal calls it; typed back to confirm a revoke. */
  readonly name?: string | undefined;
  readonly approvers: readonly string[];
  readonly approvalsRequired: number;
  readonly limits: MandateLimitsInput;
  /** Ids of project recipients the mandate may pay from the start. */
  readonly recipients: readonly string[];
}

/** What can be done to a mandate that exists; each becomes a request for the wallet to sign. */
export type MandateActionInput =
  | { readonly kind: 'fund'; readonly amount: bigint }
  | { readonly kind: 'allow_recipients'; readonly recipientIds: readonly string[] }
  | { readonly kind: 'pause' }
  | { readonly kind: 'resume' }
  | { readonly kind: 'revoke' }
  | { readonly kind: 'approve'; readonly payoutId: string }
  | { readonly kind: 'reject'; readonly payoutId: string }
  | { readonly kind: 'withdraw'; readonly amount: bigint };

export interface CreatePayoutInput {
  readonly mandateId: string;
  readonly recipientId: string;
  readonly amount: TokenAmount;
  readonly taskId: string;
  readonly metadata?: Readonly<Record<string, string>> | undefined;
}

export interface CreateApiKeyInput {
  readonly name: string;
  readonly scopes: readonly string[];
  /** Whole days, 1 to 730. The server takes 365 when it is left out. */
  readonly expiresInDays?: number | undefined;
}

/** The /v1 routes the console calls with a session. Sign in itself is in auth.ts. */
export interface V1Api {
  mandates: (q?: PageQuery) => Promise<Page<V1Mandate>>;
  mandate: (id: string) => Promise<V1Mandate>;
  prepareMandate: (input: PrepareMandateInput) => Promise<SigningRequest>;
  importMandate: (contractId: string) => Promise<V1Mandate>;
  mandateAction: (id: string, action: MandateActionInput) => Promise<SigningRequest>;
  /** Sends what the wallet signed; the server fee bumps, relays and records it. */
  submitSigned: (signingRequestId: string, xdr: string) => Promise<Submitted>;
  recipients: (q?: RecipientQuery) => Promise<Page<V1Recipient>>;
  /** Checks a wallet that could not receive on the chain again. */
  recipient: (id: string) => Promise<V1Recipient>;
  createRecipient: (
    input: CreateRecipientInput,
  ) => Promise<{ recipient: V1Recipient; signingRequest: SigningRequest | null }>;
  /** The invite links made for one recipient, newest first. Never their tokens. */
  embedSessions: (q: PageQuery & { readonly recipientId: string }) => Promise<Page<EmbedSession>>;
  /** The token comes back once; the server keeps only its hash. */
  createEmbedSession: (
    input: CreateEmbedSessionInput,
  ) => Promise<{ session: EmbedSession; token: string }>;
  revokeEmbedSession: (id: string) => Promise<void>;
  /** The key makes a retry safe: the same key and body return the same payout. */
  createPayout: (input: CreatePayoutInput, idempotencyKey: string) => Promise<PayoutDetail>;
  payouts: (q?: PayoutQuery) => Promise<Page<PayoutDetail>>;
  payout: (id: string) => Promise<PayoutDetail>;
  approvals: (q?: PageQuery) => Promise<Page<PayoutDetail>>;
  receipts: (q?: PayoutQuery) => Promise<Page<V1Receipt>>;
  receipt: (id: string) => Promise<V1Receipt>;
  receiptsCsv: (q?: PayoutQuery) => Promise<string>;
  verifyReceipt: (id: string) => Promise<ReceiptVerification>;
  apiKeys: (q?: PageQuery) => Promise<Page<ApiKey>>;
  /** The secret comes back once and is never shown again. */
  createApiKey: (input: CreateApiKeyInput) => Promise<{ apiKey: ApiKey; secret: string }>;
  /** The key as the server holds it now, revoked. Revoking twice returns it as it is. */
  revokeApiKey: (id: string) => Promise<ApiKey>;
  overview: (q?: { from?: string | undefined; to?: string | undefined }) => Promise<Overview>;
}

const enc = encodeURIComponent;

function pageQuery(q: PageQuery | undefined): Query {
  return { cursor: q?.cursor, limit: q?.limit };
}

function payoutQuery(q: PayoutQuery | undefined): Query {
  return {
    ...pageQuery(q),
    status: q?.status,
    mandateId: q?.mandateId,
    recipientId: q?.recipientId,
    createdFrom: q?.createdFrom,
    createdTo: q?.createdTo,
  };
}

export function createHttpV1Api(transport: V1Transport): V1Api {
  const t = transport;
  return {
    mandates: (q) =>
      t.json(mandatePageSchema, { method: 'GET', path: '/v1/mandates', query: pageQuery(q) }),
    mandate: async (id) =>
      (await t.json(mandateEnvelope, { method: 'GET', path: `/v1/mandates/${enc(id)}` })).mandate,
    prepareMandate: async (input) =>
      (
        await t.json(signingRequestEnvelope, {
          method: 'POST',
          path: '/v1/mandates/prepare',
          body: input,
        })
      ).signingRequest,
    importMandate: async (contractId) =>
      (
        await t.json(mandateEnvelope, {
          method: 'POST',
          path: '/v1/mandates/import',
          body: { contractId },
        })
      ).mandate,
    mandateAction: async (id, action) =>
      (
        await t.json(signingRequestEnvelope, {
          method: 'POST',
          path: `/v1/mandates/${enc(id)}/actions`,
          body: action,
        })
      ).signingRequest,
    submitSigned: (signingRequestId, xdr) =>
      t.json(submittedSchema, {
        method: 'POST',
        path: '/v1/signing/submit',
        body: { signingRequestId, xdr },
        // One request is submitted once, so its id makes a safe retry key.
        idempotencyKey: `submit:${signingRequestId}`,
      }),
    recipients: (q) =>
      t.json(recipientPageSchema, {
        method: 'GET',
        path: '/v1/recipients',
        query: { ...pageQuery(q), mandateId: q?.mandateId },
      }),
    recipient: async (id) =>
      (await t.json(recipientEnvelope, { method: 'GET', path: `/v1/recipients/${enc(id)}` }))
        .recipient,
    createRecipient: (input) =>
      t.json(createdRecipientSchema, { method: 'POST', path: '/v1/recipients', body: input }),
    embedSessions: (q) =>
      t.json(embedSessionPageSchema, {
        method: 'GET',
        path: '/v1/embed/sessions',
        query: { ...pageQuery(q), recipientId: q.recipientId },
      }),
    createEmbedSession: (input) =>
      t.json(createdEmbedSessionSchema, {
        method: 'POST',
        path: '/v1/embed/sessions',
        body: input,
      }),
    revokeEmbedSession: (id) => t.send({ method: 'DELETE', path: `/v1/embed/sessions/${enc(id)}` }),
    createPayout: async (input, idempotencyKey) =>
      (
        await t.json(payoutEnvelope, {
          method: 'POST',
          path: '/v1/payouts',
          body: input,
          idempotencyKey,
        })
      ).payout,
    payouts: (q) =>
      t.json(payoutPageSchema, { method: 'GET', path: '/v1/payouts', query: payoutQuery(q) }),
    payout: async (id) =>
      (await t.json(payoutEnvelope, { method: 'GET', path: `/v1/payouts/${enc(id)}` })).payout,
    approvals: (q) =>
      t.json(payoutPageSchema, { method: 'GET', path: '/v1/approvals', query: pageQuery(q) }),
    receipts: (q) =>
      t.json(receiptPageSchema, { method: 'GET', path: '/v1/receipts', query: payoutQuery(q) }),
    receipt: async (id) =>
      (await t.json(receiptEnvelope, { method: 'GET', path: `/v1/receipts/${enc(id)}` })).receipt,
    receiptsCsv: (q) =>
      t.text(
        { method: 'GET', path: '/v1/receipts/export.csv', query: payoutQuery(q) },
        /^text\/csv\b/,
      ),
    verifyReceipt: (id) =>
      t.json(receiptVerificationSchema, {
        method: 'GET',
        path: `/v1/receipts/${enc(id)}/verify`,
      }),
    apiKeys: (q) =>
      t.json(apiKeyPageSchema, { method: 'GET', path: '/v1/api-keys', query: pageQuery(q) }),
    createApiKey: (input) =>
      t.json(createdApiKeySchema, { method: 'POST', path: '/v1/api-keys', body: input }),
    revokeApiKey: async (id) =>
      (await t.json(apiKeyEnvelope, { method: 'DELETE', path: `/v1/api-keys/${enc(id)}` })).apiKey,
    overview: (q) =>
      t.json(overviewSchema, {
        method: 'GET',
        path: '/v1/stats/overview',
        query: { from: q?.from, to: q?.to },
      }),
  };
}
