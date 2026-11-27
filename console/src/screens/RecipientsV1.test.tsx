// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The recipients screen on /v1, against the fake client: one line per
// recipient in the open project, a sheet that says why a wallet cannot be
// paid and what fixes it, adding by label and address with the allowlist
// signature, and invite links that expire and can be revoked. Nothing on
// screen changes before the server shows it.

import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';

import { AppContext, type AppState } from '../app/context';
import { SessionContext, type Session } from '../app/session';
import type { V1Screen } from '../app/switch';
import { ApiError } from '../lib/api';
import type { Project, SessionInfo } from '../lib/auth';
import { createFakeAuthApi, type FakeAuthApi } from '../lib/fakeAuth';
import { createFakeV1Api, type FakeV1Api, type FakeV1Options } from '../lib/fakeV1';
import { createMockApi } from '../lib/mock';
import type { Config } from '../lib/schemas';
import { encodeAddress } from '../lib/strkey';
import type { V1Api } from '../lib/v1';
import { MOCK_WALLET, mockWallet } from '../lib/wallet';
import { RecipientsPage } from './Recipients';

const CONFIG: Config = {
  network: 'testnet',
  networkPassphrase: 'Test SDF Network ; September 2015',
  explorerTxBase: 'https://stellar.expert/explorer/testnet/tx/',
  asset: { code: 'USDC', issuer: MOCK_WALLET, decimals: 7 },
  sdpAvailable: false,
};

const RECIPIENTS = new Set<V1Screen>(['recipients']);
const CAROL = 'GCAROLAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
// A real account address, checksum and all, for the form.
const KWAME = encodeAddress('account', new Uint8Array(32).fill(7));

function must<T>(value: T | undefined | null): T {
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

async function world(options: FakeV1Options = {}): Promise<World> {
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
  const v1 = createFakeV1Api(auth, { delayMs: 0, ...options });
  return { auth, v1, info, projects, main, grants };
}

function sessionFor(w: World, project: Project): Session {
  return {
    member: w.info.member,
    principals: w.info.principals,
    projects: w.projects,
    project,
    principal: must(w.info.principals[0]),
    selectProject: () => undefined,
    createProject: () => Promise.resolve(),
    signOut: () => Promise.resolve(),
  };
}

function tree(
  ui: ReactNode,
  {
    v1,
    session,
    screens = RECIPIENTS,
    notify = () => undefined,
  }: {
    v1: V1Api;
    session: Session;
    screens?: ReadonlySet<V1Screen>;
    notify?: (message: string) => void;
  },
) {
  const state: AppState = {
    api: createMockApi({ delayMs: 0 }),
    v1,
    v1Screens: screens,
    config: CONFIG,
    mock: true,
    wallet: mockWallet(MOCK_WALLET),
    setWallet: () => undefined,
    notify,
  };
  return (
    <AppContext.Provider value={state}>
      <SessionContext.Provider value={session}>{ui}</SessionContext.Provider>
    </AppContext.Provider>
  );
}

/** Holds calls until the test lets them through, as a slow server or ledger would. */
function gate() {
  let open: () => void = () => undefined;
  const shut = new Promise<void>((r) => {
    open = r;
  });
  return {
    wait: () => shut,
    release: () => {
      open();
    },
  };
}

async function rowFor(label: string): Promise<HTMLElement> {
  return screen.findByRole('button', { name: new RegExp(`^Open ${label},`) });
}

async function openSheet(user: ReturnType<typeof userEvent.setup>, label: string) {
  await user.click(await rowFor(label));
  return screen.findByRole('dialog', { name: 'Recipient' });
}

async function seededMandate(w: World): Promise<string> {
  return must((await w.v1.mandates()).items[0]).id;
}

describe('recipients on /v1', () => {
  it('lists every recipient of the project on one line, with a word for each status', async () => {
    const w = await world();
    render(tree(<RecipientsPage />, { v1: w.v1, session: sessionFor(w, w.main) }));
    expect(screen.getByRole('status', { name: 'Loading recipients' })).toBeTruthy();
    expect(await rowFor('Ada')).toBeTruthy();
    expect((await rowFor('Ada')).getAttribute('aria-label')).toBe('Open Ada, Ready');
    expect((await rowFor('Musa')).getAttribute('aria-label')).toBe('Open Musa, No USDC');
    const zainab = await rowFor('Zainab');
    expect(zainab.getAttribute('aria-label')).toBe('Open Zainab, No wallet');
    expect(zainab.querySelector('.rrow-address')?.textContent).toBe('No wallet');
    expect(within(zainab).getByText('Weekly payouts')).toBeTruthy();
    expect(screen.getByText('4 recipients')).toBeTruthy();
    expect(screen.getByText('2 cannot be paid yet')).toBeTruthy();
    expect(screen.getByText('Soon')).toBeTruthy();
  });

  it('keys the list by project, so another project shows its own recipients', async () => {
    const w = await world();
    const { rerender } = render(
      tree(<RecipientsPage />, { v1: w.v1, session: sessionFor(w, w.main) }),
    );
    const mainAda = (await rowFor('Ada')).dataset['recipient'];
    w.auth.useProject(w.grants.id);
    rerender(tree(<RecipientsPage />, { v1: w.v1, session: sessionFor(w, w.grants) }));
    await waitFor(() => {
      const ada = screen.getByRole('button', { name: /^Open Ada,/ });
      expect(ada.dataset['recipient']).not.toBe(mainAda);
    });
    const grantsIds = (await w.v1.recipients()).items.map((r) => r.id);
    expect(grantsIds).toContain((await rowFor('Ada')).dataset['recipient']);
  });

  it('says why a wallet cannot be paid and what to do, then checks again', async () => {
    const w = await world({ destinations: { [CAROL]: 'no_trustline' } });
    const mandateId = await seededMandate(w);
    await w.v1.createRecipient({ mandateId, label: 'Kwame', address: CAROL });
    const said: string[] = [];
    const user = userEvent.setup();
    render(
      tree(<RecipientsPage />, {
        v1: w.v1,
        session: sessionFor(w, w.main),
        notify: (m) => said.push(m),
      }),
    );
    const sheet = await openSheet(user, 'Kwame');
    expect(await within(sheet).findByText('This wallet cannot hold USDC yet.')).toBeTruthy();
    expect(
      within(sheet).getByText('Ask them to add USDC in their wallet, then check again.'),
    ).toBeTruthy();
    expect(within(sheet).getByText('GCAR...AAAA')).toBeTruthy();

    // Still not fixed: the sheet says so and stays as it was.
    await user.click(within(sheet).getByRole('button', { name: 'Check again' }));
    await waitFor(() => {
      expect(said).toContain('Checked. Nothing has changed yet.');
    });
    expect(within(sheet).getByText('No USDC')).toBeTruthy();

    w.v1.setDestination(CAROL, 'receivable');
    await user.click(within(sheet).getByRole('button', { name: 'Check again' }));
    expect(await within(sheet).findByText('Ready')).toBeTruthy();
    expect(within(sheet).queryByText('This wallet cannot hold USDC yet.')).toBeNull();
    expect(said).toContain('Kwame can be paid now.');
  });

  it('shows checking until the server answers, and nothing before', async () => {
    const w = await world({ destinations: { [CAROL]: 'no_account' } });
    const mandateId = await seededMandate(w);
    const { recipient } = await w.v1.createRecipient({ mandateId, label: 'Kwame', address: CAROL });
    history.replaceState(null, '', `/app/recipients?open=${recipient.id}`);
    // The sheet's first read goes through; the check again is held.
    let calls = 0;
    const slow = gate();
    const api: V1Api = {
      ...w.v1,
      recipient: async (id) => {
        calls += 1;
        if (calls > 1) await slow.wait();
        return w.v1.recipient(id);
      },
    };
    const user = userEvent.setup();
    render(tree(<RecipientsPage />, { v1: api, session: sessionFor(w, w.main) }));
    const sheet = await screen.findByRole('dialog', { name: 'Recipient' });
    expect(await within(sheet).findByText('This wallet is not open on Stellar yet.')).toBeTruthy();
    w.v1.setDestination(CAROL, 'receivable');
    await user.click(within(sheet).getByRole('button', { name: 'Check again' }));
    expect(within(sheet).getByRole('button', { name: 'Checking' })).toBeTruthy();
    expect(within(sheet).getByText('Wallet not open')).toBeTruthy();
    await act(async () => {
      slow.release();
      await Promise.resolve();
    });
    expect(await within(sheet).findByText('Ready')).toBeTruthy();
  });

  it('tells a recipient on hold apart, and makes no link for them', async () => {
    const w = await world();
    const ada = must((await w.v1.recipients()).items.find((r) => r.label === 'Ada'));
    w.v1.suspendRecipient(ada.id);
    const user = userEvent.setup();
    render(tree(<RecipientsPage />, { v1: w.v1, session: sessionFor(w, w.main) }));
    const sheet = await openSheet(user, 'Ada');
    expect(await within(sheet).findByText('Payouts to them are on hold.')).toBeTruthy();
    expect(within(sheet).getByText('Not while payouts to them are on hold.')).toBeTruthy();
    expect(within(sheet).queryByRole('button', { name: 'Make a link' })).toBeNull();
  });

  it('opens the recipient a shared link names, and closing takes it out of the URL', async () => {
    const w = await world();
    const zainab = must((await w.v1.recipients()).items.find((r) => r.label === 'Zainab'));
    history.replaceState(null, '', `/app/recipients?open=${zainab.id}`);
    const user = userEvent.setup();
    render(tree(<RecipientsPage />, { v1: w.v1, session: sessionFor(w, w.main) }));
    const sheet = await screen.findByRole('dialog', { name: 'Recipient' });
    expect(await within(sheet).findByText('No wallet yet.')).toBeTruthy();
    expect(within(sheet).getByText('Send them an invite link to add one.')).toBeTruthy();
    await user.click(within(sheet).getByRole('button', { name: 'Close' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Recipient' })).toBeNull();
    });
    expect(location.search).toBe('');
  });

  describe('invite links', () => {
    it('makes a link that opens the widget, shows it once, and revokes it', async () => {
      const w = await world();
      const zainab = must((await w.v1.recipients()).items.find((r) => r.label === 'Zainab'));
      const said: string[] = [];
      const user = userEvent.setup();
      render(
        tree(<RecipientsPage />, {
          v1: w.v1,
          session: sessionFor(w, w.main),
          notify: (m) => said.push(m),
        }),
      );
      const sheet = await openSheet(user, 'Zainab');
      await user.selectOptions(await within(sheet).findByLabelText('Works for'), '7 days');
      await user.click(within(sheet).getByRole('button', { name: 'Make a link' }));
      const box = await within(sheet).findByLabelText('Invite link for Zainab');
      const link = new URL((box as HTMLInputElement).value);
      expect(link.origin).toBe(location.origin);
      expect(link.pathname).toBe('/embed/v1/invite');
      expect(link.search).toBe('');
      expect(link.hash).toMatch(/^#token=ujes_test_[0-9a-f]{48}$/);
      expect(within(sheet).getByText(/^Shown once\./)).toBeTruthy();

      const [made] = (await w.v1.embedSessions({ recipientId: zainab.id })).items;
      const days = (Date.parse(must(made).expiresAt) - Date.parse(must(made).createdAt)) / 864e5;
      expect(days).toBe(7);
      const list = await within(sheet).findByRole('list', { name: 'Invite links' });
      expect(await within(list).findByText(/^Works until/)).toBeTruthy();

      await user.click(within(list).getByRole('button', { name: 'Revoke' }));
      expect(await within(list).findByText('Revoked')).toBeTruthy();
      expect(within(list).queryByRole('button', { name: 'Revoke' })).toBeNull();
      // The link that was on screen goes with it.
      expect(within(sheet).queryByLabelText('Invite link for Zainab')).toBeNull();
      expect(said).toContain('Link revoked. It no longer opens.');
      const [after] = (await w.v1.embedSessions({ recipientId: zainab.id })).items;
      expect(after?.revokedAt).not.toBeNull();
    });

    it('keeps a link working on screen until the server has revoked it', async () => {
      const w = await world();
      const zainab = must((await w.v1.recipients()).items.find((r) => r.label === 'Zainab'));
      await w.v1.createEmbedSession({ recipientId: zainab.id, expiresInSeconds: 3600 });
      const slow = gate();
      const api: V1Api = {
        ...w.v1,
        revokeEmbedSession: async (id) => {
          await slow.wait();
          return w.v1.revokeEmbedSession(id);
        },
      };
      const user = userEvent.setup();
      render(tree(<RecipientsPage />, { v1: api, session: sessionFor(w, w.main) }));
      const sheet = await openSheet(user, 'Zainab');
      const list = await within(sheet).findByRole('list', { name: 'Invite links' });
      await user.click(within(list).getByRole('button', { name: 'Revoke' }));
      expect(within(list).getByText(/^Works until/)).toBeTruthy();
      expect(within(list).getByRole<HTMLButtonElement>('button', { name: 'Revoke' }).disabled).toBe(
        true,
      );
      await act(async () => {
        slow.release();
        await Promise.resolve();
      });
      expect(await within(list).findByText('Revoked')).toBeTruthy();
    });

    it('marks a link past its time as expired, with nothing to revoke', async () => {
      let clock = Date.now() - 2 * 86_400_000;
      const w = await world({ now: () => clock });
      const zainab = must((await w.v1.recipients()).items.find((r) => r.label === 'Zainab'));
      await w.v1.createEmbedSession({ recipientId: zainab.id, expiresInSeconds: 3600 });
      clock = Date.now();
      const user = userEvent.setup();
      render(tree(<RecipientsPage />, { v1: w.v1, session: sessionFor(w, w.main) }));
      const sheet = await openSheet(user, 'Zainab');
      const list = await within(sheet).findByRole('list', { name: 'Invite links' });
      expect(within(list).getByText('Expired')).toBeTruthy();
      expect(within(list).queryByRole('button', { name: 'Revoke' })).toBeNull();
    });

    it('says so when a link cannot be made', async () => {
      const w = await world();
      const api: V1Api = {
        ...w.v1,
        createEmbedSession: () =>
          Promise.reject(new ApiError('RATE_LIMITED', 'Too many tries in a short time.', 429)),
      };
      const user = userEvent.setup();
      render(tree(<RecipientsPage />, { v1: api, session: sessionFor(w, w.main) }));
      const sheet = await openSheet(user, 'Zainab');
      await user.click(await within(sheet).findByRole('button', { name: 'Make a link' }));
      expect((await within(sheet).findByRole('alert')).textContent).toContain('Too many tries');
      expect(within(sheet).queryByLabelText('Invite link for Zainab')).toBeNull();
    });
  });

  describe('adding a recipient', () => {
    it('adds one with a wallet and has the owner sign the allowlist before it says done', async () => {
      const w = await world();
      const slow = gate();
      const api: V1Api = {
        ...w.v1,
        submitSigned: async (id, xdr) => {
          await slow.wait();
          return w.v1.submitSigned(id, xdr);
        },
      };
      const user = userEvent.setup();
      render(tree(<RecipientsPage />, { v1: api, session: sessionFor(w, w.main) }));
      await rowFor('Ada');
      await user.click(screen.getByRole('button', { name: 'Add a recipient' }));
      await user.type(await screen.findByLabelText('Name'), 'Kwame');
      await user.type(screen.getByLabelText('Stellar address'), KWAME);
      await user.click(screen.getByRole('button', { name: 'Add recipient' }));

      expect(await screen.findByText(/Sign once so the mandate may pay them\./)).toBeTruthy();
      // The server has the recipient, so the list shows it; the allowlist waits for the wallet.
      expect(await rowFor('Kwame')).toBeTruthy();
      await user.click(await screen.findByRole('button', { name: 'Sign in Demo wallet' }));
      expect(await screen.findByText('Waiting for Stellar to confirm')).toBeTruthy();
      expect(screen.queryByText(/^Signed\./)).toBeNull();
      await act(async () => {
        slow.release();
        await Promise.resolve();
      });
      expect(await screen.findByText(/^Signed\. The mandate may pay them\./)).toBeTruthy();
      expect(w.v1.signingRequests()).toBe(0);
    });

    it('adds one without a wallet and goes straight to the invite link', async () => {
      const w = await world();
      const user = userEvent.setup();
      render(tree(<RecipientsPage />, { v1: w.v1, session: sessionFor(w, w.main) }));
      await rowFor('Ada');
      await user.click(screen.getByRole('button', { name: 'Add a recipient' }));
      await user.type(await screen.findByLabelText('Name'), 'Amara');
      await user.click(screen.getByRole('button', { name: 'Add recipient' }));
      expect(
        await screen.findByText(/Send them an invite link to add their wallet\./),
      ).toBeTruthy();
      expect(w.v1.signingRequests()).toBe(0);
      await user.click(screen.getByRole('button', { name: 'Make an invite link' }));
      const sheet = await screen.findByRole('dialog', { name: 'Recipient' });
      expect(await within(sheet).findByText('Amara')).toBeTruthy();
      const amara = must((await w.v1.recipients()).items.find((r) => r.label === 'Amara'));
      expect(new URLSearchParams(location.search).get('open')).toBe(amara.id);
    });

    it('shows a name already on the mandate under the field, and adds nothing', async () => {
      const w = await world();
      const user = userEvent.setup();
      render(tree(<RecipientsPage />, { v1: w.v1, session: sessionFor(w, w.main) }));
      await rowFor('Ada');
      await user.click(screen.getByRole('button', { name: 'Add a recipient' }));
      await user.type(await screen.findByLabelText('Name'), 'ada');
      await user.click(screen.getByRole('button', { name: 'Add recipient' }));
      expect(
        await screen.findByText('Someone on this mandate already has that name.'),
      ).toBeTruthy();
      expect((await w.v1.recipients()).items).toHaveLength(4);
    });

    it('checks the address before anything is sent', async () => {
      const w = await world();
      let sent = 0;
      const api: V1Api = {
        ...w.v1,
        createRecipient: (input) => {
          sent += 1;
          return w.v1.createRecipient(input);
        },
      };
      const user = userEvent.setup();
      render(tree(<RecipientsPage />, { v1: api, session: sessionFor(w, w.main) }));
      await rowFor('Ada');
      await user.click(screen.getByRole('button', { name: 'Add a recipient' }));
      await user.type(await screen.findByLabelText('Name'), 'Kwame');
      await user.type(screen.getByLabelText('Stellar address'), 'GNOTANADDRESS');
      await user.click(screen.getByRole('button', { name: 'Add recipient' }));
      expect(screen.getByLabelText('Stellar address').getAttribute('aria-invalid')).toBe('true');
      expect(sent).toBe(0);
    });

    it('asks for a mandate first when the project has none', async () => {
      const w = await world({ demo: false });
      const user = userEvent.setup();
      render(tree(<RecipientsPage />, { v1: w.v1, session: sessionFor(w, w.main) }));
      expect(await screen.findByText('No recipients yet.')).toBeTruthy();
      await user.click(
        screen.getAllByRole('button', { name: 'Add a recipient' })[0] as HTMLElement,
      );
      expect(
        await screen.findByText('A recipient belongs to a mandate. Create one first.'),
      ).toBeTruthy();
      expect(screen.getByRole('link', { name: 'Create a mandate' })).toBeTruthy();
    });
  });

  it('shows the error with its reference, and loads on a retry', async () => {
    const w = await world();
    let fail = true;
    const api: V1Api = {
      ...w.v1,
      recipients: (q) =>
        fail
          ? Promise.reject(
              new ApiError('DB_UNAVAILABLE', 'UJIRA is busy.', 503, undefined, 'req-42'),
            )
          : w.v1.recipients(q),
    };
    const user = userEvent.setup();
    render(tree(<RecipientsPage />, { v1: api, session: sessionFor(w, w.main) }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('UJIRA is busy.');
    expect(alert.textContent).toContain('req-42');
    fail = false;
    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await rowFor('Ada')).toBeTruthy();
  });

  it('keeps the /api page while the flag does not name it', async () => {
    const w = await world();
    render(
      tree(<RecipientsPage />, {
        v1: w.v1,
        session: sessionFor(w, w.main),
        screens: new Set(),
      }),
    );
    expect(screen.queryByRole('button', { name: 'Add a recipient' })).toBeNull();
  });
});
