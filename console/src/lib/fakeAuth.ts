// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// An in-memory stand in for the /v1 sign in, member and project routes, for
// mock mode and the tests. It keeps the rules the server keeps: a challenge
// is single use and lapses after 10 minutes, the signature must come from
// the address that asked, and every route but the first two needs a session.
// It checks that a signature is present, not that it is valid; the server
// verifies SEP-53 signatures.

import { ApiError } from './api';
import {
  checkName,
  v1ErrorText,
  type AuthApi,
  type Challenge,
  type Member,
  type Principal,
  type Project,
  type SessionInfo,
} from './auth';

const CHALLENGE_MS = 10 * 60 * 1000;
export const FIRST_PROJECT_NAME = 'Main';

export interface FakeAuthSeed {
  readonly address: string;
  readonly principals: readonly { readonly name: string; readonly projects: readonly string[] }[];
}

export interface FakeAuthOptions {
  readonly delayMs?: number;
  readonly now?: () => number;
  /** Members who already have organisations, as if they signed up before. */
  readonly seed?: readonly FakeAuthSeed[];
  /** Starts with this address already signed in, as after a reload. */
  readonly signedInAs?: string;
}

export interface FakeAuthApi extends AuthApi {
  /** What the server would see; for tests only. */
  readonly inspect: () => { signedIn: boolean; project: string | null; challenges: number };
}

interface Pending {
  readonly address: string;
  readonly expiresAt: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The server's version 1 sign in text, so the wallet shows what it will show for real. */
function signInMessage(address: string, issued: Date, expires: Date): string {
  const nonce = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return [
    `${location.host} asks you to sign in with your wallet.`,
    'Signing proves you hold this wallet. It moves no money and approves nothing.',
    '',
    'Version: 1',
    'Purpose: sign_in',
    `Origin: ${location.origin}`,
    `Address: ${address}`,
    `Nonce: ${nonce}`,
    `Issued At: ${issued.toISOString()}`,
    `Expires At: ${expires.toISOString()}`,
  ].join('\n');
}

function fail(code: string, status: number, message = ''): ApiError {
  return new ApiError(code, v1ErrorText(code, message), status);
}

export function createFakeAuthApi(options: FakeAuthOptions = {}): FakeAuthApi {
  const delayMs = options.delayMs ?? 350;
  const now = options.now ?? (() => Date.now());
  const members = new Map<string, Member>();
  const principals = new Map<string, Principal & { members: Set<string> }>();
  const projects = new Map<string, Project>();
  const challenges = new Map<string, Pending>();
  let session: string | null = null;
  let project: string | null = null;

  function memberFor(address: string): Member {
    let m = members.get(address);
    if (m === undefined) {
      m = { id: crypto.randomUUID(), address };
      members.set(address, m);
    }
    return m;
  }

  function addPrincipal(memberId: string, name: string): Principal {
    const p = { id: crypto.randomUUID(), name, role: 'owner', members: new Set([memberId]) };
    principals.set(p.id, p);
    return { id: p.id, name: p.name, role: p.role };
  }

  function addProject(principalId: string, name: string): Project {
    const p: Project = {
      id: crypto.randomUUID(),
      principalId,
      name,
      createdAt: new Date(now()).toISOString(),
    };
    projects.set(p.id, p);
    return p;
  }

  for (const s of options.seed ?? []) {
    const m = memberFor(s.address);
    for (const p of s.principals) {
      const principal = addPrincipal(m.id, p.name);
      for (const name of p.projects) addProject(principal.id, name);
    }
  }
  if (options.signedInAs !== undefined) session = memberFor(options.signedInAs).id;

  function current(): Member {
    const m = [...members.values()].find((x) => x.id === session);
    if (m === undefined) throw fail('SESSION_INVALID', 401);
    return m;
  }

  function principalsOf(memberId: string): Principal[] {
    return [...principals.values()]
      .filter((p) => p.members.has(memberId))
      .map((p) => ({ id: p.id, name: p.name, role: p.role }));
  }

  function info(m: Member): SessionInfo {
    return { member: { ...m }, principals: principalsOf(m.id) };
  }

  async function step<T>(fn: () => T): Promise<T> {
    if (delayMs > 0) await sleep(delayMs);
    return fn();
  }

  return {
    challenge: (address) =>
      step((): Challenge => {
        if (!/^G[A-Z2-7]{55}$/.test(address))
          throw fail('INVALID_REQUEST', 400, 'That is not a Stellar account address.');
        const challengeId = crypto.randomUUID();
        const expiresAt = now() + CHALLENGE_MS;
        challenges.set(challengeId, { address, expiresAt });
        return {
          challengeId,
          message: signInMessage(address, new Date(now()), new Date(expiresAt)),
          expiresAt: new Date(expiresAt).toISOString(),
        };
      }),
    startSession: ({ challengeId, address, signature }) =>
      step(() => {
        const pending = challenges.get(challengeId);
        // Single use: the first attempt spends it, right or wrong.
        challenges.delete(challengeId);
        if (pending === undefined) throw fail('SESSION_INVALID', 401);
        if (pending.expiresAt <= now()) throw fail('CHALLENGE_EXPIRED', 401);
        if (pending.address !== address || signature === '') throw fail('SIGNATURE_INVALID', 401);
        const m = memberFor(address);
        session = m.id;
        return info(m);
      }),
    me: () => step(() => info(current())),
    endSession: () =>
      step(() => {
        session = null;
        project = null;
      }),
    createPrincipal: (raw) =>
      step(() => {
        const m = current();
        const name = checkName(raw, 'a name');
        if (!name.ok) throw fail('INVALID_REQUEST', 400, name.error);
        const principal = addPrincipal(m.id, name.name);
        return { principal, project: addProject(principal.id, FIRST_PROJECT_NAME) };
      }),
    projects: () =>
      step(() => {
        const mine = new Set(principalsOf(current().id).map((p) => p.id));
        return [...projects.values()].filter((p) => mine.has(p.principalId)).map((p) => ({ ...p }));
      }),
    createProject: (principalId, raw) =>
      step(() => {
        const m = current();
        const principal = principals.get(principalId);
        // Another tenant's row looks the same as no row.
        if (principal === undefined || !principal.members.has(m.id)) throw fail('NOT_FOUND', 404);
        const name = checkName(raw, 'a name');
        if (!name.ok) throw fail('INVALID_REQUEST', 400, name.error);
        return addProject(principalId, name.name);
      }),
    useProject: (projectId) => {
      project = projectId;
    },
    inspect: () => ({ signedIn: session !== null, project, challenges: challenges.size }),
  };
}
