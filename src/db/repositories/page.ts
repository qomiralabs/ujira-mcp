// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// Keyset pages: a page is the rows after a key, never an offset, so a page
// costs the same at row ten million as at row ten and a row inserted
// meanwhile cannot shift what the next page returns.

export const MAX_PAGE_SIZE = 100;

export interface PageRequest {
  readonly limit: number;
  // The key of the last row of the previous page.
  readonly after?: string;
}

export interface Page<T> {
  readonly items: readonly T[];
  // The key to pass as `after` for the next page, or null when this was the
  // last one.
  readonly next: string | null;
}

export class PageRequestError extends Error {
  override readonly name = 'PageRequestError';
}

export function checkedLimit(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
    throw new PageRequestError(`limit must be a whole number from 1 to ${String(MAX_PAGE_SIZE)}`);
  }
  return limit;
}

// Rows are fetched one past the limit, so whether a next page exists is
// known without a second query.
export function pageOf<T>(rows: readonly T[], limit: number, keyOf: (row: T) => string): Page<T> {
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  return { items, next: rows.length > limit && last !== undefined ? keyOf(last) : null };
}
