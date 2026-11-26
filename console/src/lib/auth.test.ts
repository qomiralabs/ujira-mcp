// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

import { describe, expect, it } from 'vitest';

import { ApiError } from './api';
import {
  PROJECT_HEADER,
  checkName,
  createHttpAuthApi,
  isSessionInvalid,
  lastProject,
  pickProject,
  rememberProject,
  type Project,
} from './auth';

const ADDRESS = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
const SESSION = {
  member: { id: 'm-1', address: ADDRESS },
  principals: [{ id: 'p-1', name: 'Acme Ltd', role: 'owner' }],
};

interface Call {
  readonly url: string;
  readonly init: RequestInit;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function recorder(answer: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const api = createHttpAuthApi((url, init) => {
    const call = { url, init: init ?? {} };
    calls.push(call);
    return Promise.resolve(answer(call));
  });
  return { api, calls };
}

function header(call: Call | undefined, name: string): string | undefined {
  const headers = (call?.init.headers ?? {}) as Record<string, string>;
  return headers[name];
}

describe('the /v1 sign in client', () => {
  it('asks for a challenge with the address, on the same origin', async () => {
    const { api, calls } = recorder(() =>
      json(200, { challengeId: 'c-1', message: 'sign me', expiresAt: '2026-11-26T10:10:00Z' }),
    );
    const challenge = await api.challenge(ADDRESS);
    expect(challenge).toMatchObject({ challengeId: 'c-1', message: 'sign me' });
    expect(calls[0]?.url).toBe('/v1/auth/challenge');
    expect(calls[0]?.init.method).toBe('POST');
    expect(calls[0]?.init.credentials).toBe('same-origin');
    expect(JSON.parse(calls[0]?.init.body as string)).toEqual({ address: ADDRESS });
  });

  it('starts a session and reads the member and their organisations', async () => {
    const { api, calls } = recorder(() => json(200, SESSION));
    const info = await api.startSession({
      challengeId: 'c-1',
      address: ADDRESS,
      signature: 'c2ln',
    });
    expect(info.member.address).toBe(ADDRESS);
    expect(info.principals[0]?.name).toBe('Acme Ltd');
    expect(calls[0]?.url).toBe('/v1/auth/session');
    expect(JSON.parse(calls[0]?.init.body as string)).toEqual({
      challengeId: 'c-1',
      address: ADDRESS,
      signature: 'c2ln',
    });
  });

  it('names the chosen project in the Ujira-Project header, and stops when cleared', async () => {
    const { api, calls } = recorder(() => json(200, { projects: [] }));
    await api.projects();
    api.useProject('proj-1');
    await api.projects();
    api.useProject(null);
    await api.projects();
    expect(header(calls[0], PROJECT_HEADER)).toBeUndefined();
    expect(header(calls[1], PROJECT_HEADER)).toBe('proj-1');
    expect(header(calls[2], PROJECT_HEADER)).toBeUndefined();
  });

  it('turns a 401 into SESSION_INVALID with a sentence', async () => {
    const { api } = recorder(() =>
      json(401, { error: { code: 'SESSION_INVALID', message: 'no session', requestId: 'r-1' } }),
    );
    const error = await api.me().catch((e: unknown) => e);
    expect(isSessionInvalid(error)).toBe(true);
    expect((error as ApiError).message).toBe('Your session has ended. Sign in again.');
  });

  it('reads a 401 without a body as a lost session too', async () => {
    const { api } = recorder(() => new Response(null, { status: 401 }));
    expect(isSessionInvalid(await api.me().catch((e: unknown) => e))).toBe(true);
  });

  it('keeps the server message for a code it has no sentence for', async () => {
    const { api } = recorder(() =>
      json(400, { error: { code: 'INVALID_REQUEST', message: 'Enter a name.', requestId: 'r' } }),
    );
    const error = await api.createPrincipal('').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).message).toBe('Enter a name.');
    expect((error as ApiError).code).toBe('INVALID_REQUEST');
  });

  it('refuses an answer in the wrong shape', async () => {
    const { api } = recorder(() => json(200, { member: { id: 'm-1' }, principals: [] }));
    const error = await api.me().catch((e: unknown) => e);
    expect((error as ApiError).code).toBe('bad_response');
  });

  it('says so when the server cannot be reached', async () => {
    const api = createHttpAuthApi(() => Promise.reject(new TypeError('offline')));
    const error = await api.me().catch((e: unknown) => e);
    expect((error as ApiError).code).toBe('network');
  });

  it('treats signing out of a session that already ended as done', async () => {
    const { api, calls } = recorder(() => new Response(null, { status: 401 }));
    await expect(api.endSession()).resolves.toBeUndefined();
    expect(calls[0]?.init.method).toBe('DELETE');
    expect(calls[0]?.url).toBe('/v1/auth/session');
  });

  it('reports a failed sign out', async () => {
    const { api } = recorder(() => new Response(null, { status: 503 }));
    await expect(api.endSession()).rejects.toBeInstanceOf(ApiError);
  });

  it('creates a project under an organisation', async () => {
    const project = { id: 'proj-2', principalId: 'p-1', name: 'Payouts' };
    const { api, calls } = recorder(() => json(201, { project }));
    expect(await api.createProject('p-1', 'Payouts')).toMatchObject(project);
    expect(JSON.parse(calls[0]?.init.body as string)).toEqual({
      principalId: 'p-1',
      name: 'Payouts',
    });
  });
});

describe('names', () => {
  it('trims and folds spaces, and refuses empty or long names', () => {
    expect(checkName('  Acme   Ltd ', 'a name')).toEqual({ ok: true, name: 'Acme Ltd' });
    expect(checkName('   ', 'a name')).toEqual({ ok: false, error: 'Enter a name.' });
    expect(checkName('x'.repeat(81), 'a name').ok).toBe(false);
    expect(checkName('x'.repeat(80), 'a name').ok).toBe(true);
  });
});

describe('the last project', () => {
  const projects: Project[] = [
    { id: 'a', principalId: 'p', name: 'A' },
    { id: 'b', principalId: 'p', name: 'B' },
  ];

  it('opens the first project when none was opened before', () => {
    expect(pickProject(projects, 'm-1')?.id).toBe('a');
    expect(pickProject([], 'm-1')).toBeNull();
  });

  it('restores the project this member opened last, per member', () => {
    rememberProject('m-1', 'b');
    rememberProject('m-2', 'a');
    expect(lastProject('m-1')).toBe('b');
    expect(pickProject(projects, 'm-1')?.id).toBe('b');
    expect(pickProject(projects, 'm-2')?.id).toBe('a');
  });

  it('falls back to the first when the last one is gone', () => {
    rememberProject('m-1', 'gone');
    expect(pickProject(projects, 'm-1')?.id).toBe('a');
  });

  it('ignores a damaged entry', () => {
    localStorage.setItem('ujira.console.project', '{not json');
    expect(lastProject('m-1')).toBeNull();
  });
});
