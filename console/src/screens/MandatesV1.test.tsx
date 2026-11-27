// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The mandate screens on /v1, against the fake client: the list and the page
// keyed by project, the meter from minor units, create in two signatures,
// pause and resume straight away, revoke only with the name typed back, and
// nothing on screen changing before the server shows it.

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
import { createFakeV1Api, type FakeV1Api } from '../lib/fakeV1';
import { createMockApi } from '../lib/mock';
import type { Config } from '../lib/schemas';
import { encodeAddress } from '../lib/strkey';
import type { PrepareMandateInput, V1Api } from '../lib/v1';
import { MOCK_WALLET, mockWallet, type Wallet } from '../lib/wallet';
import { CreateMandate } from './CreateMandate';
import { MandatePage } from './MandatePage';
import { MandatesPage } from './Pages';

const CONFIG: Config = {
  network: 'testnet',
  networkPassphrase: 'Test SDF Network ; September 2015',
  explorerTxBase: 'https://stellar.expert/explorer/testnet/tx/',
  asset: { code: 'USDC', issuer: MOCK_WALLET, decimals: 7 },
  sdpAvailable: false,
};

const MANDATES = new Set<V1Screen>(['mandates']);
const OTHER_WALLET = encodeAddress('account', new Uint8Array(32).fill(9));

function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('missing test data');
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

async function world(demo = true): Promise<World> {
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
  return { auth, v1: createFakeV1Api(auth, { delayMs: 0, demo }), info, projects, main, grants };
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
    wallet = mockWallet(MOCK_WALLET),
    screens = MANDATES,
  }: { v1: V1Api; session: Session; wallet?: Wallet | null; screens?: ReadonlySet<V1Screen> },
) {
  const state: AppState = {
    api: createMockApi({ delayMs: 0 }),
    v1,
    v1Screens: screens,
    config: CONFIG,
    mock: true,
    wallet,
    setWallet: () => undefined,
    notify: () => undefined,
  };
  return (
    <AppContext.Provider value={state}>
      <SessionContext.Provider value={session}>{ui}</SessionContext.Provider>
    </AppContext.Provider>
  );
}

/** Holds every submit until the test lets it through, as a slow ledger would. */
function gated(v1: FakeV1Api) {
  let open: () => void = () => undefined;
  let gate = new Promise<void>((r) => {
    open = r;
  });
  const api: V1Api = {
    ...v1,
    submitSigned: async (id, xdr) => {
      await gate;
      return v1.submitSigned(id, xdr);
    },
  };
  return {
    api,
    release: () => {
      open();
      gate = Promise.resolve();
    },
  };
}

async function seededId(w: World): Promise<string> {
  return must((await w.v1.mandates()).items[0]).id;
}

function revokeDialog(): HTMLDialogElement {
  const d = document.querySelector('dialog');
  if (d === null) throw new Error('no dialog');
  return d;
}

describe('the mandate list on /v1', () => {
  it('stays on /api while the flag does not name it', async () => {
    const w = await world();
    render(
      tree(<MandatesPage />, {
        v1: w.v1,
        session: sessionFor(w, w.main),
        wallet: null,
        screens: new Set(),
      }),
    );
    expect(
      screen.getByRole('heading', { name: 'Connect a wallet to see your mandates' }),
    ).toBeTruthy();
    expect(screen.queryByText('Weekly payouts')).toBeNull();
  });

  it("shows the project's mandates with what is left of each budget", async () => {
    const w = await world();
    render(tree(<MandatesPage />, { v1: w.v1, session: sessionFor(w, w.main) }));
    expect(screen.getByRole('status', { name: 'Loading your mandates' })).toBeTruthy();
    const link = await screen.findByRole('link', { name: /Weekly payouts/ });
    expect(link.getAttribute('href')).toBe(`/app/mandates/${await seededId(w)}`);
    expect(link.textContent).toContain('Active');
    expect(link.textContent).toContain('4,580.00 USDC of 5,000.00 USDC left');
    expect(link.textContent).toContain('1,880.00 USDC');
  });

  it('reads each project on its own', async () => {
    const w = await world(false);
    const create = await w.v1.prepareMandate({
      name: 'Main payouts',
      approvers: [],
      approvalsRequired: 1,
      recipients: [],
      limits: {
        totalBudget: {
          amount: 1_000_000_000n,
          asset: 'USDC',
          network: 'stellar:testnet',
          scale: 7,
        },
        perPaymentCap: {
          amount: 100_000_000n,
          asset: 'USDC',
          network: 'stellar:testnet',
          scale: 7,
        },
        perRecipientDailyCap: {
          amount: 200_000_000n,
          asset: 'USDC',
          network: 'stellar:testnet',
          scale: 7,
        },
        approvalThreshold: { amount: 0n, asset: 'USDC', network: 'stellar:testnet', scale: 7 },
        payoutTtlSeconds: 86_400,
        expiresAt: '2099-01-01T00:00:00.000Z',
      },
    } satisfies PrepareMandateInput);
    await w.v1.submitSigned(create.id, 'signed');

    const view = render(tree(<MandatesPage />, { v1: w.v1, session: sessionFor(w, w.main) }));
    expect(await screen.findByRole('link', { name: /Main payouts/ })).toBeTruthy();

    w.auth.useProject(w.grants.id);
    view.rerender(tree(<MandatesPage />, { v1: w.v1, session: sessionFor(w, w.grants) }));
    expect(await screen.findByText('No mandates yet.')).toBeTruthy();
    expect(screen.queryByRole('link', { name: /Main payouts/ })).toBeNull();
  });

  it('shows the error with its reference, and loads on Try again', async () => {
    const w = await world();
    let fail = true;
    const api: V1Api = {
      ...w.v1,
      mandates: (q) =>
        fail
          ? Promise.reject(
              new ApiError('INTERNAL', 'The UJIRA server had a problem.', 500, undefined, 'req-77'),
            )
          : w.v1.mandates(q),
    };
    render(tree(<MandatesPage />, { v1: api, session: sessionFor(w, w.main) }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('The UJIRA server had a problem.');
    expect(alert.textContent).toContain('Reference req-77');
    fail = false;
    await userEvent.setup().click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('link', { name: /Weekly payouts/ })).toBeTruthy();
  });
});

describe('the mandate page on /v1', () => {
  it('shows used, committed and remaining from minor units', async () => {
    const w = await world();
    const id = await seededId(w);
    render(tree(<MandatePage id={id} />, { v1: w.v1, session: sessionFor(w, w.main) }));
    expect(screen.getByRole('status', { name: 'Loading the mandate' })).toBeTruthy();
    expect(await screen.findByRole('heading', { name: 'Weekly payouts' })).toBeTruthy();
    const meter = screen.getByRole('img', { name: /used/ });
    expect(meter.getAttribute('aria-label')).toBe(
      '120.00 USDC used, 300.00 USDC committed, 4,580.00 USDC remaining of 5,000.00 USDC',
    );
    const legend = (term: string) =>
      must(
        screen
          .getAllByRole('term')
          .find((t) => t.textContent.startsWith(term))
          ?.parentElement?.querySelector('dd')?.textContent ?? undefined,
      );
    expect(legend('Used')).toBe('120.00 USDC');
    expect(legend('Committed')).toBe('300.00 USDC');
    expect(legend('Remaining')).toBe('4,580.00 USDC');
  });

  it('pauses and resumes without a typed confirmation, and waits for Stellar', async () => {
    const w = await world();
    const id = await seededId(w);
    const { api, release } = gated(w.v1);
    const user = userEvent.setup();
    render(tree(<MandatePage id={id} />, { v1: api, session: sessionFor(w, w.main) }));

    await user.click(await screen.findByRole('button', { name: 'Pause payouts' }));
    await user.click(await screen.findByRole('button', { name: 'Sign in Demo wallet' }));
    expect(await screen.findByText('Waiting for Stellar to confirm')).toBeTruthy();
    expect(revokeDialog().open).toBe(false);
    // Nothing optimistic: the page still shows what the chain says.
    expect(screen.getByText('Active')).toBeTruthy();
    expect(screen.queryByText('Paused')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Resume payouts' })).toBeNull();

    await act(async () => {
      release();
      await Promise.resolve();
    });
    expect(await screen.findByText('The mandate is paused.', { exact: false })).toBeTruthy();
    expect(await screen.findByText('Paused')).toBeTruthy();

    await user.click(await screen.findByRole('button', { name: 'Resume payouts' }));
    await user.click(await screen.findByRole('button', { name: 'Sign in Demo wallet' }));
    expect(await screen.findByText('The mandate is active again.', { exact: false })).toBeTruthy();
    expect(await screen.findByText('Active')).toBeTruthy();
    expect(revokeDialog().open).toBe(false);
    expect((await w.v1.mandate(id)).state.paused).toBe(false);
  });

  it('revokes only once the mandate name is typed back', async () => {
    const w = await world();
    const id = await seededId(w);
    const user = userEvent.setup();
    render(tree(<MandatePage id={id} />, { v1: w.v1, session: sessionFor(w, w.main) }));

    await user.click(await screen.findByRole('button', { name: 'Revoke' }));
    const dialog = revokeDialog();
    expect(dialog.open).toBe(true);
    const confirm = within(dialog).getByRole('button', { name: 'Revoke for good' });
    expect(confirm.hasAttribute('disabled')).toBe(true);

    const typed = within(dialog).getByLabelText('Type Weekly payouts to confirm');
    await user.type(typed, 'weekly payouts');
    expect(confirm.hasAttribute('disabled')).toBe(true);
    expect(w.v1.signingRequests()).toBe(0);

    await user.clear(typed);
    await user.type(typed, 'Weekly payouts');
    expect(confirm.hasAttribute('disabled')).toBe(false);
    await user.click(confirm);
    await user.click(await within(dialog).findByRole('button', { name: 'Sign in Demo wallet' }));
    await waitFor(() => {
      expect(dialog.open).toBe(false);
    });
    expect(await screen.findByText('Revoked')).toBeTruthy();
    expect((await w.v1.mandate(id)).state.revoked).toBe(true);
  });

  it('leaves the controls to the owner wallet', async () => {
    const w = await world();
    const id = await seededId(w);
    render(
      tree(<MandatePage id={id} />, {
        v1: w.v1,
        session: sessionFor(w, w.main),
        wallet: mockWallet(OTHER_WALLET),
      }),
    );
    expect(await screen.findByText(/You are connected with another wallet/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Pause payouts' })).toBeNull();
  });

  it('shows the error with its reference when the mandate cannot be read', async () => {
    const w = await world();
    render(
      tree(<MandatePage id="0b8f6a4c-58c3-4a3b-9f0e-6c1d2e3f4a5b" />, {
        v1: w.v1,
        session: sessionFor(w, w.main),
      }),
    );
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('We could not find that.');
    expect(alert.textContent).toMatch(/Reference fake-\d+/);
  });
});

describe('creating a mandate on /v1', () => {
  it('asks for a name, then signs create and fund, each once the server shows it', async () => {
    const w = await world();
    const sent: PrepareMandateInput[] = [];
    const { api, release } = gated(w.v1);
    const spy: V1Api = {
      ...api,
      prepareMandate: (input) => {
        sent.push(input);
        return api.prepareMandate(input);
      },
    };
    const user = userEvent.setup();
    render(tree(<CreateMandate />, { v1: spy, session: sessionFor(w, w.main) }));

    await user.click(await screen.findByRole('button', { name: 'Review and sign' }));
    expect(screen.getByText('Give the mandate a name.')).toBeTruthy();

    await user.type(screen.getByLabelText('Name'), 'Grants round');
    await user.click(await screen.findByRole('checkbox', { name: /Ada/ }));
    await user.click(screen.getByRole('button', { name: 'Review and sign' }));

    await user.click(await screen.findByRole('button', { name: 'Sign in Demo wallet' }));
    expect(await screen.findByText('Waiting for Stellar to confirm')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Sign step 1 of 2' })).toBeTruthy();
    expect((await w.v1.mandates()).items.some((m) => m.name === 'Grants round')).toBe(false);

    await act(async () => {
      release();
      await Promise.resolve();
    });
    expect(await screen.findByRole('heading', { name: 'Sign step 2 of 2' })).toBeTruthy();
    await user.click(await screen.findByRole('button', { name: 'Sign in Demo wallet' }));
    expect(await screen.findByRole('heading', { name: 'Your mandate is live' })).toBeTruthy();

    const made = must((await w.v1.mandates()).items.find((m) => m.name === 'Grants round'));
    expect(made.state.balance.amount).toBe(400_000_000n);
    expect(screen.getByRole('link', { name: 'Open your mandate' }).getAttribute('href')).toBe(
      `/app/mandates/${made.id}`,
    );
    const ada = must((await w.v1.recipients()).items.find((r) => r.label === 'Ada'));
    expect(sent).toHaveLength(1);
    expect(sent[0]?.recipients).toEqual([ada.id]);
    expect(sent[0]?.limits.totalBudget).toEqual({
      amount: 400_000_000n,
      asset: 'USDC',
      network: 'stellar:testnet',
      scale: 7,
    });
  });

  it('refuses to sign with a wallet that is not the signer, and sends nothing', async () => {
    const w = await world();
    const user = userEvent.setup();
    render(
      tree(<CreateMandate />, {
        v1: w.v1,
        session: sessionFor(w, w.main),
        wallet: mockWallet(OTHER_WALLET),
      }),
    );
    await user.type(await screen.findByLabelText('Name'), 'Grants round');
    await user.click(screen.getByRole('button', { name: 'Review and sign' }));
    await user.click(await screen.findByRole('button', { name: 'Sign in Demo wallet' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('This needs the wallet');
    expect(w.v1.signingRequests()).toBe(1);
    expect((await w.v1.mandates()).items.map((m) => m.name)).toEqual(['Weekly payouts']);
  });

  it('keeps the /api form while the flag does not name it', async () => {
    const w = await world();
    render(
      tree(<CreateMandate />, {
        v1: w.v1,
        session: sessionFor(w, w.main),
        screens: new Set(),
      }),
    );
    expect(await screen.findByRole('button', { name: 'Add a test recipient' })).toBeTruthy();
    expect(screen.queryByLabelText('Name')).toBeNull();
  });
});
