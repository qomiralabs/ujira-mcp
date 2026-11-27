// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// Sign in, the session and the projects, on the public API under /v1. The
// session itself is an HttpOnly cookie the browser holds; this file never
// sees it and keeps nothing in storage. Every response is checked against
// its schema before the console trusts it.

import * as z from 'zod/mini';

import { ApiError } from './api';
import { createV1Transport, type Fetch, type V1Transport } from './v1';

export { PROJECT_HEADER, v1ErrorSchema, v1ErrorText } from './v1';

const id = z.string().check(z.minLength(1));

export const challengeSchema = z.looseObject({
  challengeId: id,
  message: z.string().check(z.minLength(1)),
  expiresAt: z.string(),
});
export type Challenge = z.infer<typeof challengeSchema>;

export const memberSchema = z.looseObject({ id, address: z.string().check(z.minLength(1)) });
export type Member = z.infer<typeof memberSchema>;

// Roles are strings, not an enum: a role the server adds later still signs in.
export const principalSchema = z.looseObject({ id, name: z.string(), role: z.string() });
export type Principal = z.infer<typeof principalSchema>;

/** What POST /v1/auth/session and GET /v1/me answer: who is signed in, and where. */
export const sessionSchema = z.looseObject({
  member: memberSchema,
  principals: z.array(principalSchema),
});
export type SessionInfo = z.infer<typeof sessionSchema>;

export const projectSchema = z.looseObject({
  id,
  principalId: id,
  name: z.string(),
  createdAt: z.optional(z.string()),
});
export type Project = z.infer<typeof projectSchema>;

export const projectListSchema = z.looseObject({ projects: z.array(projectSchema) });
export const createdProjectSchema = z.looseObject({ project: projectSchema });
export const createdPrincipalSchema = z.looseObject({
  principal: principalSchema,
  project: projectSchema,
});

/** The longest organisation or project name the console sends. */
export const NAME_MAX = 80;

export interface AuthApi {
  /** A one time message for this address to sign; it lapses after 10 minutes. */
  challenge: (address: string) => Promise<Challenge>;
  /** Trades a signed challenge for a session cookie. */
  startSession: (p: {
    challengeId: string;
    address: string;
    signature: string;
  }) => Promise<SessionInfo>;
  /** The member behind the current cookie; SESSION_INVALID when there is none. */
  me: () => Promise<SessionInfo>;
  endSession: () => Promise<void>;
  /** Creates an organisation, its first project, and makes the caller its owner. */
  createPrincipal: (name: string) => Promise<{ principal: Principal; project: Project }>;
  projects: () => Promise<Project[]>;
  createProject: (principalId: string, name: string) => Promise<Project>;
  /** The project every later request names in the Ujira-Project header; null for none. */
  useProject: (projectId: string | null) => void;
  /** Called whenever any /v1 call finds the session gone; returns the unsubscribe. */
  onSessionLost: (listener: () => void) => () => void;
}

export function isSessionInvalid(error: unknown): boolean {
  return error instanceof ApiError && error.code === 'SESSION_INVALID';
}

/**
 * The real client, on the shared /v1 transport, so the project it opens is
 * the project every other /v1 call names. A bare fetch gets its own transport.
 */
export function createHttpAuthApi(
  transport: V1Transport | Fetch = createV1Transport(),
  base = '',
): AuthApi {
  const t = typeof transport === 'function' ? createV1Transport(transport, base) : transport;
  return {
    challenge: (address) =>
      t.json(challengeSchema, { method: 'POST', path: '/v1/auth/challenge', body: { address } }),
    startSession: (p) =>
      t.json(sessionSchema, { method: 'POST', path: '/v1/auth/session', body: p }),
    me: () => t.json(sessionSchema, { method: 'GET', path: '/v1/me' }),
    endSession: async () => {
      try {
        await t.send({ method: 'DELETE', path: '/v1/auth/session' });
      } catch (error) {
        // Already gone is the outcome we wanted.
        if (!isSessionInvalid(error)) throw error;
      }
    },
    createPrincipal: (name) =>
      t.json(createdPrincipalSchema, { method: 'POST', path: '/v1/principals', body: { name } }),
    projects: async () =>
      (await t.json(projectListSchema, { method: 'GET', path: '/v1/projects' })).projects,
    createProject: async (principalId, name) =>
      (
        await t.json(createdProjectSchema, {
          method: 'POST',
          path: '/v1/projects',
          body: { principalId, name },
        })
      ).project,
    useProject: (projectId) => {
      t.useProject(projectId);
    },
    onSessionLost: (listener) => t.onSessionLost(listener),
  };
}

/** A trimmed name, or the sentence that says what is wrong with it. */
export function checkName(
  raw: string,
  what: string,
): { ok: true; name: string } | { ok: false; error: string } {
  const name = raw.trim().replace(/\s+/g, ' ');
  if (name === '') return { ok: false, error: `Enter ${what}.` };
  if (name.length > NAME_MAX)
    return { ok: false, error: `Keep it under ${NAME_MAX + 1} characters.` };
  return { ok: true, name };
}

const LAST_PROJECT_KEY = 'ujira.console.project';

/**
 * The project this member opened last, by ID only. A project ID is not a
 * secret; it is what lets the next sign in land where the person left off.
 */
export function rememberProject(memberId: string, projectId: string): void {
  try {
    const all = readLastProjects();
    all[memberId] = projectId;
    localStorage.setItem(LAST_PROJECT_KEY, JSON.stringify(all));
  } catch {
    // Without storage the first project opens next time.
  }
}

export function lastProject(memberId: string): string | null {
  return readLastProjects()[memberId] ?? null;
}

function readLastProjects(): Record<string, string> {
  try {
    const raw = localStorage.getItem(LAST_PROJECT_KEY);
    if (raw === null) return {};
    const value: unknown = JSON.parse(raw);
    const parsed = z.record(z.string(), z.string()).safeParse(value);
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

/** The last project if it still exists, else the first one. */
export function pickProject(projects: readonly Project[], memberId: string): Project | null {
  const last = lastProject(memberId);
  return projects.find((p) => p.id === last) ?? projects[0] ?? null;
}
