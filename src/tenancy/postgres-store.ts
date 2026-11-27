// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// Tenancy storage on Postgres, through the repository layer.
//
// A principal is created in an unscoped transaction, since no tenant exists
// yet, and the database function writes its audit row with it. The project is
// read back through the session in that same transaction, which also proves
// the session is still live: if it ended in between, the work rolls back and
// no principal is left behind.
//
// A project is created in a tenant transaction that already names the new
// project, so its audit row lands in it and the row can be read back.

import {
  audit,
  entryPoints,
  projects,
  sessions,
  type Database,
  type SessionProject,
} from '../db/index.js';
import type { TenancyStore } from './tenancy.js';

/** Thrown inside the transaction to roll it back; never leaves this file. */
class SessionEnded extends Error {
  override readonly name = 'SessionEnded';
}

export function postgresTenancyStore(db: Database): TenancyStore {
  return {
    createPrincipal: async (input) => {
      try {
        return await db.unscoped(async (tx) => {
          const created = await entryPoints.createPrincipal(tx, {
            name: input.name,
            projectName: input.projectName,
            ownerWallet: input.ownerWallet,
          });
          const project: SessionProject | undefined = (
            await sessions.projects(tx, input.tokenSha256)
          ).find((p) => p.projectId === created.projectId);
          if (project === undefined) throw new SessionEnded();
          return { principalId: created.principalId, project };
        });
      } catch (error) {
        if (error instanceof SessionEnded) return undefined;
        throw error;
      }
    },
    principals: (tokenSha256) => db.unscoped((tx) => sessions.principals(tx, tokenSha256)),
    projects: (tokenSha256) => db.unscoped((tx) => sessions.projects(tx, tokenSha256)),
    createProject: (context, input) =>
      db.tenant(context).transaction(async (tx) => {
        await projects.create(tx, { id: context.projectId, name: input.name });
        await audit.record(tx, {
          action: 'project.created',
          actor: { kind: 'member', id: input.actorMemberId },
        });
        const project = await projects.get(tx, context.projectId);
        // The insert above succeeded under this very context, so its row is
        // visible to it; anything else is a broken policy, worth failing on.
        if (project === undefined) throw new Error('a project just created cannot be read back');
        return project;
      }),
  };
}
