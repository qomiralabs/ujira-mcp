// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The slot through which the testnet demo adds its features to the console.
// The console defines it and never imports what fills it, so a server
// without the demo serves the console alone, and the demo can be deleted
// without touching the console.

import type { IncomingMessage } from 'node:http';

import type { MandateContract } from '../chain/adapter.js';
import type { PayoutRail } from '../rails/rail.js';

/** Answers one /api request; the console sends the result as JSON. */
export type ApiHandler = (req: IncomingMessage, client: string, url: URL) => Promise<unknown>;

/** A handler, `wrong_method` when the path is known but the method is not, or undefined. */
export type ApiRoute = ApiHandler | 'wrong_method' | undefined;

export interface ConsoleExtension {
  /** /api paths the console does not answer itself; undefined leaves them to the 404. */
  route(method: string, path: string): ApiRoute;
  /** Fields laid over the console's own /api/config. */
  config(): Readonly<Record<string, unknown>>;
  /** Rails a console mandate offers next to the wallet rail. */
  rails(mandate: MandateContract, recipients: Readonly<Record<string, string>>): PayoutRail[];
  /**
   * Destinations allowlisted next to each person's own wallet, for rails
   * that pay everyone through one account.
   */
  readonly sharedDestinations: readonly string[];
}
