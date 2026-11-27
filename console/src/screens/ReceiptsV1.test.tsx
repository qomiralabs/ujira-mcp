// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The receipts screen on /v1, against the fake client: rows from the project
// only, one line each, newest issued first; filters in the URL; the CSV from
// the server's export of the filtered set; and Verify, which shows what
// Stellar says only once the server has answered.

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it } from 'vitest';

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
import type { ReceiptVerification } from '../lib/v1Schemas';
import { MOCK_WALLET, mockWallet } from '../lib/wallet';
import { PayoutsPage, ReceiptsPage } from './Pages';
import { ReceiptsV1 } from './ReceiptsV1';

const CONFIG: Config = {
  network: 'testnet',
  networkPassphrase: 'Test SDF Network ; September 2015',
  explorerTxBase: 'https://stellar.expert/explorer/testnet/tx/',
  asset: { code: 'USDC', issuer: MOCK_WALLET, decimals: 7 },
  sdpAvailable: false,
};

const RECEIPTS = new Set<V1Screen>(['receipts']);

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
    screens = RECEIPTS,
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

function at(search: string, path = '/app/receipts') {
  history.replaceState(null, '', `${path}${search}`);
}

/** Body rows that are drawn, without the header or the spacers. */
function bodyRows(): HTMLElement[] {
  return within(screen.getByRole('table'))
    .getAllByRole('row')
    .filter((r) => r.closest('tbody') !== null);
}

async function openBy(text: string) {
  const user = userEvent.setup();
  const row = must(bodyRows().find((r) => r.textContent.includes(text)));
  await user.click(must(row.querySelector<HTMLButtonElement>('button.row-open')));
  const sheet = await screen.findByRole('dialog', { name: 'Receipt' });
  return { sheet, user };
}

beforeEach(() => {
  at('');
});

describe('the receipts list on /v1', () => {
  it('stays on /api while the flag does not name it', async () => {
    const w = await world();
    render(
      tree(<ReceiptsPage />, { v1: w.v1, session: sessionFor(w, w.main), screens: new Set() }),
    );
    expect(
      screen.getByRole('heading', { name: 'Connect a wallet to see your receipts' }),
    ).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Receipts table' })).toBeNull();
  });

  it("shows the project's receipts, newest issued first, one line each", async () => {
    const w = await world();
    render(tree(<ReceiptsPage />, { v1: w.v1, session: sessionFor(w, w.main) }));
    expect(screen.getByRole('status', { name: 'Loading receipts' })).toBeTruthy();
    expect(await screen.findByText('2 receipts')).toBeTruthy();
    const [blocked, paid] = bodyRows().map(must);
    expect(must(blocked).textContent).toContain('Kofi');
    expect(must(blocked).textContent).toContain('900.00 USDC');
    expect(must(blocked).querySelector('.pill')?.textContent).toBe('Blocked');
    expect(within(must(blocked)).getByRole('button', { name: 'Why it was blocked' })).toBeTruthy();
    expect(must(blocked).querySelector('.c-tx')?.textContent).toBe('None');

    expect(must(paid).textContent).toContain('Ada');
    expect(must(paid).textContent).toContain('120.00 USDC');
    expect(must(paid).querySelector('.pill')?.textContent).toBe('Paid');
    const tx = within(must(paid)).getByRole('link', { name: /opens Stellar Expert/ });
    expect(tx.getAttribute('href')?.startsWith(CONFIG.explorerTxBase)).toBe(true);
    await waitFor(() => {
      expect(must(paid).textContent).toContain('Weekly payouts');
    });
    const id = must((await w.v1.receipts()).items.find((r) => r.outcome === 'paid')).id;
    expect(
      within(must(paid)).getByRole('button', { name: `Open receipt ${id.slice(0, 8)}` }),
    ).toBeTruthy();
  });

  it('reads each project on its own', async () => {
    const w = await world();
    const view = render(tree(<ReceiptsPage />, { v1: w.v1, session: sessionFor(w, w.main) }));
    await screen.findByText('2 receipts');
    const ids = () =>
      bodyRows().map((r) => r.querySelector('button.row-open')?.getAttribute('data-receipt'));
    const inMain = ids();

    w.auth.useProject(w.grants.id);
    view.rerender(tree(<ReceiptsPage />, { v1: w.v1, session: sessionFor(w, w.grants) }));
    await waitFor(() => {
      expect(ids().some((id) => inMain.includes(id))).toBe(false);
    });
    expect(ids()).toHaveLength(2);
  });

  it('keeps filters in the URL, so a reload shows the same view', async () => {
    const w = await world();
    at('?mock=1');
    const user = userEvent.setup();
    const first = render(tree(<ReceiptsPage />, { v1: w.v1, session: sessionFor(w, w.main) }));
    await screen.findByText('2 receipts');

    await user.selectOptions(screen.getByLabelText('Outcome'), 'Paid');
    expect(await screen.findByText('1 receipt')).toBeTruthy();
    const params = new URLSearchParams(location.search);
    expect(params.get('outcome')).toBe('paid');
    expect(params.get('mock')).toBe('1');

    first.unmount();
    render(tree(<ReceiptsPage />, { v1: w.v1, session: sessionFor(w, w.main) }));
    expect(await screen.findByText('1 receipt')).toBeTruthy();
    expect(screen.getByLabelText<HTMLSelectElement>('Outcome').value).toBe('paid');
    expect(must(bodyRows()[0]).textContent).toContain('Ada');
  });

  it('says so when nothing matches, and clears the filters', async () => {
    const w = await world();
    at('?from=2099-01-01');
    const user = userEvent.setup();
    render(tree(<ReceiptsPage />, { v1: w.v1, session: sessionFor(w, w.main) }));
    expect(await screen.findByText('No receipts match these filters.')).toBeTruthy();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Export CSV' }).disabled).toBe(
      true,
    );
    await user.click(must(screen.getAllByRole('button', { name: 'Clear filters' })[0]));
    expect(await screen.findByText('2 receipts')).toBeTruthy();
    expect(location.search).toBe('');
  });

  it('shows the error with its reference, and loads on Try again', async () => {
    const w = await world();
    let fail = true;
    const api: V1Api = {
      ...w.v1,
      receipts: (q) =>
        fail
          ? Promise.reject(
              new ApiError('INTERNAL', 'The UJIRA server had a problem.', 500, undefined, 'req-82'),
            )
          : w.v1.receipts(q),
    };
    render(tree(<ReceiptsPage />, { v1: api, session: sessionFor(w, w.main) }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('The UJIRA server had a problem.');
    expect(alert.textContent).toContain('Reference req-82');
    fail = false;
    await userEvent.setup().click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('2 receipts')).toBeTruthy();
  });
});

describe('the CSV export', () => {
  it('downloads the filtered set from the server export', async () => {
    const w = await world();
    at('?outcome=paid');
    const asked: (PayoutQuery | undefined)[] = [];
    const api: V1Api = {
      ...w.v1,
      receiptsCsv: (q) => {
        asked.push(q);
        return w.v1.receiptsCsv(q);
      },
    };
    const saved: { name: string; text: string }[] = [];
    const notes: string[] = [];
    const user = userEvent.setup();
    render(
      tree(
        <ReceiptsV1
          v1={api}
          projectId={w.main.id}
          save={(name, text) => saved.push({ name, text })}
        />,
        { v1: api, session: sessionFor(w, w.main), notify: (m) => notes.push(m) },
      ),
    );
    await screen.findByText('1 receipt');
    await user.click(screen.getByRole('button', { name: 'Export CSV' }));
    await waitFor(() => {
      expect(saved).toHaveLength(1);
    });
    expect(asked).toEqual([{ status: 'paid' }]);
    const file = must(saved[0]);
    expect(file.name).toMatch(/^ujira-receipts-\d{4}-\d{2}-\d{2}\.csv$/);
    const lines = file.text.trimEnd().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain(',Ada,');
    expect(lines[1]).toContain(',paid,');
    expect(notes).toEqual(['Receipts saved as CSV.']);
  });

  it('saves nothing until the server answers, and shows a failure with its reference', async () => {
    const w = await world();
    let answer: (text: string) => void = () => undefined;
    let fail = true;
    const api: V1Api = {
      ...w.v1,
      receiptsCsv: () =>
        fail
          ? Promise.reject(
              new ApiError(
                'INTERNAL',
                'The UJIRA server had a problem.',
                500,
                undefined,
                'req-csv',
              ),
            )
          : new Promise<string>((resolve) => {
              answer = resolve;
            }),
    };
    const saved: string[] = [];
    const user = userEvent.setup();
    render(
      tree(<ReceiptsV1 v1={api} projectId={w.main.id} save={(name) => saved.push(name)} />, {
        v1: api,
        session: sessionFor(w, w.main),
      }),
    );
    await screen.findByText('2 receipts');
    await user.click(screen.getByRole('button', { name: 'Export CSV' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Could not export. The UJIRA server had a problem.');
    expect(alert.textContent).toContain('Reference req-csv');
    expect(saved).toEqual([]);

    fail = false;
    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    const busy = await screen.findByRole<HTMLButtonElement>('button', { name: 'Exporting' });
    expect(busy.disabled).toBe(true);
    expect(saved).toEqual([]);
    answer('receipt_id\n');
    await waitFor(() => {
      expect(saved).toHaveLength(1);
    });
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('a receipt and Verify', () => {
  it('opens in a sheet with what it proves', async () => {
    const w = await world();
    render(tree(<ReceiptsPage />, { v1: w.v1, session: sessionFor(w, w.main) }));
    await screen.findByText('2 receipts');
    const { sheet } = await openBy('120.00 USDC');
    expect(await within(sheet).findByText('Chain reference')).toBeTruthy();
    expect(sheet.querySelector('.sheet-amount')?.textContent).toBe('120.00 USDC');
    expect(within(sheet).getByText('Ada')).toBeTruthy();
    expect(within(sheet).getByTitle(/^ujira:tx:v1:stellar:testnet:[0-9a-f]{64}:0$/)).toBeTruthy();
    expect(within(sheet).getByText('Task ID')).toBeTruthy();
    expect(within(sheet).getByText('Payout ID')).toBeTruthy();
    expect(within(sheet).getByText('PDF')).toBeTruthy();
    expect(new URLSearchParams(location.search).get('receipt')).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('shows Matches Stellar only once the server answers, with the transaction link', async () => {
    const w = await world();
    let answer: (v: ReceiptVerification) => void = () => undefined;
    const asked: string[] = [];
    const api: V1Api = {
      ...w.v1,
      verifyReceipt: (id) => {
        asked.push(id);
        return new Promise((resolve) => {
          answer = resolve;
        });
      },
    };
    render(tree(<ReceiptsPage />, { v1: api, session: sessionFor(w, w.main) }));
    await screen.findByText('2 receipts');
    const { sheet, user } = await openBy('120.00 USDC');
    const paid = must((await w.v1.receipts({ status: 'paid' })).items[0]);
    await user.click(await within(sheet).findByRole('button', { name: 'Verify' }));

    const busy = within(sheet).getByRole<HTMLButtonElement>('button', { name: 'Checking Stellar' });
    expect(busy.disabled).toBe(true);
    expect(within(sheet).queryByText('Matches Stellar')).toBeNull();
    expect(asked).toEqual([paid.id]);

    answer({ matched: true, field: null, txHash: paid.txHash });
    expect(await within(sheet).findByText('Matches Stellar')).toBeTruthy();
    const link = within(sheet).getByRole('link', { name: /See it on Stellar Expert/ });
    expect(link.getAttribute('href')).toBe(`${CONFIG.explorerTxBase}${must(paid.txHash)}`);
    expect(within(sheet).getByRole('button', { name: 'Verify' })).toBeTruthy();
  });

  it('names the field that differs', async () => {
    const w = await world();
    const api: V1Api = {
      ...w.v1,
      verifyReceipt: () =>
        Promise.resolve({ matched: false, field: 'destination', txHash: 'ab'.repeat(32) }),
    };
    render(tree(<ReceiptsPage />, { v1: api, session: sessionFor(w, w.main) }));
    await screen.findByText('2 receipts');
    const { sheet, user } = await openBy('120.00 USDC');
    await user.click(await within(sheet).findByRole('button', { name: 'Verify' }));
    const alert = await within(sheet).findByRole('alert');
    expect(alert.textContent).toContain('Does not match Stellar');
    expect(alert.textContent).toContain('Stellar shows a different destination.');
    expect(within(alert).getByRole('link', { name: /See it on Stellar Expert/ })).toBeTruthy();
  });

  it('shows a failed check with its reference, and checks again on Try again', async () => {
    const w = await world();
    let fail = true;
    const api: V1Api = {
      ...w.v1,
      verifyReceipt: (id) =>
        fail
          ? Promise.reject(
              new ApiError(
                'CHAIN_UNAVAILABLE',
                'The Stellar network is not answering right now.',
                503,
                undefined,
                'req-verify',
              ),
            )
          : w.v1.verifyReceipt(id),
    };
    render(tree(<ReceiptsPage />, { v1: api, session: sessionFor(w, w.main) }));
    await screen.findByText('2 receipts');
    const { sheet, user } = await openBy('120.00 USDC');
    await user.click(await within(sheet).findByRole('button', { name: 'Verify' }));
    const alert = await within(sheet).findByRole('alert');
    expect(alert.textContent).toContain('The Stellar network is not answering right now.');
    expect(alert.textContent).toContain('Reference req-verify');
    fail = false;
    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await within(sheet).findByText('Matches Stellar')).toBeTruthy();
  });

  it('says a blocked receipt has no transaction, and gives the rule', async () => {
    const w = await world();
    render(tree(<ReceiptsPage />, { v1: w.v1, session: sessionFor(w, w.main) }));
    await screen.findByText('2 receipts');
    const { sheet } = await openBy('900.00 USDC');
    expect(await within(sheet).findByText('Over the max per payment.')).toBeTruthy();
    expect(within(sheet).getByText('No transaction to verify')).toBeTruthy();
    expect(within(sheet).queryByRole('button', { name: 'Verify' })).toBeNull();
  });

  it('opens from a shared link and closes on the close button', async () => {
    const w = await world();
    const paid = must((await w.v1.receipts({ status: 'paid' })).items[0]);
    at(`?receipt=${paid.id}`);
    const user = userEvent.setup();
    render(tree(<ReceiptsPage />, { v1: w.v1, session: sessionFor(w, w.main) }));
    const sheet = await screen.findByRole('dialog', { name: 'Receipt' });
    await within(sheet).findByText('Chain reference');
    expect(sheet.querySelector('.sheet-amount')?.textContent).toBe('120.00 USDC');
    await user.click(within(sheet).getByRole('button', { name: 'Close' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(new URLSearchParams(location.search).has('receipt')).toBe(false);
  });

  it('shows the error with its reference when the receipt cannot be read', async () => {
    const w = await world();
    at('?receipt=0b8f6a4c-58c3-4a3b-9f0e-6c1d2e3f4a5b');
    render(tree(<ReceiptsPage />, { v1: w.v1, session: sessionFor(w, w.main) }));
    const sheet = await screen.findByRole('dialog', { name: 'Receipt' });
    const alert = await within(sheet).findByRole('alert');
    expect(alert.textContent).toContain('We could not find that.');
    expect(alert.textContent).toMatch(/Reference fake-\d+/);
  });
});

describe("the payout sheet's receipt", () => {
  it('verifies from the payout too; PDF stays marked Soon', async () => {
    const w = await world();
    at('', '/app/payouts');
    const user = userEvent.setup();
    render(
      tree(<PayoutsPage />, {
        v1: w.v1,
        session: sessionFor(w, w.main),
        screens: new Set<V1Screen>(['payouts']),
      }),
    );
    await screen.findByText('3 payouts');
    const row = must(bodyRows().find((r) => r.textContent.includes('120.00 USDC')));
    await user.click(must(row.querySelector<HTMLButtonElement>('button.row-open')));
    const sheet = await screen.findByRole('dialog', { name: 'Payout' });
    await user.click(await within(sheet).findByRole('button', { name: 'Verify' }));
    expect(await within(sheet).findByText('Matches Stellar')).toBeTruthy();
    const pdf = within(sheet).getByText('PDF');
    expect(pdf.closest('.soon-inline')?.textContent).toBe('PDF Soon');
  });
});
