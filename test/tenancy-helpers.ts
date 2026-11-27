// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// Principals and projects on /v1 in memory: the sign in store from
// sign-in-helpers.ts with projects, roles and the audit log added, keeping the
// database's rules (a session resolves a project only through an active
// membership of its principal; a principal comes with its first project, its
// owner and its first audit row). The same routes run against Postgres in
// tenancy-routes.db.test.ts.
//
// The probe routes stand in for the project routes still to come: each one
// asks requireProjectSession for one permission, exactly as a real route will,
// and answers with the tenant context it got.

import { randomUUID } from 'node:crypto';

import { z } from 'zod';

import { createV1App, type V1App } from '../src/api/app.js';
import { defineRoute, type Route } from '../src/api/route.js';
import { authRoutes } from '../src/api/routes/auth.js';
import { tenancyRoutes } from '../src/api/routes/tenancy.js';
import {
  requireProjectSession,
  sessionAuthenticator,
  type SessionOptions,
} from '../src/api/session.js';
import { SignIn } from '../src/auth/sign-in.js';
import type {
  MemberRole,
  Project,
  ProjectContext,
  ResolvedSession,
  SessionPrincipal,
  SessionProject,
} from '../src/db/index.js';
import type { Permission } from '../src/tenancy/roles.js';
import { Tenancy, type TenancyStore } from '../src/tenancy/tenancy.js';
import {
  clientFor,
  MemorySignInStore,
  ORIGIN,
  START,
  verifier,
  type Call,
  type Clock,
} from './sign-in-helpers.js';

export interface AuditRow {
  readonly principalId: string;
  readonly projectId: string;
  readonly action: string;
  readonly actorId: string;
}

export class MemoryTenancyStore extends MemorySignInStore implements TenancyStore {
  readonly projectRows = new Map<string, Project>();
  readonly audit: AuditRow[] = [];
  private tick = 0;

  // Each row a millisecond after the last, so list order is the order made.
  private stamp(): Date {
    this.tick += 1;
    return new Date(this.clock.now + this.tick);
  }

  /** Adds a wallet to a principal with a role, as add_member would. */
  addMember(walletAddress: string, principalId: string, role: MemberRole): void {
    const owner = [...this.memberships.values()].flat().find((p) => p.principalId === principalId);
    if (owner === undefined) throw new Error('no such principal');
    this.grant(walletAddress, { principalId, name: owner.name, role });
  }

  /** Takes a wallet out of a principal, as suspending or removing them would. */
  removeMember(walletAddress: string, principalId: string): void {
    const memberId = this.memberOf(walletAddress);
    this.memberships.set(
      memberId,
      (this.memberships.get(memberId) ?? []).filter((p) => p.principalId !== principalId),
    );
  }

  override resolveSession(
    tokenSha256: Buffer,
    projectId: string | null = null,
  ): Promise<ResolvedSession | undefined> {
    this.check();
    const row = this.live(tokenSha256);
    if (row === undefined) return Promise.resolve(undefined);
    const project = projectId === null ? undefined : this.projectRows.get(projectId);
    const membership =
      project === undefined
        ? undefined
        : (this.memberships.get(row.memberId) ?? []).find(
            (p) => p.principalId === project.principalId,
          );
    return Promise.resolve({
      sessionId: row.id,
      memberId: row.memberId,
      walletAddress: row.wallet,
      idleExpiresAt: new Date(row.idle),
      absoluteExpiresAt: new Date(row.absolute),
      access:
        project === undefined || membership === undefined
          ? null
          : { principalId: project.principalId, projectId: project.id, role: membership.role },
    });
  }

  createPrincipal(input: {
    readonly tokenSha256: Buffer;
    readonly ownerWallet: string;
    readonly name: string;
    readonly projectName: string;
  }): Promise<{ principalId: string; project: SessionProject } | undefined> {
    this.check();
    if (this.live(input.tokenSha256) === undefined) return Promise.resolve(undefined);
    const principalId = randomUUID();
    const project: Project = {
      id: randomUUID(),
      principalId,
      name: input.projectName,
      createdAt: this.stamp(),
    };
    this.projectRows.set(project.id, project);
    const principal: SessionPrincipal = { principalId, name: input.name, role: 'owner' };
    this.grant(input.ownerWallet, principal);
    this.audit.push({
      principalId,
      projectId: project.id,
      action: 'principal.created',
      actorId: this.memberOf(input.ownerWallet),
    });
    return Promise.resolve({
      principalId,
      project: {
        projectId: project.id,
        principalId,
        name: project.name,
        createdAt: project.createdAt,
      },
    });
  }

  projects(tokenSha256: Buffer): Promise<SessionProject[]> {
    this.check();
    const row = this.live(tokenSha256);
    if (row === undefined) return Promise.resolve([]);
    const mine = new Set((this.memberships.get(row.memberId) ?? []).map((p) => p.principalId));
    return Promise.resolve(
      [...this.projectRows.values()]
        .filter((p) => mine.has(p.principalId))
        .sort(
          (a, b) =>
            a.principalId.localeCompare(b.principalId) ||
            a.createdAt.getTime() - b.createdAt.getTime() ||
            a.id.localeCompare(b.id),
        )
        .map((p) => ({
          projectId: p.id,
          principalId: p.principalId,
          name: p.name,
          createdAt: p.createdAt,
        })),
    );
  }

  createProject(
    context: ProjectContext,
    input: { readonly name: string; readonly actorMemberId: string },
  ): Promise<Project> {
    this.check();
    const project: Project = {
      id: context.projectId,
      principalId: context.principalId,
      name: input.name,
      createdAt: this.stamp(),
    };
    this.projectRows.set(project.id, project);
    this.audit.push({
      principalId: context.principalId,
      projectId: context.projectId,
      action: 'project.created',
      actorId: input.actorMemberId,
    });
    return Promise.resolve(project);
  }
}

const probeAnswer = z
  .object({
    principalId: z.string(),
    projectId: z.string(),
    memberId: z.string(),
    role: z.string(),
  })
  .strict();

function probe(
  session: SessionOptions,
  method: 'get' | 'post',
  path: string,
  operationId: string,
  permission: Permission,
): Route {
  return defineRoute({
    method,
    path,
    operationId,
    summary: `Needs ${permission}`,
    response: probeAnswer,
    handler: async (_input, c) => {
      const caller =
        method === 'get'
          ? await requireProjectSession(c, session, { write: false, permission })
          : await sessionAuthenticator(session, permission)(c);
      return {
        principalId: caller.principalId,
        projectId: caller.projectId,
        memberId: caller.memberId,
        role: caller.role,
      };
    },
  });
}

/** One route per permission, each answering the context its check returned. */
export function probeRoutes(session: SessionOptions): Route[] {
  return [
    probe(session, 'get', '/v1/probe', 'probeRead', 'read'),
    probe(session, 'post', '/v1/probe/write', 'probeWrite', 'write'),
    probe(session, 'post', '/v1/probe/keys', 'probeKeys', 'manage_keys'),
    probe(session, 'post', '/v1/probe/members', 'probeMembers', 'manage_members'),
  ];
}

export interface TenancyHarness {
  readonly clock: Clock;
  readonly store: MemoryTenancyStore;
  readonly lines: string[];
  readonly v1: V1App;
  readonly call: Call;
}

export function tenancyHarness(): TenancyHarness {
  const clock: Clock = { now: START };
  const store = new MemoryTenancyStore(clock);
  const lines: string[] = [];
  const log = (line: string) => {
    lines.push(line);
  };
  const now = () => new Date(clock.now);
  const signIn = new SignIn({ store, verifier, origin: ORIGIN, log, now });
  const tenancy = new Tenancy({ store, log });
  const session = { signIn, origin: ORIGIN };
  const v1 = createV1App({
    routes: [
      ...authRoutes({ ...session, now }),
      ...tenancyRoutes({ ...session, tenancy }),
      ...probeRoutes(session),
    ],
    log,
  });
  return { clock, store, lines, v1, call: clientFor(v1.app) };
}
