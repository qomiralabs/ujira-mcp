// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// Sign in storage on Postgres, through the repository layer. Each call is its
// own unscoped transaction, since a challenge or a session is how a tenant is
// found and so runs before one exists. Spending a challenge commits on its
// own, before the signature is checked, which is what makes it single use
// even when the check that follows fails.

import {
  authChallenges,
  rateLimits,
  securityEvents,
  sessions,
  type Database,
} from '../db/index.js';
import type { SignInStore } from './sign-in.js';

export function postgresSignInStore(db: Database): SignInStore {
  return {
    takeTokens: async (buckets) => {
      const taken = await db.unscoped((tx) => rateLimits.take(tx, buckets));
      return taken.length === buckets.length && taken.every((t) => t.allowed);
    },
    createChallenge: (input) => db.unscoped((tx) => authChallenges.create(tx, input)),
    consumeChallenge: (challengeId, walletAddress) =>
      db.unscoped((tx) => authChallenges.consume(tx, challengeId, walletAddress)),
    createSession: (input) =>
      db.unscoped(async (tx) => {
        const session = await sessions.create(tx, input);
        const principals = await sessions.principals(tx, input.tokenSha256);
        return { session, principals };
      }),
    resolveSession: (tokenSha256, projectId) =>
      db.unscoped((tx) => sessions.resolve(tx, tokenSha256, projectId)),
    principals: (tokenSha256) => db.unscoped((tx) => sessions.principals(tx, tokenSha256)),
    touchSession: (tokenSha256, idleSeconds) =>
      db.unscoped((tx) => sessions.touch(tx, tokenSha256, idleSeconds)),
    revokeSession: (tokenSha256, reason) =>
      db.unscoped((tx) => sessions.revoke(tx, tokenSha256, reason)),
    recordSecurityEvent: (kind) => db.unscoped((tx) => securityEvents.record(tx, { kind })),
  };
}
