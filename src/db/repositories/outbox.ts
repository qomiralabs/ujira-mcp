// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The outbox and the webhook tables. An event is written in the transaction doing
// the work, so a rolled back change leaves no event, and one that commits always has
// one. As everywhere, no method takes a tenant id.

import { sql, type Kysely } from 'kysely';

import type { Schema } from '../schema.js';
import { checkedLimit, pageOf, type Page, type PageRequest } from './page.js';

type Tx = Kysely<Schema>;

const CURRENT_PRINCIPAL = sql<string>`ujira.current_principal_id()`;
const CURRENT_PROJECT = sql<string>`ujira.current_project_id()`;

export interface NewOutboxEvent {
  // Dotted lower case, such as `payout.held`.
  readonly eventType: string;
  // Exactly what a webhook will carry: ids and amounts, never personal data.
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface OutboxEvent {
  readonly id: string;
  readonly seq: bigint;
  readonly eventType: string;
  readonly payload: unknown;
  readonly createdAt: Date;
}

const eventColumns = ['id', 'seq', 'event_type', 'payload', 'created_at'] as const;

function toEvent(row: {
  id: string;
  seq: string;
  event_type: string;
  payload: unknown;
  created_at: Date;
}): OutboxEvent {
  return {
    id: row.id,
    seq: BigInt(row.seq),
    eventType: row.event_type,
    payload: row.payload,
    createdAt: row.created_at,
  };
}

export const outbox = {
  append: async (db: Tx, event: NewOutboxEvent): Promise<OutboxEvent> => {
    const row = await db
      .insertInto('ujira.outbox_events')
      .values({
        principal_id: CURRENT_PRINCIPAL,
        project_id: CURRENT_PROJECT,
        event_type: event.eventType,
        payload: JSON.stringify(event.payload),
      })
      .returning(eventColumns)
      .executeTakeFirstOrThrow();
    return toEvent(row);
  },

  // In seq order, and only as far as every transaction that could still commit a
  // lower seq has finished. Without that a reader can pass an event that is about
  // to commit and never see it. The price is that one long transaction anywhere on
  // the server holds new events back until it ends.
  after: async (db: Tx, afterSeq: bigint, limit: number): Promise<readonly OutboxEvent[]> => {
    const rows = await db
      .selectFrom('ujira.outbox_events')
      .select(eventColumns)
      .where('seq', '>', afterSeq.toString())
      .where(sql<boolean>`tx_id < pg_snapshot_xmin(pg_current_snapshot())`)
      .orderBy('seq')
      .limit(checkedLimit(limit))
      .execute();
    return rows.map(toEvent);
  },
};

export type WebhookEndpointStatus = 'enabled' | 'disabled';

export interface NewWebhookEndpoint {
  readonly url: string;
  // Where the secret manager holds the signing secret, never the secret.
  readonly secretRef: string;
  readonly eventTypes: readonly string[];
}

export interface WebhookEndpoint {
  readonly id: string;
  readonly url: string;
  readonly secretRef: string;
  readonly eventTypes: readonly string[];
  readonly status: string;
  readonly createdAt: Date;
}

const endpointColumns = ['id', 'url', 'secret_ref', 'event_types', 'status', 'created_at'] as const;

function toEndpoint(row: {
  id: string;
  url: string;
  secret_ref: string;
  event_types: string[];
  status: string;
  created_at: Date;
}): WebhookEndpoint {
  return {
    id: row.id,
    url: row.url,
    secretRef: row.secret_ref,
    eventTypes: row.event_types,
    status: row.status,
    createdAt: row.created_at,
  };
}

export const webhookEndpoints = {
  create: async (db: Tx, input: NewWebhookEndpoint): Promise<WebhookEndpoint> => {
    const row = await db
      .insertInto('ujira.webhook_endpoints')
      .values({
        principal_id: CURRENT_PRINCIPAL,
        project_id: CURRENT_PROJECT,
        url: input.url,
        secret_ref: input.secretRef,
        event_types: [...input.eventTypes],
      })
      .returning(endpointColumns)
      .executeTakeFirstOrThrow();
    return toEndpoint(row);
  },

  get: async (db: Tx, id: string): Promise<WebhookEndpoint | undefined> => {
    const row = await db
      .selectFrom('ujira.webhook_endpoints')
      .select(endpointColumns)
      .where('id', '=', id)
      .executeTakeFirst();
    return row === undefined ? undefined : toEndpoint(row);
  },

  list: async (db: Tx, page: PageRequest): Promise<Page<WebhookEndpoint>> => {
    const limit = checkedLimit(page.limit);
    let query = db
      .selectFrom('ujira.webhook_endpoints')
      .select(endpointColumns)
      .orderBy('id')
      .limit(limit + 1);
    if (page.after !== undefined) query = query.where('id', '>', page.after);
    return pageOf((await query.execute()).map(toEndpoint), limit, (endpoint) => endpoint.id);
  },

  setStatus: async (db: Tx, id: string, status: WebhookEndpointStatus): Promise<boolean> => {
    const result = await db
      .updateTable('ujira.webhook_endpoints')
      .set({ status })
      .where('id', '=', id)
      .executeTakeFirst();
    return result.numUpdatedRows > 0n;
  },
};

export type WebhookDeliveryStatus = 'succeeded' | 'failed' | 'dead_letter';

export interface NewWebhookDelivery {
  readonly endpointId: string;
  readonly eventId: string;
  readonly attempt: number;
  readonly status: WebhookDeliveryStatus;
  readonly responseStatus?: number | null;
  // A short code of ours. Never the receiver's response body.
  readonly errorCode?: string | null;
}

export interface WebhookDelivery {
  readonly id: string;
  readonly endpointId: string;
  readonly eventId: string;
  readonly attempt: number;
  readonly status: string;
  readonly responseStatus: number | null;
  readonly errorCode: string | null;
  readonly createdAt: Date;
}

interface DeliveryRow {
  id: string;
  endpoint_id: string;
  event_id: string;
  // bigint columns, which pg hands back as text. Both are bounded by the table's
  // checks, so the conversion below is exact.
  attempt: string;
  status: string;
  response_status: string | null;
  error_code: string | null;
  created_at: Date;
}

function toDelivery(row: DeliveryRow): WebhookDelivery {
  return {
    id: row.id,
    endpointId: row.endpoint_id,
    eventId: row.event_id,
    attempt: Number.parseInt(row.attempt, 10),
    status: row.status,
    responseStatus: row.response_status === null ? null : Number.parseInt(row.response_status, 10),
    errorCode: row.error_code,
    createdAt: row.created_at,
  };
}

export const webhookDeliveries = {
  // One row per attempt. Undefined when this attempt is already recorded, or when
  // the event is not one this tenant can see. The event's own time comes from the
  // event, so a delivery ages with it and retention can remove them together.
  record: async (db: Tx, input: NewWebhookDelivery): Promise<WebhookDelivery | undefined> => {
    const result = await sql<DeliveryRow>`
      insert into ujira.webhook_deliveries (
        principal_id, project_id, endpoint_id, event_id, event_created_at,
        attempt, status, response_status, error_code
      )
      select ujira.current_principal_id(), ujira.current_project_id(), ${input.endpointId}::uuid,
             e.id, e.created_at, ${input.attempt}::bigint, ${input.status},
             ${input.responseStatus ?? null}::bigint, ${input.errorCode ?? null}
        from ujira.outbox_events as e
       where e.id = ${input.eventId}::uuid
      on conflict (principal_id, project_id, endpoint_id, event_id, attempt) do nothing
      returning id, endpoint_id, event_id, attempt, status, response_status, error_code, created_at
    `.execute(db);
    const [row] = result.rows;
    return row === undefined ? undefined : toDelivery(row);
  },

  forEvent: async (
    db: Tx,
    endpointId: string,
    eventId: string,
  ): Promise<readonly WebhookDelivery[]> => {
    const rows = await db
      .selectFrom('ujira.webhook_deliveries')
      .select([
        'id',
        'endpoint_id',
        'event_id',
        'attempt',
        'status',
        'response_status',
        'error_code',
        'created_at',
      ])
      .where('endpoint_id', '=', endpointId)
      .where('event_id', '=', eventId)
      .orderBy('attempt')
      .execute();
    return rows.map(toDelivery);
  },
};

export const outboxRepositories = { outbox, webhookEndpoints, webhookDeliveries } as const;
