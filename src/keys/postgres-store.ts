// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The agent key store on Postgres. Every call runs in a transaction for the
// caller's own project, so the policies decide what it can reach: another
// project's key reads as nothing. The sealed secret is read as the worker,
// the only role the database lets read it.

import {
  agentKeys,
  constraintViolation,
  type AccountParser,
  type Database,
  type ProjectContext,
} from '../db/index.js';
import type { AgentKeyStore } from './agent-keys.js';

export interface PostgresAgentKeyStoreOptions {
  // Parses every public key before it is stored, so one account has one spelling.
  readonly accounts: AccountParser;
  // The role for everything but the secret: the web role makes keys as the
  // app, and the worker retries funding as itself.
  readonly role?: 'app' | 'worker';
}

export function postgresAgentKeyStore(
  db: Database,
  options: PostgresAgentKeyStoreOptions,
): AgentKeyStore {
  const role = options.role ?? 'app';
  // Copied out, so a context object changed later cannot change a call.
  const project = (context: ProjectContext) =>
    ({
      principalId: context.principalId,
      projectId: context.projectId,
      scope: 'project',
    }) as const;

  return {
    active: (context, network) =>
      db.withTenant(role, project(context), (tx) => agentKeys.active(tx, network)),
    get: (context, id) => db.withTenant(role, project(context), (tx) => agentKeys.get(tx, id)),
    async create(context, key) {
      try {
        return await db.withTenant('app', project(context), (tx) =>
          agentKeys.create(tx, key, options.accounts),
        );
      } catch (error) {
        const violation = constraintViolation(error);
        if (violation?.kind === 'unique' && violation.constraint === 'agent_keys_one_active') {
          return undefined;
        }
        throw error;
      }
    },
    recordFunding: (context, id, attempt) =>
      db.withTenant(role, project(context), (tx) => agentKeys.recordFunding(tx, id, attempt)),
    sealedSecret: (context, id) =>
      db.withTenant('worker', project(context), (tx) => agentKeys.sealedSecret(tx, id)),
  };
}
