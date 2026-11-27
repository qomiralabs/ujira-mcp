// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// Every project made through /v1 is set up once it commits, which is where it
// gets its agent key. A setup that fails is logged, and the project is still
// answered as made: it exists, and a client retrying the create would only
// make a second one. Setup is safe to run again, so the next call repairs it.

import { describe, expect, it } from 'vitest';

import type { ProjectContext } from '../src/db/index.js';
import { signInWith, wallet } from './sign-in-helpers.js';
import { tenancyHarness } from './tenancy-helpers.js';

async function signedIn(h: ReturnType<typeof tenancyHarness>): Promise<string> {
  const { token } = await signInWith(h.call, wallet());
  if (token === undefined) throw new Error('sign in failed');
  return token;
}

describe('project setup', () => {
  it('runs for the first project of a principal and for every project after it', async () => {
    const setUp: { context: ProjectContext; requestId: string }[] = [];
    const h = tenancyHarness({
      onProjectCreated: (context, requestId) => {
        setUp.push({ context, requestId });
        return Promise.resolve();
      },
    });
    const cookie = await signedIn(h);

    const made = await h.call('POST', '/v1/principals', { cookie, body: { name: 'Acme' } });
    expect(made.status).toBe(201);
    const principal = made.json?.['principal'] as { id: string };
    const main = made.json?.['project'] as { id: string };
    const added = await h.call('POST', '/v1/projects', {
      cookie,
      body: { principalId: principal.id, name: 'Payroll' },
    });
    expect(added.status).toBe(201);
    const payroll = added.json?.['project'] as { id: string };

    expect(setUp.map((s) => s.context)).toEqual([
      { principalId: principal.id, projectId: main.id },
      { principalId: principal.id, projectId: payroll.id },
    ]);
    expect(setUp.every((s) => s.requestId.length > 0)).toBe(true);
  });

  it('logs a failed setup by kind only and still answers the project as made', async () => {
    const h = tenancyHarness({
      onProjectCreated: () => Promise.reject(new TypeError('friendbot at 10.0.0.7 said no')),
    });
    const cookie = await signedIn(h);
    const made = await h.call('POST', '/v1/principals', { cookie, body: { name: 'Acme' } });
    expect(made.status).toBe(201);
    const project = made.json?.['project'] as { id: string };

    const failed = h.lines.filter((l) => l.startsWith('event=project_setup_failed'));
    expect(failed).toHaveLength(1);
    expect(failed[0]).toContain(`project=${project.id}`);
    expect(failed[0]).toContain('level=error');
    expect(failed[0]).toContain('error=TypeError');
    expect(failed[0]).not.toContain('10.0.0.7');
  });
});
