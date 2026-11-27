// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// Principals, projects, and the project and role check every session route
// runs, on /v1 with the memory store. Two principals with two projects each,
// a member of every role, and the console's own first sign in flow. The same
// routes run against Postgres in tenancy-routes.db.test.ts.

import { randomUUID } from 'node:crypto';

import { Validator } from '@seriousme/openapi-schema-validator';
import type { Keypair } from '@stellar/stellar-sdk';
import { describe, expect, it } from 'vitest';

import { DatabaseUnavailableError } from '../src/db/index.js';
import { can, PERMISSIONS } from '../src/tenancy/roles.js';
import { FIRST_PROJECT_NAME, Tenancy, TenancyError } from '../src/tenancy/tenancy.js';
import { errorCode, signInWith, wallet, type Answer, type Call } from './sign-in-helpers.js';
import { tenancyHarness, type TenancyHarness } from './tenancy-helpers.js';

interface ProjectView {
  readonly id: string;
  readonly principalId: string;
  readonly name: string;
  readonly createdAt: string;
}

async function signedIn(call: Call, kp: Keypair = wallet()): Promise<string> {
  const { token } = await signInWith(call, kp, { client: randomUUID() });
  if (token === undefined) throw new Error('no session cookie');
  return token;
}

function projectsOf(answer: Answer): ProjectView[] {
  return (answer.json?.['projects'] ?? []) as ProjectView[];
}

/** A principal made through the route, with its first project and a second one. */
async function organisation(
  h: TenancyHarness,
  cookie: string,
  name: string,
): Promise<{ principalId: string; first: string; second: string }> {
  const made = await h.call('POST', '/v1/principals', { cookie, body: { name } });
  expect(made.status).toBe(201);
  const principal = made.json?.['principal'] as { id: string };
  const project = made.json?.['project'] as ProjectView;
  const second = await h.call('POST', '/v1/projects', {
    cookie,
    body: { principalId: principal.id, name: `${name} two` },
  });
  expect(second.status).toBe(201);
  return {
    principalId: principal.id,
    first: project.id,
    second: (second.json?.['project'] as ProjectView).id,
  };
}

describe('the console first sign in flow', () => {
  it('signs in, names an organisation, adds a project and switches between them', async () => {
    const h = tenancyHarness();
    const kp = wallet();
    const first = await signInWith(h.call, kp, { client: randomUUID() });
    const cookie = first.token ?? '';
    // A new wallet belongs to nothing yet, so the console asks for a name.
    expect(first.answer.json?.['principals']).toEqual([]);

    const made = await h.call('POST', '/v1/principals', { cookie, body: { name: '  Acme  ' } });
    expect(made.status).toBe(201);
    const principal = made.json?.['principal'] as { id: string; name: string; role: string };
    const main = made.json?.['project'] as ProjectView;
    expect(principal).toEqual({ id: principal.id, name: 'Acme', role: 'owner' });
    expect(main).toEqual({
      id: main.id,
      principalId: principal.id,
      name: FIRST_PROJECT_NAME,
      createdAt: main.createdAt,
    });
    expect(Number.isNaN(Date.parse(main.createdAt))).toBe(false);

    const me = await h.call('GET', '/v1/me', { cookie });
    expect(me.json?.['principals']).toEqual([principal]);

    const listed = await h.call('GET', '/v1/projects', { cookie });
    expect(listed.status).toBe(200);
    expect(projectsOf(listed)).toEqual([main]);

    const added = await h.call('POST', '/v1/projects', {
      cookie,
      body: { principalId: principal.id, name: 'Payroll' },
      project: main.id,
    });
    expect(added.status).toBe(201);
    const payroll = (added.json?.['project'] ?? {}) as ProjectView;
    expect(payroll).toMatchObject({ principalId: principal.id, name: 'Payroll' });
    expect(projectsOf(await h.call('GET', '/v1/projects', { cookie }))).toEqual([main, payroll]);

    // Switching is the header the console sends: each request runs in the
    // project it names.
    for (const project of [main, payroll, main]) {
      const opened = await h.call('GET', '/v1/probe', { cookie, project: project.id });
      expect(opened.status).toBe(200);
      expect(opened.json).toEqual({
        principalId: principal.id,
        projectId: project.id,
        memberId: (me.json?.['member'] as { id: string }).id,
        role: 'owner',
      });
    }
  });
});

describe('two principals with two projects each', () => {
  async function world() {
    const h = tenancyHarness();
    const aliceKey = wallet();
    const bobKey = wallet();
    const alice = await signedIn(h.call, aliceKey);
    const bob = await signedIn(h.call, bobKey);
    const a = await organisation(h, alice, 'Acme');
    const b = await organisation(h, bob, 'Globex');
    return { h, alice, bob, aliceKey, bobKey, a, b };
  }

  it('shows each person only the principals and projects they belong to', async () => {
    const { h, alice, bob, a, b } = await world();
    const ofAlice = projectsOf(await h.call('GET', '/v1/projects', { cookie: alice }));
    expect(ofAlice.map((p) => p.id).sort()).toEqual([a.first, a.second].sort());
    expect(ofAlice.every((p) => p.principalId === a.principalId)).toBe(true);
    const ofBob = projectsOf(await h.call('GET', '/v1/projects', { cookie: bob }));
    expect(ofBob.map((p) => p.id).sort()).toEqual([b.first, b.second].sort());
    const me = await h.call('GET', '/v1/me', { cookie: alice });
    expect((me.json?.['principals'] as { id: string }[]).map((p) => p.id)).toEqual([a.principalId]);
  });

  it('answers 404, the same as for no project at all, for a project of another principal', async () => {
    const { h, alice, b } = await world();
    const theirs = await h.call('GET', '/v1/probe', { cookie: alice, project: b.first });
    const nobody = await h.call('GET', '/v1/probe', { cookie: alice, project: randomUUID() });
    for (const answer of [theirs, nobody]) {
      expect(answer.status).toBe(404);
      expect(errorCode(answer)).toBe('NOT_FOUND');
    }
    const strip = (x: Answer) => ({
      ...(x.json?.['error'] as Record<string, unknown>),
      requestId: '',
    });
    expect(strip(theirs)).toEqual(strip(nobody));
    for (const path of ['/v1/probe/write', '/v1/probe/keys', '/v1/probe/members']) {
      const write = await h.call('POST', path, { cookie: alice, project: b.second });
      expect(errorCode(write), path).toBe('NOT_FOUND');
    }
  });

  it('creates no project in a principal the person does not belong to', async () => {
    const { h, alice, b } = await world();
    const before = h.store.projectRows.size;
    const theirs = await h.call('POST', '/v1/projects', {
      cookie: alice,
      body: { principalId: b.principalId, name: 'Inside job' },
    });
    const nobody = await h.call('POST', '/v1/projects', {
      cookie: alice,
      body: { principalId: randomUUID(), name: 'Nowhere' },
    });
    expect(errorCode(theirs)).toBe('NOT_FOUND');
    expect(errorCode(nobody)).toBe('NOT_FOUND');
    expect(h.store.projectRows.size).toBe(before);
  });

  it('ends access to a principal on the next request once the person is taken out of it', async () => {
    const { h, bob, aliceKey, alice, a } = await world();
    h.store.removeMember(aliceKey.publicKey(), a.principalId);
    expect(errorCode(await h.call('GET', '/v1/probe', { cookie: alice, project: a.first }))).toBe(
      'NOT_FOUND',
    );
    expect(projectsOf(await h.call('GET', '/v1/projects', { cookie: alice }))).toEqual([]);
    // Bob is untouched.
    expect(projectsOf(await h.call('GET', '/v1/projects', { cookie: bob })).length).toBe(2);
  });

  it('ignores a stale project header on the routes about the person', async () => {
    const { h, alice, b } = await world();
    const listed = await h.call('GET', '/v1/projects', { cookie: alice, project: b.first });
    expect(listed.status).toBe(200);
    const made = await h.call('POST', '/v1/principals', {
      cookie: alice,
      body: { name: 'Initech' },
      project: 'not-a-project',
    });
    expect(made.status).toBe(201);
  });
});

describe('roles', () => {
  const ROUTES = [
    ['GET', '/v1/probe', 'read'],
    ['POST', '/v1/probe/write', 'write'],
    ['POST', '/v1/probe/keys', 'manage_keys'],
    ['POST', '/v1/probe/members', 'manage_members'],
  ] as const;

  // Viewers read, developers also write, owners and admins do everything.
  const EXPECTED = {
    viewer: { read: 200, write: 403, manage_keys: 403, manage_members: 403, createProject: 403 },
    developer: { read: 200, write: 200, manage_keys: 403, manage_members: 403, createProject: 403 },
    admin: { read: 200, write: 200, manage_keys: 200, manage_members: 200, createProject: 201 },
    owner: { read: 200, write: 200, manage_keys: 200, manage_members: 200, createProject: 201 },
  } as const;

  it.each(Object.keys(EXPECTED) as (keyof typeof EXPECTED)[])(
    'gives a %s exactly its permissions',
    async (role) => {
      const h = tenancyHarness();
      const owner = await signedIn(h.call);
      const a = await organisation(h, owner, 'Acme');
      const kp = wallet();
      if (role !== 'owner') h.store.addMember(kp.publicKey(), a.principalId, role);
      const cookie = role === 'owner' ? owner : await signedIn(h.call, kp);
      for (const [method, path, permission] of ROUTES) {
        const answer = await h.call(method, path, { cookie, project: a.second });
        expect(answer.status, `${role} ${permission}`).toBe(EXPECTED[role][permission]);
        if (answer.status === 403) expect(errorCode(answer)).toBe('FORBIDDEN');
        else expect(answer.json).toMatchObject({ projectId: a.second, role });
      }
      const created = await h.call('POST', '/v1/projects', {
        cookie,
        body: { principalId: a.principalId, name: `${role} made this` },
      });
      expect(created.status, `${role} createProject`).toBe(EXPECTED[role].createProject);
      if (created.status === 403) expect(errorCode(created)).toBe('FORBIDDEN');
    },
  );

  it('grants nothing to a role this code does not know', () => {
    for (const permission of PERMISSIONS) {
      expect(can('auditor', permission)).toBe(false);
      expect(can('toString', permission)).toBe(false);
      expect(can('', permission)).toBe(false);
    }
    expect(can('owner', 'manage_projects')).toBe(true);
    expect(can('viewer', 'read')).toBe(true);
  });

  it('refuses a member whose role is unknown, even to read', async () => {
    const h = tenancyHarness();
    const owner = await signedIn(h.call);
    const a = await organisation(h, owner, 'Acme');
    const kp = wallet();
    h.store.grant(kp.publicKey(), { principalId: a.principalId, name: 'Acme', role: 'auditor' });
    const cookie = await signedIn(h.call, kp);
    expect(errorCode(await h.call('GET', '/v1/probe', { cookie, project: a.first }))).toBe(
      'FORBIDDEN',
    );
  });
});

describe('the project header', () => {
  it('is required, must be a UUID, and is read in any case', async () => {
    const h = tenancyHarness();
    const cookie = await signedIn(h.call);
    const a = await organisation(h, cookie, 'Acme');
    const missing = await h.call('GET', '/v1/probe', { cookie });
    expect(missing.status).toBe(400);
    expect(missing.json?.['error']).toMatchObject({
      code: 'INVALID_REQUEST',
      details: [{ path: 'header.ujira-project', issue: 'required' }],
    });
    const malformed = await h.call('GET', '/v1/probe', { cookie, project: 'acme' });
    expect(malformed.json?.['error']).toMatchObject({
      code: 'INVALID_REQUEST',
      details: [{ path: 'header.ujira-project', issue: 'invalid' }],
    });
    const upper = await h.call('GET', '/v1/probe', { cookie, project: a.first.toUpperCase() });
    expect(upper.status).toBe(200);
    expect(upper.json).toMatchObject({ projectId: a.first });
  });

  it('is judged only after the session, so a caller who is not signed in always gets 401', async () => {
    const h = tenancyHarness();
    for (const project of [undefined, 'acme', randomUUID()]) {
      const answer = await h.call('GET', '/v1/probe', {
        ...(project === undefined ? {} : { project }),
      });
      expect(answer.status).toBe(401);
      expect(errorCode(answer)).toBe('SESSION_INVALID');
    }
  });

  it('refuses a write from another origin before anything else', async () => {
    const h = tenancyHarness();
    const cookie = await signedIn(h.call);
    const a = await organisation(h, cookie, 'Acme');
    for (const origin of ['https://evil.example', null]) {
      const write = await h.call('POST', '/v1/probe/write', { cookie, project: a.first, origin });
      expect(errorCode(write)).toBe('ORIGIN_NOT_ALLOWED');
    }
    // A read is not a write and needs no Origin.
    expect(
      (await h.call('GET', '/v1/probe', { cookie, project: a.first, origin: null })).status,
    ).toBe(200);
  });
});

describe('POST /v1/principals and POST /v1/projects', () => {
  it('refuse writes from another origin', async () => {
    const h = tenancyHarness();
    const cookie = await signedIn(h.call);
    const a = await organisation(h, cookie, 'Acme');
    const before = h.store.projectRows.size;
    for (const origin of ['https://evil.example', null]) {
      const principal = await h.call('POST', '/v1/principals', {
        cookie,
        body: { name: 'Forged' },
        origin,
      });
      expect(errorCode(principal)).toBe('ORIGIN_NOT_ALLOWED');
      const project = await h.call('POST', '/v1/projects', {
        cookie,
        body: { principalId: a.principalId, name: 'Forged' },
        origin,
      });
      expect(errorCode(project)).toBe('ORIGIN_NOT_ALLOWED');
    }
    expect(h.store.projectRows.size).toBe(before);
  });

  it('need a session', async () => {
    const h = tenancyHarness();
    for (const [method, path, body] of [
      ['POST', '/v1/principals', { name: 'Acme' }],
      ['GET', '/v1/projects', undefined],
      ['POST', '/v1/projects', { principalId: randomUUID(), name: 'Acme' }],
    ] as const) {
      const answer = await h.call(method, path, body === undefined ? {} : { body });
      expect(answer.status, path).toBe(401);
      expect(errorCode(answer), path).toBe('SESSION_INVALID');
    }
  });

  it('refuse names that are empty, too long, or hold control characters, and unknown fields', async () => {
    const h = tenancyHarness();
    const cookie = await signedIn(h.call);
    const a = await organisation(h, cookie, 'Acme');
    for (const name of ['', '   ', 'x'.repeat(201), 'tab\there', 'line\nbreak', 7]) {
      const principal = await h.call('POST', '/v1/principals', { cookie, body: { name } });
      expect(errorCode(principal), JSON.stringify(name)).toBe('INVALID_REQUEST');
      const project = await h.call('POST', '/v1/projects', {
        cookie,
        body: { principalId: a.principalId, name },
      });
      expect(errorCode(project), JSON.stringify(name)).toBe('INVALID_REQUEST');
    }
    expect(
      errorCode(
        await h.call('POST', '/v1/principals', { cookie, body: { name: 'Acme', role: 'admin' } }),
      ),
    ).toBe('INVALID_REQUEST');
    expect(
      errorCode(
        await h.call('POST', '/v1/projects', { cookie, body: { principalId: 'acme', name: 'x' } }),
      ),
    ).toBe('INVALID_REQUEST');
    // 200 characters is the limit, not past it.
    const longest = await h.call('POST', '/v1/principals', {
      cookie,
      body: { name: 'y'.repeat(200) },
    });
    expect(longest.status).toBe(201);
  });

  it('reads a principal id written in capitals as the same principal', async () => {
    const h = tenancyHarness();
    const cookie = await signedIn(h.call);
    const a = await organisation(h, cookie, 'Acme');
    const made = await h.call('POST', '/v1/projects', {
      cookie,
      body: { principalId: a.principalId.toUpperCase(), name: 'Shouted' },
    });
    expect(made.status).toBe(201);
    expect(made.json?.['project']).toMatchObject({ principalId: a.principalId });
  });

  it('write an audit entry for each principal and project, by the member who made it', async () => {
    const h = tenancyHarness();
    const kp = wallet();
    const signed = await signInWith(h.call, kp, { client: randomUUID() });
    const memberId = (signed.answer.json?.['member'] as { id: string }).id;
    const a = await organisation(h, signed.token ?? '', 'Acme');
    expect(h.store.audit).toEqual([
      {
        principalId: a.principalId,
        projectId: a.first,
        action: 'principal.created',
        actorId: memberId,
      },
      {
        principalId: a.principalId,
        projectId: a.second,
        action: 'project.created',
        actorId: memberId,
      },
    ]);
  });

  it('answer 503 with Retry-After when the database is down', async () => {
    const h = tenancyHarness();
    const cookie = await signedIn(h.call);
    h.store.failWith = new DatabaseUnavailableError('08006');
    for (const [method, path, body] of [
      ['POST', '/v1/principals', { name: 'Acme' }],
      ['GET', '/v1/projects', undefined],
      ['POST', '/v1/projects', { principalId: randomUUID(), name: 'Acme' }],
    ] as const) {
      const answer = await h.call(method, path, {
        cookie,
        ...(body === undefined ? {} : { body }),
      });
      expect(answer.status, path).toBe(503);
      expect(errorCode(answer)).toBe('DB_UNAVAILABLE');
      expect(answer.headers.get('retry-after')).toBe('5');
    }
  });

  it('never log a name or an address', async () => {
    const h = tenancyHarness();
    const kp = wallet();
    const cookie = await signedIn(h.call, kp);
    await organisation(h, cookie, 'Zanzibar Holdings');
    const joined = h.lines.join('\n');
    expect(joined).toContain('event=principal_created');
    expect(joined).toContain('event=project_created');
    expect(joined).not.toContain('Zanzibar');
    expect(joined).not.toContain(kp.publicKey());
  });
});

describe('the tenancy service', () => {
  it('reports SESSION_INVALID when the session ended before the principal was written', async () => {
    const tenancy = new Tenancy({
      store: {
        createPrincipal: () => Promise.resolve(undefined),
        principals: () => Promise.resolve([]),
        projects: () => Promise.resolve([]),
        createProject: () => Promise.reject(new Error('not called')),
      },
    });
    const actor = { memberId: randomUUID(), walletAddress: 'G', tokenSha256: Buffer.alloc(32) };
    await expect(tenancy.createPrincipal(actor, 'Acme', 'r')).rejects.toMatchObject({
      name: 'TenancyError',
      code: 'SESSION_INVALID',
    });
    await expect(tenancy.createProject(actor, randomUUID(), 'x', 'r')).rejects.toBeInstanceOf(
      TenancyError,
    );
  });

  it('answers 401 on the route when that happens', async () => {
    const h = tenancyHarness();
    const cookie = await signedIn(h.call);
    // The session lapses between the check and the write.
    const original = h.store.createPrincipal.bind(h.store);
    h.store.createPrincipal = (input) => original({ ...input, tokenSha256: Buffer.alloc(32) });
    const answer = await h.call('POST', '/v1/principals', { cookie, body: { name: 'Acme' } });
    expect(answer.status).toBe(401);
    expect(errorCode(answer)).toBe('SESSION_INVALID');
    expect(h.store.projectRows.size).toBe(0);
  });
});

describe('the OpenAPI document', () => {
  it('lists the principal and project routes and is valid OpenAPI 3.1', async () => {
    const h = tenancyHarness();
    const res = await h.call('GET', '/v1/openapi.json');
    const result = await new Validator().validate(res.json ?? {});
    expect(result.errors).toBeUndefined();
    const paths = (res.json?.['paths'] ?? {}) as Record<string, Record<string, unknown>>;
    expect(Object.keys(paths['/v1/principals'] ?? {})).toEqual(['post']);
    expect(Object.keys(paths['/v1/projects'] ?? {}).sort()).toEqual(['get', 'post']);
  });
});
