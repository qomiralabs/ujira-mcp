// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// Principals and their projects, as a signed in person sees and makes them.
// Storage is a port, so these rules are tested without a database; the
// Postgres side is postgres-store.ts.
//
// Who may act comes from the person's live memberships, read through their
// session every time, never from anything the request claims. A principal the
// person does not belong to is not found, the same answer as one that does not
// exist, so ids cannot be probed.
//
// Log lines carry the request id and row ids. Never a name: an organisation
// is often named after the person who runs it.

import { randomUUID } from 'node:crypto';

import type { Project, ProjectContext, SessionPrincipal, SessionProject } from '../db/index.js';
import { can } from './roles.js';

/** The project every new principal starts with. The console names it the same. */
export const FIRST_PROJECT_NAME = 'Main';

/** The person acting, as their live session found them. */
export interface Actor {
  readonly memberId: string;
  /** Already canonical: the adapter parsed it when the person signed in. */
  readonly walletAddress: string;
  /** SHA-256 of the session cookie, which is how storage finds their memberships. */
  readonly tokenSha256: Buffer;
}

export interface CreatedPrincipalView {
  readonly principal: { readonly id: string; readonly name: string; readonly role: string };
  readonly project: SessionProject;
}

/** What tenancy needs from storage. */
export interface TenancyStore {
  /**
   * The principal, its first project, the owner's membership and the audit
   * row, all or none. Undefined, with nothing written, when the session ended
   * before the work committed.
   */
  createPrincipal(input: {
    readonly tokenSha256: Buffer;
    readonly ownerWallet: string;
    readonly name: string;
    readonly projectName: string;
  }): Promise<{ readonly principalId: string; readonly project: SessionProject } | undefined>;
  principals(tokenSha256: Buffer): Promise<SessionPrincipal[]>;
  projects(tokenSha256: Buffer): Promise<SessionProject[]>;
  /** The project and its audit row in one tenant transaction naming the new project. */
  createProject(
    context: ProjectContext,
    input: { readonly name: string; readonly actorMemberId: string },
  ): Promise<Project>;
}

export type TenancyErrorCode = 'NOT_FOUND' | 'FORBIDDEN' | 'SESSION_INVALID';

/** A refusal the API answers with a fixed message. */
export class TenancyError extends Error {
  readonly code: TenancyErrorCode;

  constructor(code: TenancyErrorCode, message: string) {
    super(message);
    this.name = 'TenancyError';
    this.code = code;
  }
}

export interface TenancyOptions {
  readonly store: TenancyStore;
  readonly log?: (line: string) => void;
  /** Ids for new projects; random UUIDs unless a test fixes them. */
  readonly newId?: () => string;
  /**
   * Runs once a project has committed, to give it what every project needs,
   * such as its agent key. It must be safe to run again, because a failure
   * here is logged and repaired by the next call, not answered as a failed
   * request: the project already exists, and a client retrying the create
   * would make a second one.
   */
  readonly onProjectCreated?: (context: ProjectContext, requestId: string) => Promise<void>;
}

export class Tenancy {
  private readonly log: (line: string) => void;
  private readonly newId: () => string;

  constructor(private readonly o: TenancyOptions) {
    this.log = o.log ?? (() => undefined);
    this.newId = o.newId ?? randomUUID;
  }

  private async afterCreate(context: ProjectContext, requestId: string): Promise<void> {
    try {
      await this.o.onProjectCreated?.(context, requestId);
    } catch (error) {
      // The name only: a message from below can carry a host or a value.
      const kind = error instanceof Error ? error.name : 'unknown';
      this.log(
        `event=project_setup_failed level=error requestId=${requestId} principal=${context.principalId} project=${context.projectId} error=${kind}`,
      );
    }
  }

  /** A new principal with its first project, and the actor as its owner. */
  async createPrincipal(
    actor: Actor,
    name: string,
    requestId: string,
  ): Promise<CreatedPrincipalView> {
    const created = await this.o.store.createPrincipal({
      tokenSha256: actor.tokenSha256,
      ownerWallet: actor.walletAddress,
      name,
      projectName: FIRST_PROJECT_NAME,
    });
    if (created === undefined) {
      throw new TenancyError('SESSION_INVALID', 'The session ended');
    }
    this.log(
      `event=principal_created requestId=${requestId} principal=${created.principalId} member=${actor.memberId}`,
    );
    await this.afterCreate(
      { principalId: created.principalId, projectId: created.project.projectId },
      requestId,
    );
    return {
      principal: { id: created.principalId, name, role: 'owner' },
      project: created.project,
    };
  }

  /** Every project of every principal the actor belongs to. */
  projects(actor: Actor): Promise<SessionProject[]> {
    return this.o.store.projects(actor.tokenSha256);
  }

  /** A new project in a principal the actor may manage projects in. */
  async createProject(
    actor: Actor,
    principalId: string,
    name: string,
    requestId: string,
  ): Promise<Project> {
    const membership = (await this.o.store.principals(actor.tokenSha256)).find(
      (p) => p.principalId === principalId,
    );
    if (membership === undefined) throw new TenancyError('NOT_FOUND', 'No such principal');
    if (!can(membership.role, 'manage_projects')) {
      throw new TenancyError('FORBIDDEN', 'This role cannot create projects');
    }
    const project = await this.o.store.createProject(
      { principalId, projectId: this.newId() },
      { name, actorMemberId: actor.memberId },
    );
    this.log(
      `event=project_created requestId=${requestId} principal=${principalId} project=${project.id} member=${actor.memberId}`,
    );
    await this.afterCreate({ principalId, projectId: project.id }, requestId);
    return project;
  }
}
