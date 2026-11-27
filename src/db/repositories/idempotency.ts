// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The records behind the Idempotency-Key header. Each method runs inside a
// transaction that db.tenant() opened and takes no tenant id: a new row takes its
// tenant from that context, and the unique constraint includes it, so one
// project's key can never meet another's.

import { randomUUID } from 'node:crypto';

import { sql, type Kysely } from 'kysely';

import type { Schema } from '../schema.js';

type Tx = Kysely<Schema>;

const REPLAY_WINDOW = sql<Date>`now() + interval '7 days'`;

export interface NewReservation {
  readonly key: string;
  readonly requestSha256: Buffer;
  // How long this attempt holds the key if it never reports back.
  readonly leaseSeconds: number;
}

export type Reservation =
  // This attempt holds the key, and must finish or release it with this lease.
  | { readonly kind: 'started'; readonly leaseId: string }
  // Another attempt holds the key and its lease has not run out.
  | { readonly kind: 'in_progress' }
  // The key has been used for a different request.
  | { readonly kind: 'mismatch' }
  // The answer to give, exactly as it was first given.
  | {
      readonly kind: 'replay';
      readonly status: number;
      readonly requestId: string;
      readonly body: string;
    };

export interface FinishedRequest {
  readonly key: string;
  readonly leaseId: string;
  readonly status: number;
  readonly requestId: string;
  readonly body: string;
}

export const idempotencyKeys = {
  // Wins the key or says why not, in one statement, so two attempts racing for
  // it are decided by the unique constraint and not by which read came first. An
  // existing row is taken over only when its window has passed, or when its lease
  // ran out or was released and this is the same request.
  reserve: async (db: Tx, input: NewReservation): Promise<Reservation> => {
    const leaseId = randomUUID();
    const won = await sql<{ lease_id: string }>`
      insert into ujira.idempotency_keys as k (
        principal_id, project_id, idempotency_key, request_sha256,
        lease_id, lease_expires_at, expires_at
      ) values (
        ujira.current_principal_id(),
        ujira.current_project_id(),
        ${input.key},
        ${input.requestSha256},
        ${leaseId},
        now() + make_interval(secs => ${input.leaseSeconds}),
        ${REPLAY_WINDOW}
      )
      on conflict on constraint idempotency_keys_tenant_key do update
        set request_sha256 = excluded.request_sha256,
            lease_id = excluded.lease_id,
            lease_expires_at = excluded.lease_expires_at,
            expires_at = excluded.expires_at,
            request_id = null,
            response_status = null,
            response_body = null,
            created_at = now()
        where k.expires_at <= now()
           or (
             k.lease_id is not null
             and k.lease_expires_at <= now()
             and k.request_sha256 = excluded.request_sha256
           )
      returning k.lease_id
    `.execute(db);
    if (won.rows.length > 0) return { kind: 'started', leaseId };

    const held = await db
      .selectFrom('ujira.idempotency_keys')
      .select(['request_sha256', 'request_id', 'response_status', 'response_body'])
      .where('idempotency_key', '=', input.key)
      .executeTakeFirstOrThrow();
    if (!held.request_sha256.equals(input.requestSha256)) return { kind: 'mismatch' };
    if (held.response_status === null || held.response_body === null || held.request_id === null) {
      return { kind: 'in_progress' };
    }
    return {
      kind: 'replay',
      // A status, between 200 and 499 by the table's check, so it is exact.
      status: Number.parseInt(held.response_status, 10),
      requestId: held.request_id,
      body: held.response_body,
    };
  },

  // Stores the answer. False when this attempt no longer holds the key, because
  // its lease ran out and a retry took over, whose answer then stands.
  complete: async (db: Tx, input: FinishedRequest): Promise<boolean> => {
    const result = await db
      .updateTable('ujira.idempotency_keys')
      .set({
        lease_id: null,
        lease_expires_at: null,
        request_id: input.requestId,
        response_status: input.status,
        response_body: input.body,
      })
      .where('idempotency_key', '=', input.key)
      .where('lease_id', '=', input.leaseId)
      .executeTakeFirst();
    return result.numUpdatedRows > 0n;
  },

  // Gives the key back after a failure worth retrying, so the retry runs at once
  // rather than waiting out the lease. False when this attempt no longer holds it.
  release: async (
    db: Tx,
    input: { readonly key: string; readonly leaseId: string },
  ): Promise<boolean> => {
    const result = await db
      .updateTable('ujira.idempotency_keys')
      .set({ lease_expires_at: sql<Date>`now()` })
      .where('idempotency_key', '=', input.key)
      .where('lease_id', '=', input.leaseId)
      .executeTakeFirst();
    return result.numUpdatedRows > 0n;
  },
};

// For the cross-tenant matrix, which requires a case for each method listed here.
export const idempotencyRepositories = { idempotencyKeys } as const;
