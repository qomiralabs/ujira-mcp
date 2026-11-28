// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The overview on /v1: every figure is the one the API sent, nothing shows
// before the answer is in, each project reads its own, an empty project gets
// its first steps, and a mandate the chain did not answer for is said out
// loud rather than counted as nothing.

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
import { formatToken } from '../lib/money';
import type { Config } from '../lib/schemas';
import { createHttpV1Api, createV1Transport, type V1Api } from '../lib/v1';
import type { TokenAmount } from '../lib/v1Schemas';
import { MOCK_WALLET, mockWallet } from '../lib/wallet';
import { IDS, RECORDED } from '../test/v1Recorded';
import { Overview } from './Overview';
import { OverviewV1 } from './OverviewV1';

const CONFIG: Config = {
  network: 'testnet',
  networkPassphrase: 'Test SDF Network ; September 2015',
  explorerTxBase: 'https://stellar.expert/explorer/testnet/tx/',
  asset: { code: 'USDC', issuer: MOCK_WALLET, decimals: 7 },
  sdpAvailable: false,
};

const OVERVIEW = new Set<V1Screen>(['overview']);
const UNIT = 10_000_000n;

const usdc = (whole: bigint): TokenAmount => ({
  amount: whole * UNIT,
  asset: 'USDC',
  network: 'stellar:testnet',
  scale: 7,
});

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
    screens = OVERVIEW,
  }: { v1: V1Api; session: Session; screens?: ReadonlySet<V1Screen> },
) {
  const state: AppState = {
    api: createMockApi({ delayMs: 0 }),
    v1,
    v1Screens: screens,
    config: CONFIG,
    mock: true,
    wallet: mockWallet(MOCK_WALLET),
    setWallet: () => undefined,
    notify: () => undefined,
  };
  return (
    <AppContext.Provider value={state}>
      <SessionContext.Provider value={session}>{ui}</SessionContext.Provider>
    </AppContext.Provider>
  );
}

function balance(): HTMLElement {
  return must(screen.getByRole('heading', { name: 'Total balance' }).closest('section'));
}

function figure(scope: HTMLElement, label: string): string {
  const dt = within(scope).getByText(label, { selector: 'dt' });
  return must(dt.nextElementSibling).textContent;
}

function section(name: string): HTMLElement {
  return must(screen.getByRole('heading', { name }).closest('section'));
}

/** Holds every overview answer until the test lets it through. */
function gated(v1: V1Api) {
  let open: () => void = () => undefined;
  const gate = new Promise<void>((r) => {
    open = r;
  });
  const api: V1Api = {
    ...v1,
    overview: async (q) => {
      await gate;
      return v1.overview(q);
    },
  };
  return { api, release: open };
}

describe('the overview on /v1', () => {
  it('stays on /api while the flag does not name it', async () => {
    const w = await world();
    render(tree(<Overview />, { v1: w.v1, session: sessionFor(w, w.main), screens: new Set() }));
    expect(await screen.findByRole('heading', { name: 'Total balance' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'This period' })).toBeNull();
  });

  it('shows every figure exactly as the API sent it', async () => {
    const w = await world();
    const sent = await w.v1.overview();
    render(tree(<Overview />, { v1: w.v1, session: sessionFor(w, w.main) }));
    await screen.findByRole('heading', { name: 'This period' });

    // The seeded mandate: 2,000 in, 120 paid, 300 waiting for approval.
    const m = must(sent.mandates[0]?.state);
    const b = balance();
    expect(b.querySelector('.balance-value')?.textContent).toBe(formatToken(m.balance));
    expect(formatToken(m.balance)).toBe('1,880.00 USDC');
    expect(figure(b, 'Free to pay')).toBe(formatToken(m.free));
    expect(figure(b, 'Set aside for approval')).toBe('300.00 USDC');

    const mine = section('Your mandates');
    expect(within(mine).getByText('Weekly payouts')).toBeTruthy();
    expect(mine.textContent).toContain('1,580.00 USDC free');
    expect(mine.textContent).toContain('1,880.00 USDCheld');

    const period = section('This period');
    expect(figure(period, 'Paid')).toBe(formatToken(must(sent.paid[0])));
    expect(figure(period, 'Paid')).toBe('120.00 USDC');
    expect(figure(period, 'Payouts')).toBe('3');
    expect(figure(period, 'Blocked by rule')).toBe('1');
    expect(within(period).getByText('Time to paid').textContent).toContain('Soon');

    const statuses = section('By status');
    expect(
      within(statuses)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(['Paid1', 'Waiting for approval1', 'Blocked1']);
    const rules = section('Blocked by rule');
    expect(within(rules).getByRole('listitem').textContent).toBe('Over the max per payment1');

    const strip = screen.getByRole('link', { name: /1 payout waiting/ });
    expect(strip.getAttribute('href')).toBe('/app/approvals');

    const recent = section('Recent payouts');
    const lines = within(recent).getAllByRole('button');
    expect(lines).toHaveLength(3);
    expect(lines[0]?.textContent).toContain('Kofi');
    expect(lines[0]?.textContent).toContain('900.00 USDC');
    expect(lines[0]?.textContent).toContain('Blocked');

    // Funded, but no key for the agent yet: that one step is left, and it is the one to take.
    const steps = section('First steps');
    expect([...steps.querySelectorAll('h3')].map((h) => h.textContent)).toEqual([
      'Create a mandate (done)',
      'Fund it (done)',
      'Create a key (to do)',
    ]);
    expect(within(steps).getByRole('link', { name: 'Create a key' }).className).toContain(
      'btn-primary',
    );
    expect(within(b).getByRole('link', { name: 'Create a mandate' }).className).not.toContain(
      'btn-primary',
    );
  });

  it('shows no amount before the answer is in, and the final one once it is', async () => {
    const w = await world();
    const { api, release } = gated(w.v1);
    render(
      tree(<OverviewV1 v1={api} projectId={w.main.id} />, {
        v1: api,
        session: sessionFor(w, w.main),
      }),
    );
    // The other reads are in; the overview is not, so no figure shows.
    await waitFor(() => {
      expect(within(section('Recent payouts')).getAllByRole('button')).toHaveLength(3);
    });
    expect(balance().textContent).not.toContain('USDC');
    expect(within(balance()).getAllByText('Checking').length).toBeGreaterThan(0);
    expect(screen.queryByRole('link', { name: /waiting/ })).toBeNull();
    await act(async () => {
      release();
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(figure(balance(), 'Set aside for approval')).toBe('300.00 USDC');
    });
    expect(balance().textContent).toContain('1,880.00');
  });

  it('reads each project on its own, and gives an empty one its first steps', async () => {
    const w = await world();
    const view = render(tree(<Overview />, { v1: w.v1, session: sessionFor(w, w.main) }));
    await screen.findByText('Weekly payouts');

    const empty = createFakeV1Api(w.auth, { delayMs: 0, demo: false });
    w.auth.useProject(w.grants.id);
    view.rerender(tree(<Overview />, { v1: empty, session: sessionFor(w, w.grants) }));
    await screen.findByRole('heading', { name: 'First steps' });
    const steps = section('First steps');
    expect(screen.queryByText('Weekly payouts')).toBeNull();
    expect(figure(balance(), 'Free to pay')).toBe('0.00 USDC');
    expect(screen.queryByRole('heading', { name: 'This period' })).toBeNull();

    const items = within(steps).getAllByRole('listitem');
    expect(items.map((li) => li.querySelector('h3')?.textContent)).toEqual([
      'Create a mandate (to do)',
      'Fund it (to do)',
      'Create a key (to do)',
    ]);
    const create = within(must(items[0])).getByRole('link', { name: 'Create a mandate' });
    expect(create.getAttribute('href')).toBe('/app/mandates/new');
    expect(create.className).toContain('btn-primary');
    // Nothing to fund before there is a mandate.
    expect(within(must(items[1])).queryByRole('link')).toBeNull();
    const key = within(must(items[2])).getByRole('link', { name: 'Create a key' });
    expect(key.getAttribute('href')).toBe('/app/developers');
    expect(key.className).not.toContain('btn-primary');
    // One primary action on the page.
    expect(document.querySelectorAll('.btn-primary')).toHaveLength(1);
  });

  it('marks each first step done only once the server shows it', async () => {
    const w = await world(false);
    const create = await w.v1.prepareMandate({
      name: 'Grants round',
      approvers: [],
      approvalsRequired: 1,
      recipients: [],
      limits: {
        totalBudget: usdc(1_000n),
        perPaymentCap: usdc(100n),
        perRecipientDailyCap: usdc(200n),
        approvalThreshold: usdc(50n),
        payoutTtlSeconds: 86_400,
        expiresAt: '2099-01-01T00:00:00.000Z',
      },
    });
    const id = must((await w.v1.submitSigned(create.id, 'signed')).mandateId);
    const first = render(
      tree(<OverviewV1 v1={w.v1} projectId={w.main.id} />, {
        v1: w.v1,
        session: sessionFor(w, w.main),
      }),
    );
    const steps = await waitFor(() => {
      const s = section('First steps');
      expect(s.querySelector('h3')?.textContent).toBe('Create a mandate (done)');
      return s;
    });
    const fund = within(steps).getByRole('link', { name: 'Add funds' });
    expect(fund.getAttribute('href')).toBe(`/app/mandates/${id}`);
    first.unmount();

    const fundIt = await w.v1.mandateAction(id, { kind: 'fund', amount: 10n * UNIT });
    await w.v1.submitSigned(fundIt.id, 'signed');
    await w.v1.createApiKey({ name: 'Runner', scopes: ['payouts:write'] });
    render(
      tree(<OverviewV1 v1={w.v1} projectId={w.main.id} />, {
        v1: w.v1,
        session: sessionFor(w, w.main),
      }),
    );
    await waitFor(() => {
      expect(figure(balance(), 'Free to pay')).toBe('10.00 USDC');
    });
    expect(screen.queryByRole('heading', { name: 'First steps' })).toBeNull();
    expect(within(balance()).getByRole('link', { name: 'Create a mandate' }).className).toContain(
      'btn-primary',
    );
  });

  it('leaves the key step out for a role that cannot see keys', async () => {
    const w = await world(false);
    const api: V1Api = {
      ...w.v1,
      apiKeys: () =>
        Promise.reject(new ApiError('FORBIDDEN', 'Your role cannot do that here.', 403)),
    };
    render(
      tree(<OverviewV1 v1={api} projectId={w.main.id} />, {
        v1: api,
        session: sessionFor(w, w.main),
      }),
    );
    await screen.findByRole('heading', { name: 'First steps' });
    const steps = section('First steps');
    expect(within(steps).getAllByRole('listitem')).toHaveLength(2);
    expect(within(steps).queryByText('Create a key', { exact: false })).toBeNull();
  });

  it('says which mandates Stellar did not answer for instead of counting them as nothing', async () => {
    const w = await world();
    const m = must((await w.v1.mandates()).items[0]);
    w.v1.setUnread(m.id, true);
    render(tree(<Overview />, { v1: w.v1, session: sessionFor(w, w.main) }));
    const warn = await screen.findByText(
      'Stellar did not answer for 1 mandate, so its money is not in these totals.',
    );
    expect(warn.getAttribute('role')).toBe('status');
    expect(within(section('Your mandates')).getByText('Not read')).toBeTruthy();
    // Its money is unknown, which is not the same as none.
    expect(balance().querySelector('.balance-value')?.textContent).toBe('Not read');
    expect(figure(balance(), 'Free to pay')).toBe('Not read');
  });

  it('shows the error with its reference, and loads on Try again', async () => {
    const w = await world();
    let fail = true;
    const api: V1Api = {
      ...w.v1,
      overview: (q) =>
        fail
          ? Promise.reject(
              new ApiError('INTERNAL', 'The UJIRA server had a problem.', 500, undefined, 'req-84'),
            )
          : w.v1.overview(q),
    };
    render(
      tree(<OverviewV1 v1={api} projectId={w.main.id} />, {
        v1: api,
        session: sessionFor(w, w.main),
      }),
    );
    const alerts = await screen.findAllByRole('alert');
    expect(alerts[0]?.textContent).toContain('The UJIRA server had a problem.');
    expect(alerts[0]?.textContent).toContain('Reference req-84');
    expect(balance().textContent).not.toContain('USDC');
    fail = false;
    await userEvent
      .setup()
      .click(within(must(alerts[0])).getByRole('button', { name: 'Try again' }));
    await waitFor(() => {
      expect(figure(balance(), 'Set aside for approval')).toBe('300.00 USDC');
    });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('opens a recent payout in the sheet, in place', async () => {
    const w = await world();
    const user = userEvent.setup();
    render(
      tree(<OverviewV1 v1={w.v1} projectId={w.main.id} />, {
        v1: w.v1,
        session: sessionFor(w, w.main),
      }),
    );
    const recent = await waitFor(() => {
      const s = section('Recent payouts');
      expect(within(s).getAllByRole('button')).toHaveLength(3);
      return s;
    });
    const ada = within(recent)
      .getAllByRole('button')
      .find((b) => b.textContent.includes('Ada'));
    await user.click(must(ada));
    const sheet = await screen.findByRole('dialog', { name: 'Payout' });
    expect(new URLSearchParams(location.search).get('payout')).toMatch(/^[0-9a-f-]{36}$/);
    await within(sheet).findByText('task-101', { exact: false });
  });

  it('renders the recorded server answer through the real client', async () => {
    const routes: Record<string, unknown> = {
      '/v1/stats/overview': RECORDED['GET /v1/stats/overview'],
      '/v1/payouts': RECORDED['GET /v1/payouts'],
      '/v1/api-keys': RECORDED['GET /v1/api-keys'],
    };
    const v1 = createHttpV1Api(
      createV1Transport((input) => {
        const path = new URL(input, 'https://ujira.co').pathname;
        const body = routes[path];
        return Promise.resolve(
          body === undefined
            ? new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: '' } }), {
                status: 404,
              })
            : new Response(JSON.stringify(body), {
                status: 200,
                headers: { 'content-type': 'application/json' },
              }),
        );
      }),
    );
    const w = await world();
    render(
      tree(<OverviewV1 v1={v1} projectId={IDS.project} />, { v1, session: sessionFor(w, w.main) }),
    );
    await waitFor(() => {
      expect(figure(balance(), 'Free to pay')).toBe('1,700.00 USDC');
    });
    expect(figure(balance(), 'Set aside for approval')).toBe('300.00 USDC');
    const period = section('This period');
    expect(figure(period, 'Paid')).toBe('122.50 USDC');
    expect(figure(period, 'Payouts')).toBe('15');
    expect(figure(period, 'Blocked by rule')).toBe('2');
    expect(within(section('Blocked by rule')).getByRole('listitem').textContent).toBe(
      "Over today's limit for this recipient2",
    );
    expect(within(section('Your mandates')).getByText('Week 48 payouts')).toBeTruthy();
    expect(screen.getByRole('link', { name: /1 payout waiting/ })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'First steps' })).toBeNull();
  });
});
