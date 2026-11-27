// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The audit log. Writing takes no sequence or hash: the database chains each row
// onto the principal's head, and refuses a metadata key the allowlist does not
// have (UJ012). The verifier asks the database to recompute every hash with the
// same function that wrote it, so the two cannot disagree.

import { sql, type Kysely } from 'kysely';

import type { Schema } from '../schema.js';
import { checkedLimit, pageOf, PageRequestError, type Page, type PageRequest } from './page.js';

type Tx = Kysely<Schema>;

const CURRENT_PRINCIPAL = sql<string>`ujira.current_principal_id()`;
const CURRENT_PROJECT = sql<string>`ujira.current_project_id()`;

// The fixed catalog: what can appear in the log at all. The check constraint on
// audit_log.action holds the same list, and audit-catalog.test.ts holds the two
// to each other. Adding an action takes a migration as well as a line here.
export const AUDIT_ACTIONS = Object.freeze([
  'session.signed_in',
  'session.signed_out',
  'session.stepped_up',
  'member.invited',
  'member.added',
  'member.removed',
  'member.role_changed',
  'api_key.created',
  'api_key.rotated',
  'api_key.revoked',
  'webhook.endpoint_created',
  'webhook.endpoint_updated',
  'webhook.endpoint_deleted',
  'webhook.secret_rotated',
  'export.requested',
  'export.downloaded',
  'identity.verification_started',
  'identity.verification_completed',
  'identity.verification_revoked',
  'identity.pii_viewed',
  'principal.created',
  'principal.reporting_time_zone_changed',
  'project.created',
  'project.routing_settings_changed',
  'project.payout_minimums_changed',
  'project.cashout_bearer_changed',
  'fee_terms.recorded',
] as const);
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export type AuditMetadata = Readonly<Record<string, string | number | boolean | null>>;

// An actor is the id of a member or a token, or the system, and never who they
// are.
export type AuditActor =
  { readonly kind: 'member' | 'token'; readonly id: string } | { readonly kind: 'system' };

export interface NewAuditEntry {
  readonly action: AuditAction;
  readonly actor: AuditActor;
  readonly metadata?: AuditMetadata;
}

export interface AuditEntry {
  readonly id: string;
  readonly seq: bigint;
  readonly projectId: string;
  readonly action: string;
  readonly actorKind: string;
  readonly actorId: string | null;
  readonly metadata: unknown;
  readonly occurredAt: Date;
}

// Under one project's scope the other projects' rows are out of sight, and their
// absence would read as tampering. Verifying needs db.principal().
export class AuditScopeError extends Error {
  override readonly name = 'AuditScopeError';

  constructor() {
    super('the audit chain can only be verified across every project of a principal');
  }
}

export type AuditChainBreak =
  // A row's content no longer gives the hash stored with it.
  | { readonly kind: 'row_altered'; readonly seq: bigint }
  // A row does not follow the one before it, or a sequence number is missing.
  | { readonly kind: 'link_broken'; readonly seq: bigint }
  // The head does not name the last row, so the newest rows are gone or replaced,
  // or a row exists past the head.
  | { readonly kind: 'head_mismatch'; readonly seq: bigint };

export interface AuditVerification {
  readonly rows: bigint;
  // The first break in chain order, or null when the chain is intact.
  readonly firstBreak: AuditChainBreak | null;
}

const entryColumns = [
  'id',
  'seq',
  'project_id',
  'action',
  'actor_kind',
  'actor_id',
  'metadata',
  'occurred_at',
] as const;

function toEntry(row: {
  id: string;
  seq: string;
  project_id: string;
  action: string;
  actor_kind: string;
  actor_id: string | null;
  metadata: unknown;
  occurred_at: Date;
}): AuditEntry {
  return {
    id: row.id,
    seq: BigInt(row.seq),
    projectId: row.project_id,
    action: row.action,
    actorKind: row.actor_kind,
    actorId: row.actor_id,
    metadata: row.metadata,
    occurredAt: row.occurred_at,
  };
}

const SEQ_KEY = /^\d{1,19}$/;
const GENESIS_HASH = Buffer.alloc(32);

function optionalSeq(value: string | null | undefined): bigint | null {
  return value === null || value === undefined ? null : BigInt(value);
}

function sameHash(left: Buffer | null | undefined, right: Buffer | null | undefined): boolean {
  if (left === null || left === undefined || right === null || right === undefined) {
    return (left ?? null) === null && (right ?? null) === null;
  }
  return left.equals(right);
}

export const audit = {
  // Appends to the principal's chain, in the transaction doing the work, so an
  // action and its audit row commit or roll back together.
  record: async (db: Tx, entry: NewAuditEntry): Promise<AuditEntry> => {
    const row = await db
      .insertInto('ujira.audit_log')
      .values({
        principal_id: CURRENT_PRINCIPAL,
        project_id: CURRENT_PROJECT,
        action: entry.action,
        actor_kind: entry.actor.kind,
        actor_id: entry.actor.kind === 'system' ? null : entry.actor.id,
        metadata: JSON.stringify(entry.metadata ?? {}),
        // audit_chain overwrites all three of these.
        seq: '0',
        prev_hash: GENESIS_HASH,
        row_hash: GENESIS_HASH,
      })
      .returning(entryColumns)
      .executeTakeFirstOrThrow();
    return toEntry(row);
  },

  // Newest first would suit a screen, but in sequence is what a reader of a chain
  // wants, and it pages cleanly.
  list: async (db: Tx, page: PageRequest): Promise<Page<AuditEntry>> => {
    const limit = checkedLimit(page.limit);
    let query = db
      .selectFrom('ujira.audit_log')
      .select(entryColumns)
      .orderBy('seq')
      .limit(limit + 1);
    if (page.after !== undefined) {
      if (!SEQ_KEY.test(page.after)) {
        throw new PageRequestError('after is not a key this list returned');
      }
      query = query.where('seq', '>', page.after);
    }
    return pageOf((await query.execute()).map(toEntry), limit, (entry) => entry.seq.toString());
  },

  // Walks the principal's whole chain in one statement, because one statement
  // sees one snapshot: a row appended part way through a walk in several would
  // read as a head that does not match. Only the answer comes back, so a long
  // chain costs the database time and the caller no memory.
  verify: async (db: Tx): Promise<AuditVerification> => {
    const scope = await sql<{ whole: boolean }>`
      select ujira.project_scope_all() as whole
    `.execute(db);
    if (scope.rows[0]?.whole !== true) throw new AuditScopeError();
    const result = await sql<{
      rows: string;
      first_altered: string | null;
      first_link_broken: string | null;
      last_seq: string | null;
      last_hash: Buffer | null;
      head_seq: string | null;
      head_hash: Buffer | null;
    }>`
      with walked as (
        select seq,
               row_hash::bytea as row_hash,
               row_hash::bytea is distinct from ujira.audit_row_hash(
                 prev_hash::bytea, principal_id, project_id, seq, action,
                 actor_kind, actor_id, metadata, occurred_at
               ) as altered,
               seq is distinct from 1 + coalesce(lag(seq) over w, 0)
                 or prev_hash::bytea is distinct from
                    coalesce(lag(row_hash::bytea) over w, ${GENESIS_HASH}::bytea) as link_broken
          from ujira.audit_log
        window w as (order by seq)
      ),
      summary as (
        select count(*) as rows,
               min(seq) filter (where altered) as first_altered,
               min(seq) filter (where link_broken) as first_link_broken,
               max(seq) as last_seq
          from walked
      )
      select summary.rows::text as rows,
             summary.first_altered::text as first_altered,
             summary.first_link_broken::text as first_link_broken,
             summary.last_seq::text as last_seq,
             (select w.row_hash from walked as w where w.seq = summary.last_seq) as last_hash,
             head.last_seq::text as head_seq,
             head.last_hash::bytea as head_hash
        from summary
        left join ujira.audit_heads as head on true
    `.execute(db);
    const row = result.rows[0];
    const rows = BigInt(row?.rows ?? '0');
    const altered = optionalSeq(row?.first_altered);
    const broken = optionalSeq(row?.first_link_broken);
    if (altered !== null && (broken === null || altered <= broken)) {
      return { rows, firstBreak: { kind: 'row_altered', seq: altered } };
    }
    if (broken !== null) return { rows, firstBreak: { kind: 'link_broken', seq: broken } };
    const headSeq = BigInt(row?.head_seq ?? '0');
    const lastSeq = BigInt(row?.last_seq ?? '0');
    if (headSeq !== lastSeq || !sameHash(row?.last_hash, row?.head_hash)) {
      return { rows, firstBreak: { kind: 'head_mismatch', seq: headSeq } };
    }
    return { rows, firstBreak: null };
  },
};

export const auditRepositories = { audit } as const;
