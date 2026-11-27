// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// Principals and projects for the signed in person. These three routes are
// about the person rather than one project, so they ignore Ujira-Project: a
// header left over from a project the person has since lost must not stop
// them from listing what they still have, or from making a new one.
//
// Shapes are the ones the console already reads: a principal is
// { id, name, role } and a project { id, principalId, name, createdAt }.

import { z } from 'zod';

import type { SessionProject } from '../../db/index.js';
import { TenancyError, type Actor, type Tenancy } from '../../tenancy/tenancy.js';
import type { V1Context } from '../context.js';
import { ApiError } from '../errors.js';
import { defineRoute, type Route } from '../route.js';
import { requireSession, type SessionOptions } from '../session.js';

export interface TenancyRouteOptions extends SessionOptions {
  readonly tenancy: Tenancy;
}

/** The database allows 200 characters; control characters have no place in a name on a screen. */
const NAME_MAX = 200;

const name = z
  .string()
  .trim()
  .min(1)
  .max(NAME_MAX)
  .regex(/^[^\p{Cc}]*$/u);

// Ids are lower case inside, so one written in capitals still finds its row.
const principalId = z.uuid();

const principalView = z.object({ id: z.string(), name: z.string(), role: z.string() }).strict();

const projectView = z
  .object({
    id: z.string(),
    principalId: z.string(),
    name: z.string(),
    createdAt: z.string(),
  })
  .strict();

function projectOf(p: {
  readonly id: string;
  readonly principalId: string;
  readonly name: string;
  readonly createdAt: Date;
}): z.input<typeof projectView> {
  return {
    id: p.id,
    principalId: p.principalId,
    name: p.name,
    createdAt: p.createdAt.toISOString(),
  };
}

function sessionProjectOf(p: SessionProject): z.input<typeof projectView> {
  return projectOf({
    id: p.projectId,
    principalId: p.principalId,
    name: p.name,
    createdAt: p.createdAt,
  });
}

function toApiError(error: unknown): unknown {
  if (!(error instanceof TenancyError)) return error;
  switch (error.code) {
    case 'NOT_FOUND':
      return new ApiError('NOT_FOUND', 'No such principal');
    case 'FORBIDDEN':
      return new ApiError('FORBIDDEN', 'Your role cannot create projects here');
    case 'SESSION_INVALID':
      return new ApiError('SESSION_INVALID', 'Sign in again');
  }
}

async function tenancyCall<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw toApiError(error);
  }
}

async function actorOf(c: V1Context, o: SessionOptions, write: boolean): Promise<Actor> {
  const session = await requireSession(c, o, { write });
  return {
    memberId: session.memberId,
    walletAddress: session.walletAddress,
    tokenSha256: session.tokenSha256,
  };
}

export function tenancyRoutes(o: TenancyRouteOptions): Route[] {
  const session: SessionOptions = { signIn: o.signIn, origin: o.origin };

  const createPrincipal = defineRoute({
    method: 'post',
    path: '/v1/principals',
    operationId: 'createPrincipal',
    summary: 'Create an organisation',
    description:
      'Creates the principal and its first project, Main, and makes the signed in person its owner.',
    tags: ['tenancy'],
    body: z.object({ name }).strict(),
    status: 201,
    response: z.object({ principal: principalView, project: projectView }).strict(),
    errors: ['SESSION_INVALID', 'ORIGIN_NOT_ALLOWED', 'DB_UNAVAILABLE'],
    handler: async ({ body }, c) => {
      const actor = await actorOf(c, session, true);
      const created = await tenancyCall(() =>
        o.tenancy.createPrincipal(actor, body.name, c.get('requestId')),
      );
      return { principal: created.principal, project: sessionProjectOf(created.project) };
    },
  });

  const listProjects = defineRoute({
    method: 'get',
    path: '/v1/projects',
    operationId: 'listProjects',
    summary: 'List the projects you can open',
    description: 'Every project of every principal the signed in person is an active member of.',
    tags: ['tenancy'],
    response: z.object({ projects: z.array(projectView) }).strict(),
    errors: ['SESSION_INVALID', 'DB_UNAVAILABLE'],
    handler: async (_input, c) => {
      const actor = await actorOf(c, session, false);
      const projects = await o.tenancy.projects(actor);
      return { projects: projects.map(sessionProjectOf) };
    },
  });

  const createProject = defineRoute({
    method: 'post',
    path: '/v1/projects',
    operationId: 'createProject',
    summary: 'Create a project',
    description:
      'Owners and admins of the principal may create projects. A principal the person does not belong to answers NOT_FOUND.',
    tags: ['tenancy'],
    body: z.object({ principalId, name }).strict(),
    status: 201,
    response: z.object({ project: projectView }).strict(),
    errors: ['SESSION_INVALID', 'ORIGIN_NOT_ALLOWED', 'FORBIDDEN', 'NOT_FOUND', 'DB_UNAVAILABLE'],
    handler: async ({ body }, c) => {
      const actor = await actorOf(c, session, true);
      const project = await tenancyCall(() =>
        o.tenancy.createProject(
          actor,
          body.principalId.toLowerCase(),
          body.name,
          c.get('requestId'),
        ),
      );
      return { project: projectOf(project) };
    },
  });

  return [createPrincipal, listProjects, createProject];
}
