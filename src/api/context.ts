// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

import type { Context } from 'hono';

export const REQUEST_ID_HEADER = 'Ujira-Request-Id';

/**
 * What the Node server knows about a request before /v1 sees it. Both are
 * optional so the app also runs on its own, as in unit tests, where it makes
 * its own request id.
 */
export interface V1Bindings {
  readonly requestId?: string;
  /** The caller's rate limit key, never a raw address in logs. */
  readonly client?: string;
}

export interface V1Variables {
  requestId: string;
}

export interface V1Env {
  Bindings: V1Bindings;
  Variables: V1Variables;
}

export type V1Context = Context<V1Env>;
