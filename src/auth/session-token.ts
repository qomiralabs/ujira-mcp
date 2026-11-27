// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The secret a dashboard session is held by. The browser keeps it in an
// HttpOnly cookie and the database keeps only its SHA-256, so a copy of the
// database cannot be replayed as anyone's session.

import { createHash, randomBytes } from 'node:crypto';

export const SESSION_COOKIE = 'ujira_session';

/** Only the API reads the cookie, so it is never sent with a page or an asset. */
export const SESSION_COOKIE_PATH = '/v1';

const TOKEN_BYTES = 32;
const TOKEN_TEXT = /^[A-Za-z0-9_-]{43}$/;

/** 32 random bytes, base64url without padding: 43 characters. */
export function newSessionToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

/**
 * The SHA-256 the session row is found by, or undefined for anything that is
 * not a token this server could have issued. Only the canonical encoding is
 * accepted, so two cookie values never name one session.
 */
export function sessionTokenHash(token: string): Buffer | undefined {
  if (!TOKEN_TEXT.test(token)) return undefined;
  const bytes = Buffer.from(token, 'base64url');
  if (bytes.length !== TOKEN_BYTES || bytes.toString('base64url') !== token) return undefined;
  return createHash('sha256').update(bytes).digest();
}
