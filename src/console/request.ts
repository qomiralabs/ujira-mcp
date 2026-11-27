// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// What every console API route does with a request before its own work:
// read a bounded JSON body, check it against a strict schema, and count the
// caller against a rate limit. Shared so routes added from outside the
// console answer in the same shape.

import type { IncomingMessage } from 'node:http';

import type { z } from 'zod';

import { BodyTooLarge, readBody } from '../mcp/http.js';
import type { WindowLimiter } from '../mcp/public.js';
import { ApiError } from './errors.js';
import { issues } from './txbuild.js';

/** The request body as JSON, `{}` when empty. */
export async function jsonBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  let raw: Buffer;
  try {
    raw = await readBody(req, maxBytes);
  } catch (error) {
    if (!(error instanceof BodyTooLarge)) throw error;
    req.resume();
    throw new ApiError(413, 'body_too_large', 'The request body is too large');
  }
  if (raw.length === 0) return {};
  try {
    return JSON.parse(raw.toString('utf8')) as unknown;
  } catch {
    throw new ApiError(400, 'invalid_json', 'The request body is not valid JSON');
  }
}

export function parse<T extends z.ZodType>(schema: T, raw: unknown): z.output<T> {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new ApiError(400, 'invalid_request', `The request was refused: ${issues(parsed.error)}`);
  }
  return parsed.data;
}

/** Counts one hit, or refuses with how long to wait. `what` names the thing counted. */
export function take(limiter: WindowLimiter, key: string, what: string): void {
  const hit = limiter.take(key);
  if (!hit.ok) {
    const minutes = Math.max(1, Math.ceil(hit.retryAfterMs / 60_000));
    throw new ApiError(429, 'rate_limited', `Too many ${what}; try again in ${minutes} minutes`, {
      retryAfterSeconds: Math.max(1, Math.ceil(hit.retryAfterMs / 1000)),
    });
  }
}
