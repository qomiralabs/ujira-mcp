// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// Request bodies on /v1 are JSON and small. The size is checked twice: once
// on the declared length, so a large upload is refused before a byte of it
// is read, and again while reading, because a chunked body declares nothing.

import type { MiddlewareHandler } from 'hono';

import { ApiError } from './errors.js';

export const MAX_BODY_BYTES = 64 * 1024;

/** application/json, with or without parameters such as charset. */
export function isJsonMediaType(contentType: string | undefined | null): boolean {
  if (contentType === undefined || contentType === null) return false;
  const type = contentType.split(';')[0]?.trim().toLowerCase();
  return type === 'application/json';
}

/** Whether the request says it carries a body at all. */
function hasBody(headers: Headers): boolean {
  if (headers.has('transfer-encoding')) return true;
  const length = headers.get('content-length');
  return length !== null && length.trim() !== '0';
}

function tooLarge(): ApiError {
  return new ApiError(
    'PAYLOAD_TOO_LARGE',
    `The request body is larger than ${MAX_BODY_BYTES} bytes`,
  );
}

/**
 * Refuses an oversized or non JSON body for every /v1 route, including ones
 * that take no body, so a route cannot forget to.
 */
export function bodyGuard(limit: number = MAX_BODY_BYTES): MiddlewareHandler {
  return async (c, next) => {
    const headers = c.req.raw.headers;
    if (!hasBody(headers)) {
      await next();
      return;
    }
    const declared = headers.get('content-length');
    if (declared !== null && !headers.has('transfer-encoding')) {
      if (!/^\d+$/.test(declared.trim())) {
        throw new ApiError('INVALID_REQUEST', 'The Content-Length header is not a number');
      }
      if (BigInt(declared.trim()) > BigInt(limit)) throw tooLarge();
    }
    if (!isJsonMediaType(headers.get('content-type'))) {
      throw new ApiError('UNSUPPORTED_MEDIA_TYPE', 'Request bodies must be application/json');
    }
    await next();
  };
}

/** Reads the whole body as bytes, refusing it as soon as it passes the limit. */
export async function readBodyBytes(
  request: Request,
  limit: number = MAX_BODY_BYTES,
): Promise<Buffer> {
  const stream = request.body;
  if (stream === null) return Buffer.alloc(0);
  // Typed loosely by the platform; a request body stream yields bytes.
  const reader = (stream as ReadableStream<Uint8Array>).getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw tooLarge();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, size);
}

/** Reads the whole body as UTF-8 text, refusing it as soon as it passes the limit. */
export async function readBodyText(
  request: Request,
  limit: number = MAX_BODY_BYTES,
): Promise<string> {
  return (await readBodyBytes(request, limit)).toString('utf8');
}

/** The body as parsed JSON. An empty body is a missing body, not an empty object. */
export async function readJsonBody(
  request: Request,
  limit: number = MAX_BODY_BYTES,
): Promise<unknown> {
  return parseJsonText(await readBodyText(request, limit));
}

/** Text already read from a body, as parsed JSON, with the same refusals as readJsonBody. */
export function parseJsonText(text: string): unknown {
  if (text.trim() === '') {
    throw new ApiError('INVALID_REQUEST', 'This route needs a JSON body', {
      details: [{ path: 'body', issue: 'required' }],
    });
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ApiError('INVALID_REQUEST', 'The request body is not valid JSON', {
      details: [{ path: 'body', issue: 'invalid_json' }],
    });
  }
}
