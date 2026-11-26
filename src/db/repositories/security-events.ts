// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The app's only way into ops.security_events: a narrow function that runs as
// ujira_ops, called inside db.unscoped(), since an event belongs to no tenant.
// The rows hold no tenant data, so they sit outside the cross-tenant matrix;
// the ops catalog check is what keeps that true.

import { sql, type Kysely } from 'kysely';

import type { Schema } from '../schema.js';

type Tx = Kysely<Schema>;

// The kinds the table's check accepts, held to it by security-events.test.ts.
export const SECURITY_EVENT_KINDS = Object.freeze([
  'sign_in_failed',
  'otp_failed',
  'mfa_failed',
  'token_invalid',
  'token_env_mismatch',
  'csrf_failed',
  'callback_signature_invalid',
  'unresolved_identity_event',
] as const);
export type SecurityEventKind = (typeof SECURITY_EVENT_KINDS)[number];

export interface NewSecurityEvent {
  readonly kind: SecurityEventKind;
  // HMAC-SHA-256 under a key the caller holds, never the value itself: the table
  // refuses anything that is not 32 bytes.
  readonly emailHmac?: Buffer;
  readonly ipHmac?: Buffer;
  // The public part of a key, never the key.
  readonly tokenPrefix?: string;
}

export const securityEvents = {
  record: async (db: Tx, event: NewSecurityEvent): Promise<void> => {
    await sql`
      select ops.record_security_event(
        ${event.kind},
        ${event.emailHmac ?? null}::bytea,
        ${event.tokenPrefix ?? null}::text,
        ${event.ipHmac ?? null}::bytea
      )
    `.execute(db);
  },
};
