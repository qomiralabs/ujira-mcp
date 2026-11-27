// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// Every money write takes an Idempotency-Key, so a client that never saw an
// answer can safely ask again. What a retry gets:
//
// - the same request, finished: the stored answer, unchanged, marked as a replay;
// - the same request, still running: 409, with Retry-After;
// - a different request under that key: 422.
//
// The store's unique constraint decides who wins a key, so this holds across
// instances. What it cannot cover is a process that dies mid request: the lease
// runs out and a retry runs the handler again. So a handler that moves money must
// also write the key, or a business key, under a unique constraint of its own.
//
// The key is chosen by the client and may be anything it likes, so it is never
// logged and never echoed back.

import { createHash } from 'node:crypto';

import type { ProjectContext } from '../db/index.js';
import { ApiError, envelope } from './errors.js';

export const IDEMPOTENCY_HEADER = 'Idempotency-Key';
export const REPLAYED_HEADER = 'Idempotent-Replayed';

/** The same format the database checks, so a key that passes here is never refused there. */
export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_.:-]{1,255}$/;

/**
 * Long enough for a handler to outlive any request, since a client that gives
 * up does not stop the work. A shorter lease would let a retry start while the
 * first attempt is still running.
 */
export const IDEMPOTENCY_LEASE_SECONDS = 120;

/** How long a finished answer is replayed. The database applies the same window. */
export const IDEMPOTENCY_REPLAY_SECONDS = 7 * 24 * 60 * 60;

/** A running request is usually a payout being written; a second is a fair wait. */
const IN_PROGRESS_RETRY_AFTER = '1';

export type Reservation =
  | { readonly kind: 'started'; readonly leaseId: string }
  | { readonly kind: 'in_progress' }
  | { readonly kind: 'mismatch' }
  | {
      readonly kind: 'replay';
      readonly status: number;
      readonly requestId: string;
      readonly body: string;
    };

export interface ReserveRequest {
  readonly key: string;
  readonly requestSha256: Buffer;
  readonly leaseSeconds: number;
}

export interface FinishRequest {
  readonly key: string;
  readonly leaseId: string;
  readonly status: number;
  readonly requestId: string;
  readonly body: string;
}

/**
 * Where keys are kept. Every method names the tenant, and a store keeps one
 * project's keys apart from every other's, so the same key in two projects is
 * two requests.
 */
export interface IdempotencyStore {
  readonly reserve: (tenant: ProjectContext, request: ReserveRequest) => Promise<Reservation>;
  /** False when this attempt lost the key, in which case the newer attempt's answer stands. */
  readonly complete: (tenant: ProjectContext, request: FinishRequest) => Promise<boolean>;
  readonly release: (
    tenant: ProjectContext,
    request: { readonly key: string; readonly leaseId: string },
  ) => Promise<boolean>;
}

/** The header's value, or a refusal. Names no value, since the client chose it. */
export function idempotencyKeyOf(headers: Headers): string {
  const key = headers.get(IDEMPOTENCY_HEADER);
  if (key === null) {
    throw new ApiError('IDEMPOTENCY_KEY_REQUIRED', 'This request needs an Idempotency-Key header');
  }
  if (!IDEMPOTENCY_KEY_PATTERN.test(key)) {
    throw new ApiError(
      'IDEMPOTENCY_KEY_INVALID',
      'The Idempotency-Key header must be 1 to 255 letters, digits or . _ : -',
    );
  }
  return key;
}

/**
 * What makes two requests the same one: the method, the path as sent, the query
 * and the exact body bytes. Each is framed by its length, so no part can run into
 * the next. Bytes rather than parsed JSON, because a key promises the same request
 * and not merely an equivalent one.
 */
export function requestFingerprint(method: string, url: URL, body: Uint8Array | null): Buffer {
  const hash = createHash('sha256');
  for (const part of [method, url.pathname, url.search]) {
    const bytes = Buffer.from(part, 'utf8');
    hash.update(`${String(bytes.byteLength)}:`).update(bytes);
  }
  if (body !== null) hash.update(`${String(body.byteLength)}:`).update(body);
  return hash.digest();
}

/**
 * Whether an answer is final, and so stored and replayed. A 5xx or a 429 says to
 * try again, so a retry has to run.
 */
export function isFinalStatus(status: number): boolean {
  return status < 500 && status !== 429;
}

/** Keeps records in memory, for tests. Follows the database's rules, lease and window included. */
export function memoryIdempotencyStore(now: () => Date = () => new Date()): IdempotencyStore {
  interface Row {
    requestSha256: Buffer;
    leaseId: string | null;
    leaseExpiresAt: number;
    expiresAt: number;
    answer: { status: number; requestId: string; body: string } | null;
  }
  const rows = new Map<string, Row>();
  let leases = 0;
  const idOf = (tenant: ProjectContext, key: string): string =>
    `${tenant.principalId}:${tenant.projectId}:${key}`;
  return {
    reserve: (tenant, request) => {
      const id = idOf(tenant, request.key);
      const row = rows.get(id);
      const at = now().getTime();
      const free =
        row === undefined ||
        row.expiresAt <= at ||
        (row.leaseId !== null &&
          row.leaseExpiresAt <= at &&
          row.requestSha256.equals(request.requestSha256));
      if (free) {
        leases += 1;
        const leaseId = `lease-${String(leases)}`;
        rows.set(id, {
          requestSha256: request.requestSha256,
          leaseId,
          leaseExpiresAt: at + request.leaseSeconds * 1000,
          expiresAt: at + IDEMPOTENCY_REPLAY_SECONDS * 1000,
          answer: null,
        });
        return Promise.resolve({ kind: 'started', leaseId });
      }
      if (!row.requestSha256.equals(request.requestSha256)) {
        return Promise.resolve({ kind: 'mismatch' });
      }
      if (row.answer === null) return Promise.resolve({ kind: 'in_progress' });
      return Promise.resolve({ kind: 'replay', ...row.answer });
    },
    complete: (tenant, request) => {
      const row = rows.get(idOf(tenant, request.key));
      if (row?.leaseId !== request.leaseId) return Promise.resolve(false);
      row.leaseId = null;
      row.answer = {
        status: request.status,
        requestId: request.requestId,
        body: request.body,
      };
      return Promise.resolve(true);
    },
    release: (tenant, request) => {
      const row = rows.get(idOf(tenant, request.key));
      if (row?.leaseId !== request.leaseId) return Promise.resolve(false);
      row.leaseExpiresAt = now().getTime();
      return Promise.resolve(true);
    },
  };
}

/** A response body and its status, as a route answers and as the store keeps it. */
export interface Answer {
  readonly status: number;
  readonly body: string;
}

export interface OnceRequest {
  readonly store: IdempotencyStore;
  readonly tenant: ProjectContext;
  readonly key: string;
  readonly requestSha256: Buffer;
  readonly requestId: string;
  /** The route's operation id, for log lines. */
  readonly operation: string;
  readonly log: (line: string) => void;
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'NonError';
}

/**
 * Runs `answer` if this attempt wins the key, and stores what it answered.
 * Otherwise answers from the store, or refuses. A thrown ApiError with a final
 * status is stored as the envelope the app would send for it, so its replay is
 * the same bytes; anything else gives the key back, so a retry runs at once.
 */
export async function answerOnce(
  request: OnceRequest,
  answer: () => Promise<Answer>,
): Promise<{ readonly answer: Answer; readonly replayed: boolean }> {
  const { store, tenant, key, requestSha256, requestId, operation, log } = request;
  const where = `requestId=${requestId} route=${operation} principalId=${tenant.principalId} projectId=${tenant.projectId}`;
  const reservation = await store.reserve(tenant, {
    key,
    requestSha256,
    leaseSeconds: IDEMPOTENCY_LEASE_SECONDS,
  });
  switch (reservation.kind) {
    case 'mismatch':
      throw new ApiError(
        'IDEMPOTENCY_KEY_REUSED',
        'This Idempotency-Key was already used for a different request',
      );
    case 'in_progress':
      throw new ApiError(
        'IDEMPOTENCY_IN_PROGRESS',
        'A request with this Idempotency-Key is still running',
        { headers: { 'retry-after': IN_PROGRESS_RETRY_AFTER } },
      );
    case 'replay':
      log(`event=idempotent_replay ${where} originalRequestId=${reservation.requestId}`);
      return {
        answer: { status: reservation.status, body: reservation.body },
        replayed: true,
      };
    case 'started':
      break;
  }
  const { leaseId } = reservation;

  // The handler's own outcome is what the client gets, so neither of these may
  // replace it. If the answer cannot be stored the key stays leased, and a retry
  // runs the handler again once the lease is out, which is why a handler that
  // moves money needs a unique constraint of its own.
  const finish = async (done: Answer): Promise<void> => {
    try {
      const stored = await store.complete(tenant, {
        key,
        leaseId,
        status: done.status,
        requestId,
        body: done.body,
      });
      if (!stored) log(`event=idempotency_lease_lost ${where}`);
    } catch (error) {
      log(`event=idempotency_complete_failed ${where} error=${errorName(error)}`);
    }
  };
  const giveBack = async (): Promise<void> => {
    try {
      await store.release(tenant, { key, leaseId });
    } catch (error) {
      log(`event=idempotency_release_failed ${where} error=${errorName(error)}`);
    }
  };

  let done: Answer;
  try {
    done = await answer();
  } catch (error) {
    if (error instanceof ApiError && isFinalStatus(error.status)) {
      const body = JSON.stringify(envelope(error.code, error.message, requestId, error.details));
      await finish({ status: error.status, body });
    } else {
      await giveBack();
    }
    throw error;
  }
  await finish(done);
  return { answer: done, replayed: false };
}
