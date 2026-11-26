// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// Page cursors for list routes. A cursor is opaque to clients but not
// secret: it only says where the last page ended. It is not signed because
// every list query is already scoped to the caller's tenant, so a forged
// cursor can move within the caller's own rows and nowhere else. What comes
// back in is still parsed against the route's schema, so a tampered cursor
// is a 400, never a query built from arbitrary input.

import { z } from 'zod';

import { ApiError, validationDetails } from './errors.js';

/** Long enough for a timestamp and a uuid with room to spare, short enough to bound the decode. */
export const MAX_CURSOR_LENGTH = 512;

export type CursorValue = Readonly<Record<string, string | number | boolean | null>>;

export function encodeCursor(value: CursorValue): string {
  const encoded = Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
  if (encoded.length > MAX_CURSOR_LENGTH) throw new Error('cursor is longer than the limit');
  return encoded;
}

function invalid(issue: string): ApiError {
  return new ApiError('INVALID_REQUEST', 'The cursor is not one this API issued', {
    details: [{ path: 'query.cursor', issue }],
  });
}

export function decodeCursor<T extends z.ZodType>(raw: string, schema: T): z.output<T> {
  if (raw.length === 0 || raw.length > MAX_CURSOR_LENGTH || !/^[A-Za-z0-9_-]+$/.test(raw)) {
    throw invalid('invalid_format');
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as unknown;
  } catch {
    throw invalid('invalid_format');
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new ApiError('INVALID_REQUEST', 'The cursor is not one this API issued', {
      details: validationDetails(parsed.error, 'query.cursor'),
    });
  }
  return parsed.data;
}
