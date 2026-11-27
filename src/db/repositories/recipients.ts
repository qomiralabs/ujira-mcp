// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The people a mandate pays, their one optional piece of personal data, and the
// destinations they are paid at. As everywhere, no method takes a tenant id.

import { sql, type Kysely } from 'kysely';

import type { Schema } from '../schema.js';
import { checkedLimit, pageOf, PageRequestError, type Page, type PageRequest } from './page.js';
import { bytesHex32, hex32Bytes, type AccountParser } from './values.js';

type Tx = Kysely<Schema>;

const CURRENT_PRINCIPAL = sql<string>`ujira.current_principal_id()`;
const CURRENT_PROJECT = sql<string>`ujira.current_project_id()`;

export type RecipientStatus = 'active' | 'suspended';

export interface Recipient {
  readonly id: string;
  readonly projectId: string;
  readonly mandateId: string;
  readonly label: string;
  // The hash the chain knows the person by, as 64 lowercase hex digits.
  readonly recipientRef: string;
  readonly status: RecipientStatus;
  readonly createdAt: Date;
}

export interface NewRecipient {
  readonly mandateId: string;
  readonly label: string;
  readonly recipientRef: string;
}

const RECIPIENT_STATUSES: ReadonlySet<string> = new Set<RecipientStatus>(['active', 'suspended']);

// The column check makes this unreachable unless the two lists drift apart.
function recipientStatus(value: string): RecipientStatus {
  if (!RECIPIENT_STATUSES.has(value)) {
    throw new Error('a recipient row holds a status this code does not know');
  }
  return value as RecipientStatus;
}

const recipientColumns = [
  'id',
  'project_id',
  'mandate_id',
  'label',
  'recipient_ref',
  'status',
  'created_at',
] as const;

function toRecipient(row: {
  id: string;
  project_id: string;
  mandate_id: string;
  label: string;
  recipient_ref: Buffer;
  status: string;
  created_at: Date;
}): Recipient {
  return {
    id: row.id,
    projectId: row.project_id,
    mandateId: row.mandate_id,
    label: row.label,
    recipientRef: bytesHex32(row.recipient_ref),
    status: recipientStatus(row.status),
    createdAt: row.created_at,
  };
}

export const recipients = {
  // A label already on the mandate, in any case, is refused, 23505, and so is
  // a recipient ref already on it. A mandate outside the transaction's project
  // fails its key, 23503.
  create: async (db: Tx, input: NewRecipient): Promise<Recipient> => {
    const row = await db
      .insertInto('ujira.recipients')
      .values({
        principal_id: CURRENT_PRINCIPAL,
        project_id: CURRENT_PROJECT,
        mandate_id: input.mandateId,
        label: input.label,
        recipient_ref: hex32Bytes(input.recipientRef, 'recipientRef'),
      })
      .returning(recipientColumns)
      .executeTakeFirstOrThrow();
    return toRecipient(row);
  },

  get: async (db: Tx, id: string): Promise<Recipient | undefined> => {
    const row = await db
      .selectFrom('ujira.recipients')
      .select(recipientColumns)
      .where('id', '=', id)
      .executeTakeFirst();
    return row === undefined ? undefined : toRecipient(row);
  },

  // Every recipient of the transaction's project, whichever mandate, in key order.
  listInProject: async (db: Tx, page: PageRequest): Promise<Page<Recipient>> => {
    const limit = checkedLimit(page.limit);
    let query = db
      .selectFrom('ujira.recipients')
      .select(recipientColumns)
      .orderBy('id')
      .limit(limit + 1);
    if (page.after !== undefined) query = query.where('id', '>', page.after);
    return pageOf((await query.execute()).map(toRecipient), limit, (recipient) => recipient.id);
  },

  // One mandate's recipients, in key order.
  list: async (db: Tx, mandateId: string, page: PageRequest): Promise<Page<Recipient>> => {
    const limit = checkedLimit(page.limit);
    let query = db
      .selectFrom('ujira.recipients')
      .select(recipientColumns)
      .where('mandate_id', '=', mandateId)
      .orderBy('id')
      .limit(limit + 1);
    if (page.after !== undefined) query = query.where('id', '>', page.after);
    return pageOf((await query.execute()).map(toRecipient), limit, (recipient) => recipient.id);
  },

  // How an agent names someone. Case does not matter, as it does not for the
  // uniqueness of labels.
  findByLabel: async (db: Tx, mandateId: string, label: string): Promise<Recipient | undefined> => {
    const row = await db
      .selectFrom('ujira.recipients')
      .select(recipientColumns)
      .where('mandate_id', '=', mandateId)
      .where(sql<string>`lower(label)`, '=', sql<string>`lower(${label}::text)`)
      .executeTakeFirst();
    return row === undefined ? undefined : toRecipient(row);
  },

  // True when the recipient was found and moved. A move the status machine
  // does not allow is refused, UJ004.
  setStatus: async (db: Tx, id: string, status: RecipientStatus): Promise<boolean> => {
    const result = await db
      .updateTable('ujira.recipients')
      .set({ status })
      .where('id', '=', id)
      .executeTakeFirst();
    return result.numUpdatedRows > 0n;
  },
};

// Sealed by the key module under the project's key, as an agent secret is.
export interface SealedEmail {
  readonly ciphertext: Buffer;
  readonly nonce: Buffer;
}

export const recipientPii = {
  // Writes or replaces the recipient's email. A recipient outside the
  // transaction's project fails its key, 23503.
  setEmail: async (db: Tx, recipientId: string, email: SealedEmail): Promise<void> => {
    await db
      .insertInto('ujira.recipient_pii')
      .values({
        principal_id: CURRENT_PRINCIPAL,
        project_id: CURRENT_PROJECT,
        recipient_id: recipientId,
        email_ciphertext: email.ciphertext,
        email_nonce: email.nonce,
      })
      .onConflict((conflict) =>
        conflict.columns(['principal_id', 'project_id', 'recipient_id']).doUpdateSet((eb) => ({
          email_ciphertext: eb.ref('excluded.email_ciphertext'),
          email_nonce: eb.ref('excluded.email_nonce'),
        })),
      )
      .execute();
  },

  email: async (db: Tx, recipientId: string): Promise<SealedEmail | undefined> => {
    const row = await db
      .selectFrom('ujira.recipient_pii')
      .select(['email_ciphertext', 'email_nonce'])
      .where('recipient_id', '=', recipientId)
      .executeTakeFirst();
    return row === undefined
      ? undefined
      : { ciphertext: row.email_ciphertext, nonce: row.email_nonce };
  },
};

export type PayoutMethodKind = 'stellar_wallet';

// What the chain last said about a destination. Only receivable can be paid.
// unchecked is a row stored before destinations were checked on the way in.
export type DestinationStatus = 'unchecked' | 'receivable' | 'no_account' | 'no_trustline';

export interface PayoutMethod {
  readonly id: string;
  readonly projectId: string;
  readonly recipientId: string;
  readonly method: PayoutMethodKind;
  readonly destination: string;
  // When the recipient proved they control the destination, or null.
  readonly verifiedAt: Date | null;
  readonly destinationStatus: DestinationStatus;
  // When the status was read from the chain; null only while unchecked.
  readonly checkedAt: Date | null;
  readonly createdAt: Date;
}

// The shape of the chain adapter's checkDestination answer.
export type DestinationCheck =
  | { readonly receivable: true }
  | { readonly receivable: false; readonly reason: 'NO_ACCOUNT' | 'NO_TRUSTLINE' | 'NEEDS_MEMO' };

// A destination that needs a memo never gets a row, so it has no status.
export type StorableCheck =
  | { readonly receivable: true }
  | { readonly receivable: false; readonly reason: 'NO_ACCOUNT' | 'NO_TRUSTLINE' };

function statusOfCheck(check: StorableCheck): Exclude<DestinationStatus, 'unchecked'> {
  if (check.receivable) return 'receivable';
  return check.reason === 'NO_ACCOUNT' ? 'no_account' : 'no_trustline';
}

const DESTINATION_STATUSES: ReadonlySet<string> = new Set<DestinationStatus>([
  'unchecked',
  'receivable',
  'no_account',
  'no_trustline',
]);

function destinationStatus(value: string): DestinationStatus {
  if (!DESTINATION_STATUSES.has(value)) {
    throw new Error('a payout method row holds a destination status this code does not know');
  }
  return value as DestinationStatus;
}

export interface NewWalletMethod {
  readonly recipientId: string;
  readonly destination: string;
  // What checkDestination said about this destination just before.
  readonly destinationCheck: DestinationCheck;
  // True when the recipient has just proved control of the destination.
  readonly verified: boolean;
}

export type PayoutMethodRefusal = 'DESTINATION_NEEDS_MEMO';

export class PayoutMethodRefusedError extends Error {
  override readonly name = 'PayoutMethodRefusedError';

  constructor(readonly code: PayoutMethodRefusal) {
    super('the wallet rail sends no memo, and this destination requires one');
  }
}

function storable(check: DestinationCheck): StorableCheck {
  if (check.receivable) return check;
  if (check.reason === 'NEEDS_MEMO') throw new PayoutMethodRefusedError('DESTINATION_NEEDS_MEMO');
  return { receivable: false, reason: check.reason };
}

const METHODS: ReadonlySet<string> = new Set<PayoutMethodKind>(['stellar_wallet']);

function payoutMethodKind(value: string): PayoutMethodKind {
  if (!METHODS.has(value))
    throw new Error('a payout method row holds a method this code does not know');
  return value as PayoutMethodKind;
}

const methodColumns = [
  'id',
  'project_id',
  'recipient_id',
  'method',
  'destination_address',
  'verified_at',
  'destination_status',
  'destination_checked_at',
  'created_at',
] as const;

function toPayoutMethod(row: {
  id: string;
  project_id: string;
  recipient_id: string;
  method: string;
  destination_address: string;
  verified_at: Date | null;
  destination_status: string;
  destination_checked_at: Date | null;
  created_at: Date;
}): PayoutMethod {
  return {
    id: row.id,
    projectId: row.project_id,
    recipientId: row.recipient_id,
    method: payoutMethodKind(row.method),
    destination: row.destination_address,
    verifiedAt: row.verified_at,
    destinationStatus: destinationStatus(row.destination_status),
    checkedAt: row.destination_checked_at,
    createdAt: row.created_at,
  };
}

// The most a single read asks for by id, the size of the largest page.
const MAX_RECIPIENTS_PER_READ = 100;

export const payoutMethods = {
  // A destination that needs a memo is refused here, before any row, because
  // money sent to it without one is money its owner cannot place. One with no
  // account or no trustline yet is kept: the recipient can fix that, and the
  // payout checks again before it is requested. The same destination twice for
  // one recipient is refused, 23505, and a recipient outside the transaction's
  // project fails its key, 23503.
  addWallet: async (
    db: Tx,
    input: NewWalletMethod,
    accounts: AccountParser,
  ): Promise<PayoutMethod> => {
    const destination = accounts.parseAccount(input.destination);
    const check = storable(input.destinationCheck);
    const row = await db
      .insertInto('ujira.payout_methods')
      .values({
        principal_id: CURRENT_PRINCIPAL,
        project_id: CURRENT_PROJECT,
        recipient_id: input.recipientId,
        method: 'stellar_wallet',
        destination_address: destination,
        verified_at: input.verified ? sql<Date>`now()` : null,
        destination_status: statusOfCheck(check),
        destination_checked_at: sql<Date>`now()`,
      })
      .returning(methodColumns)
      .executeTakeFirstOrThrow();
    return toPayoutMethod(row);
  },

  get: async (db: Tx, id: string): Promise<PayoutMethod | undefined> => {
    const row = await db
      .selectFrom('ujira.payout_methods')
      .select(methodColumns)
      .where('id', '=', id)
      .executeTakeFirst();
    return row === undefined ? undefined : toPayoutMethod(row);
  },

  // One recipient's methods, in key order.
  list: async (db: Tx, recipientId: string, page: PageRequest): Promise<Page<PayoutMethod>> => {
    const limit = checkedLimit(page.limit);
    let query = db
      .selectFrom('ujira.payout_methods')
      .select(methodColumns)
      .where('recipient_id', '=', recipientId)
      .orderBy('id')
      .limit(limit + 1);
    if (page.after !== undefined) query = query.where('id', '>', page.after);
    return pageOf((await query.execute()).map(toPayoutMethod), limit, (method) => method.id);
  },

  // The methods of several recipients at once, oldest first, so a page of
  // recipients costs one query for its destinations rather than one per row.
  forRecipients: async (db: Tx, recipientIds: readonly string[]): Promise<PayoutMethod[]> => {
    if (recipientIds.length === 0) return [];
    if (recipientIds.length > MAX_RECIPIENTS_PER_READ) {
      throw new PageRequestError(
        `ask for at most ${String(MAX_RECIPIENTS_PER_READ)} recipients at a time`,
      );
    }
    const rows = await db
      .selectFrom('ujira.payout_methods')
      .select(methodColumns)
      .where('recipient_id', 'in', [...recipientIds])
      .orderBy('created_at')
      .orderBy('id')
      .execute();
    return rows.map(toPayoutMethod);
  },

  // What the chain says about the destination now. True when the method was
  // found. A destination that has come to need a memo cannot be stored as
  // payable, so the caller decides what to do with it before calling.
  recordCheck: async (db: Tx, id: string, check: StorableCheck): Promise<boolean> => {
    const result = await db
      .updateTable('ujira.payout_methods')
      .set({ destination_status: statusOfCheck(check), destination_checked_at: sql<Date>`now()` })
      .where('id', '=', id)
      .executeTakeFirst();
    return result.numUpdatedRows > 0n;
  },

  // True when this call recorded the proof. A method already verified keeps its
  // first time, so a second call changes nothing and says so.
  markVerified: async (db: Tx, id: string): Promise<boolean> => {
    const result = await db
      .updateTable('ujira.payout_methods')
      .set({ verified_at: sql<Date>`now()` })
      .where('id', '=', id)
      .where('verified_at', 'is', null)
      .executeTakeFirst();
    return result.numUpdatedRows > 0n;
  },
};

// For the cross-tenant matrix, which requires a case for each method here.
export const recipientRepositories = { recipients, recipientPii, payoutMethods } as const;
