// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// Keyset pages newest first, for the money tables people read as a history.
// The key is the row's creation time to the microsecond, as the database
// writes it, and its id to break ties between rows of one transaction. A Date
// holds milliseconds only, so the time travels as the database's own text and
// is never rounded on the way back in.

import { sql, type RawBuilder, type SqlBool } from 'kysely';

import { PageRequestError } from './page.js';

const KEY =
  /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z)\|([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

// Selected beside each row, as page_time, to build its key.
export const PAGE_TIME = sql<string>`to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

export function pageKey(row: { readonly page_time: string; readonly id: string }): string {
  return `${row.page_time}|${row.id}`;
}

// The rows older than the key, for a query ordered by created_at desc, id desc.
export function olderThan(after: string): RawBuilder<SqlBool> {
  const match = KEY.exec(after);
  const time = match?.[1];
  const id = match?.[2];
  if (time === undefined || id === undefined) {
    throw new PageRequestError('after is not a key this list returned');
  }
  return sql<SqlBool>`(created_at, id) < (${time}::timestamptz, ${id}::uuid)`;
}
