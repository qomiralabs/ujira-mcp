// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The payouts screen on /v1, against the fake client: rows from the project
// only, a word and a mark on every status, filters and sort in the URL so a
// reload or a shared link shows the same view, the CSV of the filtered set,
// ten thousand rows drawn a screenful at a time, and the side sheet that
// leaves the table where it was.

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
import type { PayoutQuery, V1Api } from '../lib/v1';
import type { PayoutDetail, TokenAmount } from '../lib/v1Schemas';
import { MOCK_WALLET, mockWallet } from '../lib/wallet';
import { PayoutsPage } from './Pages';
import { PayoutsV1 } from './PayoutsV1';

const CONFIG: Config = {
  network: 'testnet',
  networkPassphrase: 'Test SDF Network ; September 2015',
  explorerTxBase: 'https://stellar.expert/explorer/testnet/tx/',
  asset: { code: 'USDC', issuer: MOCK_WALLET, decimals: 7 },
  sdpAvailable: false,
};

const PAYOUTS = new Set<V1Screen>(['payouts']);

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
    screens = PAYOUTS,
    notify = () => undefined,
  }: {
    v1: V1Api;
    session: Session;
    screens?: ReadonlySet<V1Screen>;
    notify?: (m: string) => void;
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

function at(search: string) {
  history.replaceState(null, '', `/app/payouts${search}`);
}

function table() {
  return screen.getByRole('table');
}

/** Body rows that are drawn, without the header or the spacers. */
function bodyRows(): HTMLElement[] {
  return within(table())
    .getAllByRole('row')
    .filter((r) => r.closest('tbody') !== null);
}

function usdc(amount: bigint): TokenAmount {
  return { amount, asset: 'USDC', network: 'stellar:testnet', scale: 7 };
}

function hexId(n: number): string {
  const h = n.toString(16).padStart(12, '0');
  return `00000000-0000-4000-8000-${h}`;
}

/** Ten thousand payouts, served 200 to a page the way the server pages them. */
function bigApi(base: V1Api, total = 10_000): { api: V1Api; pages: () => number } {
  const mandate = { id: hexId(999_999), contractId: `C${'A'.repeat(51)}MAIN` };
  const all: PayoutDetail[] = Array.from({ length: total }, (_, i) => {
    const amount = usdc(BigInt(i + 1) * 10_000_000n);
    const created = new Date(Date.UTC(2026, 10, 1) + i * 60_000).toISOString();
    return {
      id: hexId(i),
      principalId: 'p',
      projectId: 'j',
      mandate,
      recipient: { id: hexId(500_000 + (i % 7)), label: `Person ${String(i % 7)}` },
      taskId: `task-${String(i)}`,
      amount,
      fee: usdc(0n),
      status: i % 3 === 0 ? 'paid' : i % 3 === 1 ? 'pending_approval' : 'blocked',
      blockedBy: i % 3 === 2 ? 'BUDGET_EXCEEDED' : null,
      legs: [
        {
          index: 0,
          method: 'stellar.wallet',
          destination: 'GABC...WXYZ',
          amount,
          status: 'paid',
          txHash: null,
        },
      ],
      onChainPayoutId: null,
      requestTxHash: null,
      receiptId: null,
      createdAt: created,
      updatedAt: created,
      settledAt: i % 3 === 1 ? null : created,
    };
  }).reverse();
  let pages = 0;
  const api: V1Api = {
    ...base,
    payouts: (q?: PayoutQuery) => {
      pages += 1;
      const offset = q?.cursor === undefined ? 0 : Number.parseInt(q.cursor, 10);
      const limit = q?.limit ?? 50;
      const items = all.slice(offset, offset + limit);
      const next = offset + limit;
      return Promise.resolve({ items, nextCursor: next < all.length ? String(next) : null });
    },
    payout: (id) => Promise.resolve(must(all.find((p) => p.id === id))),
  };
  return { api, pages: () => pages };
}

/** Sets where a scrolling element is, as a browser would after the wheel turns. */
function scrollTo(el: HTMLElement, top: number) {
  Object.defineProperty(el, 'scrollTop', { configurable: true, writable: true, value: top });
  fireEvent.scroll(el);
}

describe('the payouts table on /v1', () => {
  it('stays on /api while the flag does not name it', async () => {
    const w = await world();
    render(tree(<PayoutsPage />, { v1: w.v1, session: sessionFor(w, w.main), screens: new Set() }));
    expect(
      screen.getByRole('heading', { name: 'Connect a wallet to see your payouts' }),
    ).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Payouts table' })).toBeNull();
  });

  it("shows the project's payouts, newest first, one line each", async () => {
    const w = await world();
    render(tree(<PayoutsPage />, { v1: w.v1, session: sessionFor(w, w.main) }));
    expect(screen.getByRole('status', { name: 'Loading payouts' })).toBeTruthy();
    expect(await screen.findByText('3 payouts')).toBeTruthy();
    const rows = bodyRows();
    expect(rows.map((r) => within(r).getAllByRole('cell')[1]?.textContent)).toEqual([
      'Kofi',
      'Kofi',
      'Ada',
    ]);
    const first = must(rows[0]);
    expect(first.textContent).toContain('900.00 USDC');
    expect(first.textContent).toContain('Stellar wallet');
    await waitFor(() => {
      expect(first.textContent).toContain('Weekly payouts');
    });
    const seeded = (await w.v1.payouts()).items[0];
    const short = must(seeded).id.slice(0, 8);
    expect(within(first).getByRole('button', { name: `Open payout ${short}` })).toBeTruthy();
    expect(within(first).getByRole('button', { name: `Copy payout ID ${short}` })).toBeTruthy();
  });

  it('gives every status a word and a mark, never colour alone', async () => {
    const w = await world();
    render(tree(<PayoutsPage />, { v1: w.v1, session: sessionFor(w, w.main) }));
    await screen.findByText('3 payouts');
    const pills = bodyRows().map((r) => must(r.querySelector('.pill')));
    expect(pills.map((p) => p.textContent)).toEqual(['Blocked', 'Waiting for approval', 'Paid']);
    for (const pill of pills) {
      expect(pill.querySelector('svg path')).not.toBeNull();
      expect(pill.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    }
    expect(screen.getByRole('button', { name: 'Why it was blocked' })).toBeTruthy();
  });

  it('reads each project on its own', async () => {
    const w = await world();
    const view = render(tree(<PayoutsPage />, { v1: w.v1, session: sessionFor(w, w.main) }));
    await screen.findByText('3 payouts');
    const ids = () =>
      bodyRows().map((r) => r.querySelector('button.row-open')?.getAttribute('data-payout'));
    const inMain = ids();

    // The fake seeds every project with its own demo payouts, under new ids.
    w.auth.useProject(w.grants.id);
    view.rerender(tree(<PayoutsPage />, { v1: w.v1, session: sessionFor(w, w.grants) }));
    await waitFor(() => {
      expect(ids().some((id) => inMain.includes(id))).toBe(false);
    });
    expect(ids()).toHaveLength(3);
  });

  it('keeps filters in the URL, so a reload shows the same view', async () => {
    const w = await world();
    at('?mock=1');
    const user = userEvent.setup();
    const first = render(tree(<PayoutsPage />, { v1: w.v1, session: sessionFor(w, w.main) }));
    await screen.findByText('3 payouts');

    await user.selectOptions(screen.getByLabelText('Status'), 'Blocked');
    expect(await screen.findByText('1 payout')).toBeTruthy();
    const params = new URLSearchParams(location.search);
    expect(params.get('status')).toBe('blocked');
    expect(params.get('mock')).toBe('1');
    expect(bodyRows()).toHaveLength(1);

    // A reload: the page is drawn again from nothing but the URL.
    first.unmount();
    render(tree(<PayoutsPage />, { v1: w.v1, session: sessionFor(w, w.main) }));
    expect(await screen.findByText('1 payout')).toBeTruthy();
    expect(screen.getByLabelText<HTMLSelectElement>('Status').value).toBe('blocked');
    expect(must(bodyRows()[0]).textContent).toContain('Blocked');
  });

  it('opens a shared link with its filters and recipient', async () => {
    const w = await world();
    const kofi = must((await w.v1.recipients()).items.find((r) => r.label === 'Kofi'));
    at(`?recipient=${kofi.id}&status=waiting`);
    render(tree(<PayoutsPage />, { v1: w.v1, session: sessionFor(w, w.main) }));
    expect(await screen.findByText('1 payout')).toBeTruthy();
    await waitFor(() => {
      expect(screen.getByLabelText<HTMLSelectElement>('Recipient').value).toBe(kofi.id);
    });
    expect(must(bodyRows()[0]).textContent).toContain('300.00 USDC');
  });

  it('clears the filters and says so when nothing matches', async () => {
    const w = await world();
    at('?from=2099-01-01');
    const user = userEvent.setup();
    render(tree(<PayoutsPage />, { v1: w.v1, session: sessionFor(w, w.main) }));
    expect(await screen.findByText('No payouts match these filters.')).toBeTruthy();
    await user.click(must(screen.getAllByRole('button', { name: 'Clear filters' })[0]));
    expect(await screen.findByText('3 payouts')).toBeTruthy();
    expect(location.search).toBe('');
  });

  it('sorts from the headers and keeps the sort in the URL', async () => {
    const w = await world();
    const user = userEvent.setup();
    render(tree(<PayoutsPage />, { v1: w.v1, session: sessionFor(w, w.main) }));
    await screen.findByText('3 payouts');
    const amount = () => must(screen.getByRole('button', { name: 'Amount' }).closest('th'));
    expect(amount().getAttribute('aria-sort')).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Amount' }));
    expect(amount().getAttribute('aria-sort')).toBe('descending');
    expect(new URLSearchParams(location.search).get('sort')).toBe('amount');
    const amounts = () => bodyRows().map((r) => r.querySelector('.c-amount')?.textContent);
    expect(amounts()).toEqual(['900.00 USDC', '300.00 USDC', '120.00 USDC']);

    await user.click(screen.getByRole('button', { name: 'Amount' }));
    expect(amount().getAttribute('aria-sort')).toBe('ascending');
    expect(amounts()).toEqual(['120.00 USDC', '300.00 USDC', '900.00 USDC']);
    expect(new URLSearchParams(location.search).get('dir')).toBe('asc');
  });

  it('exports the filtered set as CSV', async () => {
    const w = await world();
    at('?status=paid');
    const saved: { name: string; text: string }[] = [];
    const notes: string[] = [];
    const user = userEvent.setup();
    render(
      tree(
        <PayoutsV1
          v1={w.v1}
          projectId={w.main.id}
          save={(name, text) => saved.push({ name, text })}
        />,
        { v1: w.v1, session: sessionFor(w, w.main), notify: (m) => notes.push(m) },
      ),
    );
    await screen.findByText('1 payout');
    await user.click(screen.getByRole('button', { name: 'Export CSV' }));
    expect(saved).toHaveLength(1);
    const file = must(saved[0]);
    expect(file.name).toMatch(/^ujira-payouts-\d{4}-\d{2}-\d{2}\.csv$/);
    const lines = file.text.trimEnd().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^payout_id,created_at,settled_at,recipient/);
    expect(lines[1]).toContain(',Ada,');
    expect(lines[1]).toContain(',120.00,USDC,paid,');
    expect(notes).toEqual(['Saved 1 payout as CSV.']);
  });

  it('shows the error with its reference, and loads on Try again', async () => {
    const w = await world();
    let fail = true;
    const api: V1Api = {
      ...w.v1,
      payouts: (q) =>
        fail
          ? Promise.reject(
              new ApiError('INTERNAL', 'The UJIRA server had a problem.', 500, undefined, 'req-80'),
            )
          : w.v1.payouts(q),
    };
    render(tree(<PayoutsPage />, { v1: api, session: sessionFor(w, w.main) }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('The UJIRA server had a problem.');
    expect(alert.textContent).toContain('Reference req-80');
    fail = false;
    await userEvent.setup().click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('3 payouts')).toBeTruthy();
  });
});

describe('ten thousand payouts', () => {
  it('reads every page and draws only a screenful of rows', async () => {
    const w = await world();
    const { api, pages } = bigApi(w.v1);
    render(tree(<PayoutsPage />, { v1: api, session: sessionFor(w, w.main) }));
    expect(await screen.findByText('10,000 payouts')).toBeTruthy();
    expect(pages()).toBe(50);
    expect(table().getAttribute('aria-rowcount')).toBe('10001');
    const drawn = bodyRows();
    expect(drawn.length).toBeGreaterThan(10);
    expect(drawn.length).toBeLessThan(60);
    expect(drawn[0]?.getAttribute('aria-rowindex')).toBe('2');

    const region = screen.getByRole('region', { name: 'Payouts table' });
    scrollTo(region, 53 * 6_000);
    await waitFor(() => {
      const indexes = bodyRows().map((r) => Number(r.getAttribute('aria-rowindex')));
      expect(indexes).toContain(6_005);
    });
    expect(bodyRows().length).toBeLessThan(60);
    const top = must(region.querySelector<HTMLElement>('tr.vt-pad'));
    expect(Number.parseFloat(top.style.height)).toBeGreaterThan(53 * 5_900);
  });

  it('sorts all ten thousand, not just the rows in view', async () => {
    const w = await world();
    const { api } = bigApi(w.v1);
    at('?sort=amount&dir=asc');
    render(tree(<PayoutsPage />, { v1: api, session: sessionFor(w, w.main) }));
    await screen.findByText('10,000 payouts');
    expect(must(bodyRows()[0]).querySelector('.c-amount')?.textContent).toBe('1.00 USDC');
  });

  it('opens the sheet over the table and leaves its scroll where it was', async () => {
    const w = await world();
    const { api } = bigApi(w.v1);
    const user = userEvent.setup();
    render(tree(<PayoutsPage />, { v1: api, session: sessionFor(w, w.main) }));
    await screen.findByText('10,000 payouts');
    const region = screen.getByRole('region', { name: 'Payouts table' });
    scrollTo(region, 53 * 4_000);
    await waitFor(() => {
      expect(bodyRows().map((r) => r.getAttribute('aria-rowindex'))).toContain('4010');
    });
    const row = must(bodyRows().find((r) => r.getAttribute('aria-rowindex') === '4010'));
    const opener = must(row.querySelector<HTMLButtonElement>('button.row-open'));
    const id = must(opener.dataset['payout']);
    await user.click(opener);

    const sheet = await screen.findByRole('dialog', { name: 'Payout' });
    expect(new URLSearchParams(location.search).get('payout')).toBe(id);
    expect(await within(sheet).findByRole('list', { name: 'Progress' })).toBeTruthy();
    // Same element, same place: nothing under the sheet moved or was drawn again.
    expect(screen.getByRole('region', { name: 'Payouts table' })).toBe(region);
    expect(region.scrollTop).toBe(53 * 4_000);
    expect(row.isConnected).toBe(true);

    await user.click(within(sheet).getByRole('button', { name: 'Close' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(new URLSearchParams(location.search).has('payout')).toBe(false);
    expect(region.scrollTop).toBe(53 * 4_000);
    expect(row.isConnected).toBe(true);
    await waitFor(() => {
      expect(document.activeElement).toBe(opener);
    });
  });
});

describe('the payout sheet', () => {
  async function openBy(label: string, w: World) {
    const user = userEvent.setup();
    render(tree(<PayoutsPage />, { v1: w.v1, session: sessionFor(w, w.main) }));
    await screen.findByText('3 payouts');
    const row = must(bodyRows().find((r) => r.textContent.includes(label)));
    await user.click(must(row.querySelector<HTMLButtonElement>('button.row-open')));
    return screen.findByRole('dialog', { name: 'Payout' });
  }

  it('leads with the amount and shows the path, the leg and the receipt of a paid payout', async () => {
    const w = await world();
    const sheet = await openBy('120.00 USDC', w);
    await within(sheet).findByRole('list', { name: 'Progress' });
    expect(sheet.querySelector('.sheet-amount')?.textContent).toBe('120.00 USDC');
    expect(within(sheet).getByText('Ada')).toBeTruthy();
    const steps = within(sheet).getByRole('list', { name: 'Progress' });
    expect(
      within(steps)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual([
      expect.stringMatching(/^Requested, done/),
      'Mandate check, done',
      expect.stringMatching(/^Paid, done/),
    ]);
    const tx = within(sheet)
      .getAllByRole('link')
      .find((a) => a.getAttribute('href')?.startsWith(CONFIG.explorerTxBase) === true);
    expect(tx).toBeTruthy();
    expect(await within(sheet).findByText('Receipt ID')).toBeTruthy();
    expect(within(sheet).getByTitle(/^ujira:tx:v1:stellar:testnet:[0-9a-f]{64}:0$/)).toBeTruthy();
  });

  it('says why a payout was blocked and stops the path there', async () => {
    const w = await world();
    const sheet = await openBy('900.00 USDC', w);
    expect(await within(sheet).findByText('Over the max per payment.')).toBeTruthy();
    const steps = within(sheet).getByRole('list', { name: 'Progress' });
    expect(
      within(steps)
        .getAllByRole('listitem')
        .map((li) => li.textContent.split(',')[0]),
    ).toEqual(['Requested', 'Blocked']);
    expect(within(sheet).getAllByText('Not sent').length).toBeGreaterThan(0);
  });

  it('points a waiting payout to approvals and closes on Escape', async () => {
    const w = await world();
    const sheet = await openBy('300.00 USDC', w);
    expect(await within(sheet).findByRole('link', { name: /Open approvals/ })).toBeTruthy();
    expect(within(sheet).getByText('Issued once the payout ends.')).toBeTruthy();
    await act(async () => {
      fireEvent(sheet, new Event('cancel', { cancelable: true }));
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
  });

  it('opens from a shared link straight to the payout', async () => {
    const w = await world();
    const seeded = must((await w.v1.payouts()).items.find((p) => p.status === 'paid'));
    at(`?payout=${seeded.id}`);
    render(tree(<PayoutsPage />, { v1: w.v1, session: sessionFor(w, w.main) }));
    const sheet = await screen.findByRole('dialog', { name: 'Payout' });
    await within(sheet).findByRole('list', { name: 'Progress' });
    expect(sheet.querySelector('.sheet-amount')?.textContent).toBe('120.00 USDC');
  });

  it('shows the error with its reference when the payout cannot be read', async () => {
    const w = await world();
    at('?payout=0b8f6a4c-58c3-4a3b-9f0e-6c1d2e3f4a5b');
    render(tree(<PayoutsPage />, { v1: w.v1, session: sessionFor(w, w.main) }));
    const sheet = await screen.findByRole('dialog', { name: 'Payout' });
    const alert = await within(sheet).findByRole('alert');
    expect(alert.textContent).toContain('We could not find that.');
    expect(alert.textContent).toMatch(/Reference fake-\d+/);
  });
});
