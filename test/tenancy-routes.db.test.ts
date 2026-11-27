// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// Principals and projects against a real database, logged in as the app is in
// production, with wallets made in the test signing the SEP-53 sign in
// message. First the console's own flow end to end over HTTP: sign in, name
// an organisation, add a project, switch between them. Then two principals
// with two projects each, where every route has a cross tenant case, and the
// roles each member has.

import { randomUUID } from 'node:crypto';

import type { Keypair } from '@stellar/stellar-sdk';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { createV1App } from '../src/api/app.js';
import type { Route } from '../src/api/route.js';
import { authRoutes } from '../src/api/routes/auth.js';
import { tenancyRoutes } from '../src/api/routes/tenancy.js';
import { postgresSignInStore } from '../src/auth/postgres-store.js';
import { SignIn } from '../src/auth/sign-in.js';
import {
  audit,
  members,
  type Database,
  type MemberRole,
  type ProjectContext,
} from '../src/db/index.js';
import {
  createTestDatabase,
  databaseAsServiceRoles,
  type TestDatabase,
} from '../src/db/testing/index.js';
import { postgresTenancyStore } from '../src/tenancy/postgres-store.js';
import { FIRST_PROJECT_NAME, Tenancy } from '../src/tenancy/tenancy.js';
import {
  clientFor,
  errorCode,
  ORIGIN,
  signInWith,
  verifier,
  wallet,
  type Answer,
  type Call,
} from './sign-in-helpers.js';
import { probeRoutes } from './tenancy-helpers.js';

const adminUrl = inject('dbAdminUrl');
const roleUrls = inject('dbRoleUrls');

let database: TestDatabase;
let db: Database;
let call: Call;
let routes: Route[];
const lines: string[] = [];

beforeAll(async () => {
  database = await createTestDatabase(adminUrl, import.meta.url);
  db = databaseAsServiceRoles(roleUrls, database);
  const log = (line: string) => {
    lines.push(line);
  };
  const signIn = new SignIn({ store: postgresSignInStore(db), verifier, origin: ORIGIN, log });
  const tenancy = new Tenancy({ store: postgresTenancyStore(db), log });
  const session = { signIn, origin: ORIGIN };
  routes = tenancyRoutes({ ...session, tenancy });
  call = clientFor(
    createV1App({
      routes: [...authRoutes(session), ...routes, ...probeRoutes(session)],
      log,
    }).app,
  );
});

afterAll(async () => {
  await db.close();
  await database.drop();
});

interface ProjectView {
  readonly id: string;
  readonly principalId: string;
  readonly name: string;
  readonly createdAt: string;
}

interface Person {
  readonly key: Keypair;
  readonly cookie: string;
  readonly memberId: string;
}

// Each person signs in from their own client address, so no test runs out
// another's sign in buckets.
async function person(kp: Keypair = wallet()): Promise<Person> {
  const { answer, token } = await signInWith(call, kp, { client: `client-${randomUUID()}` });
  expect(answer.status).toBe(200);
  if (token === undefined) throw new Error('no session cookie');
  return { key: kp, cookie: token, memberId: (answer.json?.['member'] as { id: string }).id };
}

function projectsOf(answer: Answer): ProjectView[] {
  return (answer.json?.['projects'] ?? []) as ProjectView[];
}

interface Organisation {
  readonly principalId: string;
  readonly first: ProjectContext;
  readonly second: ProjectContext;
}

async function organisation(owner: Person, name: string): Promise<Organisation> {
  const made = await call('POST', '/v1/principals', { cookie: owner.cookie, body: { name } });
  expect(made.status).toBe(201);
  const principalId = (made.json?.['principal'] as { id: string }).id;
  const first = (made.json?.['project'] as ProjectView).id;
  const added = await call('POST', '/v1/projects', {
    cookie: owner.cookie,
    body: { principalId, name: `${name} two` },
  });
  expect(added.status).toBe(201);
  const second = (added.json?.['project'] as ProjectView).id;
  return {
    principalId,
    first: { principalId, projectId: first },
    second: { principalId, projectId: second },
  };
}

async function auditOf(context: ProjectContext) {
  return (await db.principal(context).transaction((tx) => audit.list(tx, { limit: 100 }))).items;
}

describe('the console first sign in flow on Postgres', () => {
  it('signs in with a SEP-53 signature, names an organisation, adds a project and switches', async () => {
    const kp = wallet();
    const signed = await signInWith(call, kp, { client: `client-${randomUUID()}` });
    expect(signed.answer.status).toBe(200);
    expect(signed.answer.json?.['principals']).toEqual([]);
    const cookie = signed.token ?? '';
    const memberId = (signed.answer.json?.['member'] as { id: string }).id;

    const made = await call('POST', '/v1/principals', { cookie, body: { name: 'Acme' } });
    expect(made.status).toBe(201);
    const principal = made.json?.['principal'] as { id: string; name: string; role: string };
    const main = made.json?.['project'] as ProjectView;
    expect(principal).toEqual({ id: principal.id, name: 'Acme', role: 'owner' });
    expect(main).toMatchObject({ principalId: principal.id, name: FIRST_PROJECT_NAME });

    // The console reloads who it is after naming the organisation.
    const me = await call('GET', '/v1/me', { cookie });
    expect(me.json).toEqual({
      member: { id: memberId, address: kp.publicKey() },
      principals: [principal],
    });
    expect(projectsOf(await call('GET', '/v1/projects', { cookie }))).toEqual([main]);

    const added = await call('POST', '/v1/projects', {
      cookie,
      body: { principalId: principal.id, name: 'Payroll' },
      project: main.id,
    });
    expect(added.status).toBe(201);
    const payroll = added.json?.['project'] as ProjectView;
    expect(payroll).toMatchObject({ principalId: principal.id, name: 'Payroll' });
    expect(projectsOf(await call('GET', '/v1/projects', { cookie }))).toEqual([main, payroll]);

    for (const project of [main, payroll, main]) {
      const opened = await call('GET', '/v1/probe', { cookie, project: project.id });
      expect(opened.json).toEqual({
        principalId: principal.id,
        projectId: project.id,
        memberId,
        role: 'owner',
      });
    }

    // One chain for the principal: its creation, then the project, both by
    // the person who signed in, and intact.
    const context = { principalId: principal.id, projectId: main.id };
    expect(
      (await auditOf(context)).map((e) => [e.action, e.projectId, e.actorKind, e.actorId]),
    ).toEqual([
      ['principal.created', main.id, 'member', memberId],
      ['project.created', payroll.id, 'member', memberId],
    ]);
    expect(await db.principal(context).transaction((tx) => audit.verify(tx))).toEqual({
      rows: 2n,
      firstBreak: null,
    });
  });
});

describe('two principals with two projects each', () => {
  let alice: Person;
  let bob: Person;
  let a: Organisation;
  let b: Organisation;

  beforeAll(async () => {
    alice = await person();
    bob = await person();
    a = await organisation(alice, 'Acme');
    b = await organisation(bob, 'Globex');
  });

  // Alice acting on Bob's tenant, once per route. A route added to
  // tenancyRoutes without a case here fails the check after the cases.
  const cases: Record<string, () => Promise<void>> = {
    createPrincipal: async () => {
      // Making a principal touches no other tenant: Bob still sees only his.
      const made = await call('POST', '/v1/principals', {
        cookie: alice.cookie,
        body: { name: 'Initech' },
        project: b.first.projectId,
      });
      expect(made.status).toBe(201);
      const ofBob = projectsOf(await call('GET', '/v1/projects', { cookie: bob.cookie }));
      expect(ofBob.map((p) => p.principalId)).toEqual([b.principalId, b.principalId]);
      expect((await auditOf(b.first)).map((e) => e.action)).toEqual([
        'principal.created',
        'project.created',
      ]);
    },
    listProjects: async () => {
      const ofAlice = projectsOf(
        await call('GET', '/v1/projects', { cookie: alice.cookie, project: b.first.projectId }),
      );
      expect(ofAlice.length).toBeGreaterThanOrEqual(2);
      expect(ofAlice.some((p) => p.principalId === b.principalId)).toBe(false);
      expect(ofAlice.map((p) => p.id)).toEqual(
        expect.arrayContaining([a.first.projectId, a.second.projectId]),
      );
    },
    createProject: async () => {
      const before = await auditOf(b.first);
      const theirs = await call('POST', '/v1/projects', {
        cookie: alice.cookie,
        body: { principalId: b.principalId, name: 'Inside job' },
      });
      expect(theirs.status).toBe(404);
      expect(errorCode(theirs)).toBe('NOT_FOUND');
      const nobody = await call('POST', '/v1/projects', {
        cookie: alice.cookie,
        body: { principalId: randomUUID(), name: 'Nowhere' },
      });
      expect(errorCode(nobody)).toBe('NOT_FOUND');
      const ofBob = projectsOf(await call('GET', '/v1/projects', { cookie: bob.cookie }));
      expect(ofBob.map((p) => p.name)).not.toContain('Inside job');
      expect(await auditOf(b.first)).toEqual(before);
    },
    probeRead: async () => {
      for (const project of [b.first.projectId, b.second.projectId, randomUUID()]) {
        const answer = await call('GET', '/v1/probe', { cookie: alice.cookie, project });
        expect(answer.status).toBe(404);
        expect(errorCode(answer)).toBe('NOT_FOUND');
      }
    },
    probeWrite: async () => {
      const answer = await call('POST', '/v1/probe/write', {
        cookie: alice.cookie,
        project: b.second.projectId,
      });
      expect(errorCode(answer)).toBe('NOT_FOUND');
    },
    probeKeys: async () => {
      const answer = await call('POST', '/v1/probe/keys', {
        cookie: alice.cookie,
        project: b.first.projectId,
      });
      expect(errorCode(answer)).toBe('NOT_FOUND');
    },
    probeMembers: async () => {
      const answer = await call('POST', '/v1/probe/members', {
        cookie: alice.cookie,
        project: b.first.projectId,
      });
      expect(errorCode(answer)).toBe('NOT_FOUND');
    },
  };

  it.each(Object.keys(cases))('%s cannot reach the other principal', async (name) => {
    await cases[name]?.();
  });

  it('has a cross tenant case for every principal and project route', () => {
    const missing = routes.map((r) => r.operationId).filter((id) => !(id in cases));
    expect(missing).toEqual([]);
  });

  it('opens each of a person own projects, and only those', async () => {
    for (const context of [a.first, a.second]) {
      const opened = await call('GET', '/v1/probe', {
        cookie: alice.cookie,
        project: context.projectId,
      });
      expect(opened.json).toEqual({ ...context, memberId: alice.memberId, role: 'owner' });
    }
  });
});

describe('roles on Postgres', () => {
  const EXPECTED = {
    viewer: { read: 200, write: 403, keys: 403, members: 403, createProject: 403 },
    developer: { read: 200, write: 200, keys: 403, members: 403, createProject: 403 },
    admin: { read: 200, write: 200, keys: 200, members: 200, createProject: 201 },
  } as const;

  let owner: Person;
  let org: Organisation;

  beforeAll(async () => {
    owner = await person();
    org = await organisation(owner, 'Hooli');
  });

  async function member(role: MemberRole): Promise<Person> {
    const kp = wallet();
    // The address is canonical already: it is the keypair's own encoding,
    // which is what the adapter's parseAccount returns for it.
    await db
      .tenant(org.first)
      .transaction((tx) => members.add(tx, { walletAddress: kp.publicKey(), role }));
    return person(kp);
  }

  it.each(Object.keys(EXPECTED) as (keyof typeof EXPECTED)[])(
    'gives a %s exactly its permissions',
    async (role) => {
      const someone = await member(role);
      const expected = EXPECTED[role];
      const checks = [
        ['GET', '/v1/probe', expected.read],
        ['POST', '/v1/probe/write', expected.write],
        ['POST', '/v1/probe/keys', expected.keys],
        ['POST', '/v1/probe/members', expected.members],
      ] as const;
      for (const [method, path, status] of checks) {
        const answer = await call(method, path, {
          cookie: someone.cookie,
          project: org.second.projectId,
        });
        expect(answer.status, `${role} ${path}`).toBe(status);
      }
      const created = await call('POST', '/v1/projects', {
        cookie: someone.cookie,
        body: { principalId: org.principalId, name: `${role} project` },
      });
      expect(created.status, `${role} createProject`).toBe(expected.createProject);
      // Every member sees every project of the principal, whatever the role.
      const listed = projectsOf(await call('GET', '/v1/projects', { cookie: someone.cookie }));
      expect(listed.map((p) => p.id)).toEqual(
        expect.arrayContaining([org.first.projectId, org.second.projectId]),
      );
    },
  );

  it('ends a suspended member access on their next request', async () => {
    const someone = await member('developer');
    expect(
      (await call('GET', '/v1/probe', { cookie: someone.cookie, project: org.first.projectId }))
        .status,
    ).toBe(200);
    await db
      .tenant(org.first)
      .transaction((tx) => members.setStatus(tx, someone.memberId, 'suspended'));
    const after = await call('GET', '/v1/probe', {
      cookie: someone.cookie,
      project: org.first.projectId,
    });
    expect(errorCode(after)).toBe('NOT_FOUND');
    expect(projectsOf(await call('GET', '/v1/projects', { cookie: someone.cookie }))).toEqual([]);
    const created = await call('POST', '/v1/projects', {
      cookie: someone.cookie,
      body: { principalId: org.principalId, name: 'After suspension' },
    });
    expect(errorCode(created)).toBe('NOT_FOUND');
  });
});

describe('logs', () => {
  it('never carry a name, a token or an address', () => {
    expect(lines.some((line) => line.includes('event=principal_created'))).toBe(true);
    for (const line of lines) {
      expect(line).not.toMatch(/G[A-Z2-7]{55}/);
      expect(line).not.toMatch(/[A-Za-z0-9_-]{43}/);
      expect(line).not.toMatch(/Acme|Globex|Hooli|Initech|Payroll/);
    }
  });
});
