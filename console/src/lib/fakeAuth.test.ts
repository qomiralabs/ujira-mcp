// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The fake keeps the rules the real routes keep, so the console is tested
// against the same contract it will meet on the server.

import { describe, expect, it } from 'vitest';

import { isSessionInvalid } from './auth';
import { FIRST_PROJECT_NAME, createFakeAuthApi } from './fakeAuth';

const A = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
const B = `G${'B'.repeat(55)}`;

async function signIn(api: ReturnType<typeof createFakeAuthApi>, address: string) {
  const c = await api.challenge(address);
  return api.startSession({ challengeId: c.challengeId, address, signature: 'c2ln' });
}

describe('the fake sign in API', () => {
  it('needs a session for everything after sign in', async () => {
    const api = createFakeAuthApi({ delayMs: 0 });
    expect(isSessionInvalid(await api.me().catch((e: unknown) => e))).toBe(true);
    expect(isSessionInvalid(await api.projects().catch((e: unknown) => e))).toBe(true);
    expect(isSessionInvalid(await api.createPrincipal('Acme').catch((e: unknown) => e))).toBe(true);
  });

  it('signs a new wallet in with no organisation', async () => {
    const api = createFakeAuthApi({ delayMs: 0 });
    const info = await signIn(api, A);
    expect(info.member.address).toBe(A);
    expect(info.principals).toEqual([]);
    expect(api.inspect().signedIn).toBe(true);
  });

  it('spends a challenge on first use', async () => {
    const api = createFakeAuthApi({ delayMs: 0 });
    const c = await api.challenge(A);
    await api.startSession({ challengeId: c.challengeId, address: A, signature: 'c2ln' });
    const again = await api
      .startSession({ challengeId: c.challengeId, address: A, signature: 'c2ln' })
      .catch((e: unknown) => e);
    expect(isSessionInvalid(again)).toBe(true);
    expect(api.inspect().challenges).toBe(0);
  });

  it('refuses a challenge after 10 minutes', async () => {
    let clock = 1_800_000_000_000;
    const api = createFakeAuthApi({ delayMs: 0, now: () => clock });
    const c = await api.challenge(A);
    clock += 10 * 60 * 1000;
    await expect(
      api.startSession({ challengeId: c.challengeId, address: A, signature: 'c2ln' }),
    ).rejects.toMatchObject({ code: 'CHALLENGE_EXPIRED' });
  });

  it('refuses a signature for another address, or none', async () => {
    const api = createFakeAuthApi({ delayMs: 0 });
    const c1 = await api.challenge(A);
    await expect(
      api.startSession({ challengeId: c1.challengeId, address: B, signature: 'c2ln' }),
    ).rejects.toMatchObject({ code: 'SIGNATURE_INVALID' });
    const c2 = await api.challenge(A);
    await expect(
      api.startSession({ challengeId: c2.challengeId, address: A, signature: '' }),
    ).rejects.toMatchObject({ code: 'SIGNATURE_INVALID' });
  });

  it('refuses an address that is not a Stellar account', async () => {
    const api = createFakeAuthApi({ delayMs: 0 });
    await expect(api.challenge('not-an-address')).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
    });
  });

  it('creates an organisation with its first project, owned by the caller', async () => {
    const api = createFakeAuthApi({ delayMs: 0 });
    await signIn(api, A);
    const { principal, project } = await api.createPrincipal('  Acme  Ltd ');
    expect(principal).toMatchObject({ name: 'Acme Ltd', role: 'owner' });
    expect(project).toMatchObject({ principalId: principal.id, name: FIRST_PROJECT_NAME });
    expect((await api.me()).principals).toHaveLength(1);
    expect(await api.projects()).toHaveLength(1);
  });

  it('refuses an empty organisation name', async () => {
    const api = createFakeAuthApi({ delayMs: 0 });
    await signIn(api, A);
    await expect(api.createPrincipal('  ')).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });

  it('keeps each member to their own organisations and projects', async () => {
    const api = createFakeAuthApi({
      delayMs: 0,
      seed: [{ address: B, principals: [{ name: 'Other', projects: ['Theirs'] }] }],
    });
    await signIn(api, A);
    expect(await api.projects()).toEqual([]);
    await signIn(api, B);
    const theirs = (await api.me()).principals[0];
    expect(theirs?.name).toBe('Other');
    await signIn(api, A);
    await expect(api.createProject(theirs?.id ?? '', 'Mine now')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('ends the session and forgets the project', async () => {
    const api = createFakeAuthApi({ delayMs: 0 });
    await signIn(api, A);
    api.useProject('p');
    await api.endSession();
    expect(api.inspect()).toMatchObject({ signedIn: false, project: null });
  });
});
