// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The developers screen on /v1, against the fake client: the project's keys,
// a new key's text shown once and gone when its dialog closes, revoking only
// after a confirm and only as the server answers, the calm state for members
// who cannot manage keys, and each mandate's MCP address.

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';

import { AppContext, type AppState } from '../app/context';
import { SessionContext, type Session } from '../app/session';
import type { V1Screen } from '../app/switch';
import { ApiError } from '../lib/api';
import type { Project, SessionInfo } from '../lib/auth';
import { createFakeAuthApi, type FakeAuthApi } from '../lib/fakeAuth';
import { createFakeV1Api, type FakeV1Api } from '../lib/fakeV1';
import { createMockApi } from '../lib/mock';
import type { Config } from '../lib/schemas';
import type { V1Api } from '../lib/v1';
import type { ApiKey } from '../lib/v1Schemas';
import { MOCK_WALLET, mockWallet } from '../lib/wallet';
import { DevelopersPage } from './Developers';

const CONFIG: Config = {
  network: 'testnet',
  networkPassphrase: 'Test SDF Network ; September 2015',
  explorerTxBase: 'https://stellar.expert/explorer/testnet/tx/',
  asset: { code: 'USDC', issuer: MOCK_WALLET, decimals: 7 },
  sdpAvailable: false,
};

const DEVELOPERS = new Set<V1Screen>(['developers']);

function must<T>(value: T | null | undefined): T {
  if (value === undefined || value === null) throw new Error('missing test data');
  return value;
}

interface World {
  readonly auth: FakeAuthApi;
  readonly v1: FakeV1Api;
  readonly info: SessionInfo;
  readonly projects: readonly Project[];
  readonly main: Project;
  readonly grants: Project;
}

async function world(): Promise<World> {
  const auth = createFakeAuthApi({
    delayMs: 0,
    seed: [
      { address: MOCK_WALLET, principals: [{ name: 'Acme Ltd', projects: ['Main', 'Grants'] }] },
    ],
    signedInAs: MOCK_WALLET,
  });
  const info = await auth.me();
  const projects = await auth.projects();
  const main = must(projects.find((p) => p.name === 'Main'));
  const grants = must(projects.find((p) => p.name === 'Grants'));
  auth.useProject(main.id);
  return { auth, v1: createFakeV1Api(auth, { delayMs: 0 }), info, projects, main, grants };
}

function sessionFor(w: World, project: Project, role?: string): Session {
  const principal = must(w.info.principals[0]);
  return {
    member: w.info.member,
    principals: w.info.principals,
    projects: w.projects,
    project,
    principal: role === undefined ? principal : { ...principal, role },
    selectProject: () => undefined,
    createProject: () => Promise.resolve(),
    signOut: () => Promise.resolve(),
  };
}

function tree(v1: V1Api, session: Session, notify: (m: string) => void = () => undefined) {
  const state: AppState = {
    api: createMockApi({ delayMs: 0 }),
    v1,
    v1Screens: DEVELOPERS,
    config: CONFIG,
    mock: true,
    wallet: mockWallet(MOCK_WALLET),
    setWallet: () => undefined,
    notify,
  };
  return (ui: ReactNode = <DevelopersPage />) => (
    <AppContext.Provider value={state}>
      <SessionContext.Provider value={session}>{ui}</SessionContext.Provider>
    </AppContext.Provider>
  );
}

function keysCard() {
  return screen.getByRole('region', { name: /^API keys/ });
}

async function createKey(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(await screen.findByRole('button', { name: 'Create key' }));
  const dialog = await screen.findByRole('dialog', { name: 'Create a key' });
  await user.type(within(dialog).getByLabelText('Name'), name);
  await user.click(within(dialog).getByRole('button', { name: 'Create key' }));
  return screen.findByRole('dialog', { name: 'Your new key' });
}

describe('the developers screen on /v1', () => {
  it('shows a new key once with a copy button, and forgets it when the dialog closes', async () => {
    const w = await world();
    const user = userEvent.setup();
    const made: { apiKey: ApiKey; secret: string }[] = [];
    const v1: V1Api = {
      ...w.v1,
      createApiKey: async (input) => {
        const answer = await w.v1.createApiKey(input);
        made.push(answer);
        return answer;
      },
    };
    render(tree(v1, sessionFor(w, w.main))());
    expect(await within(keysCard()).findByText('No keys yet.', { exact: false })).toBeTruthy();
    expect(within(keysCard()).getByText('0 of 20 active')).toBeTruthy();

    const reveal = await createKey(user, 'Payroll runner');
    const { apiKey, secret } = must(made[0]);
    expect(apiKey.scopes).toEqual(['payouts:read', 'payouts:write']);
    expect(within(reveal).getByText('Copy it now. You won’t see it again.')).toBeTruthy();
    expect(within(reveal).getByLabelText('Your new API key')).toHaveProperty('value', secret);
    await user.click(within(reveal).getByRole('button', { name: 'Copy key' }));
    expect(await navigator.clipboard.readText()).toBe(secret);

    // The list shows the key by its prefix, never by its whole text.
    const row = await within(keysCard()).findByText('Payroll runner', { selector: 'strong' });
    expect(row).toBeTruthy();
    expect(within(keysCard()).getByText(apiKey.prefix)).toBeTruthy();
    expect(keysCard().textContent).not.toContain(secret);
    expect(within(keysCard()).getByText('1 of 20 active')).toBeTruthy();

    await user.click(within(reveal).getByRole('button', { name: 'Done' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Your new key' })).toBeNull();
    });
    expect(document.documentElement.outerHTML).not.toContain(secret);
    const stored = [localStorage, sessionStorage].flatMap((s) =>
      Object.keys(s).map((k) => s.getItem(k) ?? ''),
    );
    expect(stored.some((v) => v.includes(secret))).toBe(false);
  });

  it('sends the name, the chosen access and the expiry, and checks them first', async () => {
    const w = await world();
    const user = userEvent.setup();
    const sent: unknown[] = [];
    const v1: V1Api = {
      ...w.v1,
      createApiKey: (input) => {
        sent.push(input);
        return w.v1.createApiKey(input);
      },
    };
    render(tree(v1, sessionFor(w, w.main))());
    await user.click(await screen.findByRole('button', { name: 'Create key' }));
    const dialog = await screen.findByRole('dialog', { name: 'Create a key' });
    const days = within(dialog).getByLabelText('Expires after');
    expect(days).toHaveProperty('value', '365');

    // Nothing chosen, no name, an expiry out of range: three answers, no request.
    for (const area of ['Payouts']) {
      const group = within(dialog).getByRole('group', { name: area });
      await user.click(within(group).getByRole('checkbox', { name: 'Read' }));
      await user.click(within(group).getByRole('checkbox', { name: 'Write' }));
    }
    await user.clear(days);
    await user.type(days, '731');
    await user.click(within(dialog).getByRole('button', { name: 'Create key' }));
    expect(within(dialog).getByText('Name the key.')).toBeTruthy();
    expect(within(dialog).getByText('Choose at least one.')).toBeTruthy();
    expect(within(dialog).getByText('Between 1 and 730 days.')).toBeTruthy();
    expect(sent).toEqual([]);

    // Webhooks are shown, but not offered yet.
    const webhooks = within(dialog).getByRole('group', { name: /Webhooks/ });
    expect(within(webhooks).getByText('Soon')).toBeTruthy();
    expect(within(webhooks).getByRole('checkbox', { name: 'Manage' })).toHaveProperty(
      'disabled',
      true,
    );

    await user.type(within(dialog).getByLabelText('Name'), 'Reporting');
    const receipts = within(dialog).getByRole('group', { name: 'Receipts' });
    await user.click(within(receipts).getByRole('checkbox', { name: 'Read' }));
    await user.clear(days);
    await user.type(days, '30');
    await user.click(within(dialog).getByRole('button', { name: 'Create key' }));
    await screen.findByRole('dialog', { name: 'Your new key' });
    expect(sent).toEqual([{ name: 'Reporting', scopes: ['receipts:read'], expiresInDays: 30 }]);
  });

  it('shows the limit the server answers with, inside the dialog', async () => {
    const w = await world();
    const user = userEvent.setup();
    const v1: V1Api = {
      ...w.v1,
      createApiKey: () =>
        Promise.reject(
          new ApiError(
            'API_KEY_LIMIT_REACHED',
            'This project has 20 active keys. Revoke one to make another.',
            409,
          ),
        ),
    };
    render(tree(v1, sessionFor(w, w.main))());
    await user.click(await screen.findByRole('button', { name: 'Create key' }));
    const dialog = await screen.findByRole('dialog', { name: 'Create a key' });
    await user.type(within(dialog).getByLabelText('Name'), 'One more');
    await user.click(within(dialog).getByRole('button', { name: 'Create key' }));
    expect(
      await within(dialog).findByText(
        'This project has 20 active keys. Revoke one to make another.',
      ),
    ).toBeTruthy();
  });

  it('revokes only after a confirm, and shows it once the server has', async () => {
    const w = await world();
    const user = userEvent.setup();
    const notes: string[] = [];
    const { apiKey } = await w.v1.createApiKey({ name: 'Old runner', scopes: ['payouts:read'] });
    let release: () => void = () => undefined;
    const held = new Promise<void>((r) => {
      release = r;
    });
    const v1: V1Api = {
      ...w.v1,
      revokeApiKey: async (id) => {
        await held;
        return w.v1.revokeApiKey(id);
      },
    };
    render(tree(v1, sessionFor(w, w.main), (m) => notes.push(m))());
    await within(keysCard()).findByText('Old runner', { selector: 'strong' });

    await user.click(within(keysCard()).getByRole('button', { name: 'Revoke Old runner' }));
    let confirm = await screen.findByRole('dialog', { name: 'Revoke Old runner?' });
    await user.click(within(confirm).getByRole('button', { name: 'Cancel' }));
    expect((await w.v1.apiKeys()).items[0]?.revokedAt).toBeNull();

    await user.click(within(keysCard()).getByRole('button', { name: 'Revoke Old runner' }));
    confirm = await screen.findByRole('dialog', { name: 'Revoke Old runner?' });
    await user.click(within(confirm).getByRole('button', { name: 'Revoke key' }));
    // Nothing changes on screen until the server has answered.
    expect(within(keysCard()).queryByText('Revoked')).toBeNull();
    expect(within(keysCard()).getByText('1 of 20 active')).toBeTruthy();
    release();
    expect(await within(keysCard()).findByText('Revoked')).toBeTruthy();
    expect(within(keysCard()).getByText('0 of 20 active')).toBeTruthy();
    expect(within(keysCard()).queryByRole('button', { name: 'Revoke Old runner' })).toBeNull();
    const after = must((await w.v1.apiKeys()).items.find((k) => k.id === apiKey.id));
    expect(after.revokedAt).not.toBeNull();
    expect(notes).toEqual(['Old runner is revoked.']);
  });

  it('keeps the confirm open with the reason when revoking fails', async () => {
    const w = await world();
    const user = userEvent.setup();
    await w.v1.createApiKey({ name: 'Runner', scopes: ['payouts:read'] });
    const v1: V1Api = {
      ...w.v1,
      revokeApiKey: () =>
        Promise.reject(new ApiError('DB_UNAVAILABLE', 'UJIRA is busy for a moment.', 503)),
    };
    render(tree(v1, sessionFor(w, w.main))());
    await within(keysCard()).findByText('Runner', { selector: 'strong' });
    await user.click(within(keysCard()).getByRole('button', { name: 'Revoke Runner' }));
    const confirm = await screen.findByRole('dialog', { name: 'Revoke Runner?' });
    await user.click(within(confirm).getByRole('button', { name: 'Revoke key' }));
    expect(await within(confirm).findByText('UJIRA is busy for a moment.')).toBeTruthy();
    expect(within(keysCard()).queryByText('Revoked')).toBeNull();
  });

  it('tells members who cannot manage keys so, calmly, and asks the server nothing', async () => {
    const w = await world();
    let asked = 0;
    const v1: V1Api = {
      ...w.v1,
      apiKeys: (q) => {
        asked += 1;
        return w.v1.apiKeys(q);
      },
    };
    render(tree(v1, sessionFor(w, w.main, 'developer'))());
    expect(await screen.findByText('Only owners and admins manage keys.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Create key' })).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(asked).toBe(0);
  });

  it('shows the same calm state when the server refuses the role', async () => {
    const w = await world();
    const v1: V1Api = {
      ...w.v1,
      apiKeys: () =>
        Promise.reject(new ApiError('FORBIDDEN', 'Your role cannot do that here.', 403)),
    };
    render(tree(v1, sessionFor(w, w.main))());
    expect(await screen.findByText('Only owners and admins manage keys.')).toBeTruthy();
    expect(screen.queryByText('Your role cannot do that here.')).toBeNull();
  });

  it('shows a failed load with its reference, and loads on Try again', async () => {
    const w = await world();
    const user = userEvent.setup();
    let fail = true;
    const v1: V1Api = {
      ...w.v1,
      apiKeys: (q) =>
        fail
          ? Promise.reject(
              new ApiError('DB_UNAVAILABLE', 'UJIRA is busy.', 503, undefined, 'req-83'),
            )
          : w.v1.apiKeys(q),
    };
    render(tree(v1, sessionFor(w, w.main))());
    expect(await within(keysCard()).findByText('UJIRA is busy.')).toBeTruthy();
    expect(within(keysCard()).getByText('req-83')).toBeTruthy();
    fail = false;
    await user.click(within(keysCard()).getByRole('button', { name: 'Try again' }));
    expect(await within(keysCard()).findByText('0 of 20 active')).toBeTruthy();
  });

  it('keeps each project to its own keys', async () => {
    const w = await world();
    w.auth.useProject(w.grants.id);
    await w.v1.createApiKey({ name: 'Grants key', scopes: ['payouts:read'] });
    w.auth.useProject(w.main.id);
    const view = render(tree(w.v1, sessionFor(w, w.main))());
    await within(keysCard()).findByText('0 of 20 active');
    expect(within(keysCard()).queryByText('Grants key', { selector: 'strong' })).toBeNull();
    w.auth.useProject(w.grants.id);
    view.rerender(tree(w.v1, sessionFor(w, w.grants))());
    expect(await within(keysCard()).findByText('Grants key', { selector: 'strong' })).toBeTruthy();
  });

  it("gives the mandate's own MCP address and the steps to connect it", async () => {
    const w = await world();
    const user = userEvent.setup();
    render(tree(w.v1, sessionFor(w, w.main))());
    const m = must((await w.v1.mandates()).items[0]);
    const card = await screen.findByRole('region', { name: 'Connect Claude to Weekly payouts' });
    const url = `${location.origin}/m/${m.contractId}/mcp`;
    expect(within(card).getByLabelText('MCP address for this mandate')).toHaveProperty(
      'value',
      url,
    );
    await user.click(within(card).getByRole('button', { name: 'Copy address' }));
    expect(await navigator.clipboard.readText()).toBe(url);
    expect(within(card).getByText('In Claude, open Settings, then Connectors.')).toBeTruthy();

    // The examples name the same mandate, and are marked as not live yet.
    const examples = screen.getByRole('region', { name: /With an API key/ });
    expect(within(examples).getByText('Soon')).toBeTruthy();
    expect(examples.textContent).toContain(`"mandateId": "${m.id}"`);
    expect(examples.textContent).toContain(`${location.origin}/v1/mcp`);
  });
});
