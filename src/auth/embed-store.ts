// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// Embed tokens on Postgres. The lookup runs unscoped, because the token is
// how the tenant is found; everything the widget does after that runs in the
// token's own tenant transaction.

import { embedTokens, type Database } from '../db/index.js';
import type { EmbedTokenStore } from './embed-auth.js';

export function databaseEmbedTokenStore(db: Database): EmbedTokenStore {
  return {
    find: (secretSha256) => db.unscoped((tx) => embedTokens.resolve(tx, secretSha256)),
  };
}
