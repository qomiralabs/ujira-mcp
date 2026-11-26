// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// Sign in, the session and the projects, on the public API under /v1. The
// session itself is an HttpOnly cookie the browser holds; this file never
// sees it and keeps nothing in storage. Every response is checked against
// its schema before the console trusts it.

import * as z from 'zod/mini';

import { ApiError, NETWORK_ERROR } from './api';

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

/** The one error envelope every /v1 route uses. */
export const v1ErrorSchema = z.looseObject({
  error: z.looseObject({
    code: z.string(),
    message: z.string(),
    requestId: z.optional(z.string()),
  }),
});

export const PROJECT_HEADER = 'Ujira-Project';

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
}

// Sentences for the /v1 codes a person can meet while signing in.
const V1_ERRORS: Record<string, string> = {
  SESSION_INVALID: 'Your session has ended. Sign in again.',
  SIGNATURE_INVALID: 'The wallet signature did not match. Sign in again.',
  CHALLENGE_EXPIRED: 'The sign in message ran out of time. Sign in again.',
  FORBIDDEN: 'Your role cannot do that here.',
  ORIGIN_NOT_ALLOWED: 'This page is not allowed to sign you in. Open UJIRA from ujira.co.',
  NOT_FOUND: 'We could not find that. Reload the page and try again.',
  RATE_LIMITED: 'Too many tries in a short time. Wait a minute and try again.',
  DB_UNAVAILABLE: 'UJIRA is busy for a moment. Try again shortly.',
  INTERNAL: 'The UJIRA server had a problem. Try again in a moment.',
};

/** The sentence for a /v1 error code; the server's own words when we have none. */
export function v1ErrorText(code: string, serverMessage: string): string {
  return (
    V1_ERRORS[code] ?? (serverMessage === '' ? 'That did not work. Try again.' : serverMessage)
  );
}

export function isSessionInvalid(error: unknown): boolean {
  return error instanceof ApiError && error.code === 'SESSION_INVALID';
}

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

async function readV1Error(res: Response): Promise<ApiError> {
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // No JSON body: the status decides.
  }
  const parsed = v1ErrorSchema.safeParse(body);
  if (parsed.success) {
    const { code, message } = parsed.data.error;
    return new ApiError(code, v1ErrorText(code, message), res.status);
  }
  if (res.status === 401)
    return new ApiError('SESSION_INVALID', v1ErrorText('SESSION_INVALID', ''), 401);
  if (res.status === 429) return new ApiError('RATE_LIMITED', v1ErrorText('RATE_LIMITED', ''), 429);
  if (res.status >= 500) return new ApiError('INTERNAL', v1ErrorText('INTERNAL', ''), res.status);
  return new ApiError(
    'REQUEST_FAILED',
    `The server refused the request (HTTP ${res.status}).`,
    res.status,
  );
}

/** The real client. Same origin, so the browser sends the cookie and the Origin itself. */
export function createHttpAuthApi(
  fetchImpl: Fetch = (i, init) => fetch(i, init),
  base = '',
): AuthApi {
  let project: string | null = null;

  async function send(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown) {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (project !== null) headers[PROJECT_HEADER] = project;
    let res: Response;
    try {
      res = await fetchImpl(`${base}${path}`, {
        method,
        headers,
        credentials: 'same-origin',
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new ApiError('network', NETWORK_ERROR, 0);
    }
    if (!res.ok) throw await readV1Error(res);
    return res;
  }

  async function call<S extends z.ZodMiniType>(
    schema: S,
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<z.infer<S>> {
    const res = await send(method, path, body);
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      throw new ApiError(
        'bad_response',
        'The server sent an answer we could not read.',
        res.status,
      );
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      throw new ApiError(
        'bad_response',
        'The server sent an answer in a shape we did not expect.',
        res.status,
      );
    }
    return parsed.data;
  }

  return {
    challenge: (address) => call(challengeSchema, 'POST', '/v1/auth/challenge', { address }),
    startSession: (p) => call(sessionSchema, 'POST', '/v1/auth/session', p),
    me: () => call(sessionSchema, 'GET', '/v1/me'),
    endSession: async () => {
      try {
        await send('DELETE', '/v1/auth/session');
      } catch (error) {
        // Already gone is the outcome we wanted.
        if (!isSessionInvalid(error)) throw error;
      }
    },
    createPrincipal: (name) => call(createdPrincipalSchema, 'POST', '/v1/principals', { name }),
    projects: async () => (await call(projectListSchema, 'GET', '/v1/projects')).projects,
    createProject: async (principalId, name) =>
      (await call(createdProjectSchema, 'POST', '/v1/projects', { principalId, name })).project,
    useProject: (projectId) => {
      project = projectId;
    },
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
