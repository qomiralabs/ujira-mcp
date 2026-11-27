// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The approvals queue on /v1, against the fake client: oldest first with the
// amount, the recipient, the rule and the budget left; keyed by project; a
// member who is not an approver sees the item and the reason but no buttons;
// approve and reject restate the payout, sign in the approver's wallet, and
// the row waits until the server shows the decision; J, K, A and R.

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
import type { V1Api } from '../lib/v1';
import type { TokenAmount } from '../lib/v1Schemas';
import { MOCK_WALLET, mockWallet } from '../lib/wallet';
import { ApprovalsV1 } from './ApprovalsV1';
import { ApprovalsPage } from './Pages';

const CONFIG: Config = {
  network: 'testnet',
  networkPassphrase: 'Test SDF Network ; September 2015',
  explorerTxBase: 'https://stellar.expert/explorer/testnet/tx/',
  asset: { code: 'USDC', issuer: MOCK_WALLET, decimals: 7 },
  sdpAvailable: false,
};

const APPROVALS = new Set<V1Screen>(['approvals']);
const OTHER_WALLET = encodeAddress('account', new Uint8Array(32).fill(9));
const UNIT = 10_000_000n;
const FAST = { tries: 5, intervalMs: 5 };

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
    screens = APPROVALS,
    notes = [],
  }: { v1: V1Api; session: Session; screens?: ReadonlySet<V1Screen>; notes?: string[] },
) {
  const state: AppState = {
    api: createMockApi({ delayMs: 0 }),
    v1,
    v1Screens: screens,
    config: CONFIG,
    mock: true,
    wallet: mockWallet(MOCK_WALLET),
    setWallet: () => undefined,
    notify: (m) => {
      notes.push(m);
    },
  };
  return (
    <AppContext.Provider value={state}>
      <SessionContext.Provider value={session}>{ui}</SessionContext.Provider>
    </AppContext.Provider>
  );
}

/** Holds every submit until the test lets it through, as a slow ledger would. */
function gated(v1: V1Api) {
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

function openDialog(): HTMLDialogElement {
  const d = [...document.querySelectorAll('dialog')].find((x) => x.open);
  if (d === undefined) throw new Error('no open dialog');
  return d;
}

function anyDialogOpen(): boolean {
  return [...document.querySelectorAll('dialog')].some((x) => x.open);
}

function rowOf(text: string): HTMLElement {
  const cell = screen.getByText(text, { selector: '.c-to' });
  return must(cell.closest('tr'));
}

/** A second payout that waits, newer than the seeded one, for Ada. */
async function secondWaiting(w: World): Promise<string> {
  const m = must((await w.v1.mandates()).items[0]);
  const ada = must((await w.v1.recipients()).items.find((r) => r.label === 'Ada'));
  const p = await w.v1.createPayout(
    { mandateId: m.id, recipientId: ada.id, amount: usdc(260n), taskId: 'task-200' },
    'task-200',
  );
  expect(p.status).toBe('pending_approval');
  return p.id;
}

describe('the approvals queue on /v1', () => {
  it('stays on /api while the flag does not name it', async () => {
    const w = await world();
    render(
      tree(<ApprovalsPage />, { v1: w.v1, session: sessionFor(w, w.main), screens: new Set() }),
    );
    expect(
      await screen.findByRole('heading', {
        name: 'Connect a wallet to see what waits for your approval',
      }),
    ).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Approvals queue' })).toBeNull();
  });

  it('lists what waits, oldest first, with the amount, recipient, rule and budget left', async () => {
    const w = await world();
    await secondWaiting(w);
    render(tree(<ApprovalsPage />, { v1: w.v1, session: sessionFor(w, w.main) }));
    expect(screen.getByRole('status', { name: 'Loading approvals' })).toBeTruthy();
    const queue = await screen.findByRole('region', { name: 'Approvals queue' });
    expect(await screen.findByText('2 payouts')).toBeTruthy();
    const rows = within(queue).getAllByRole('row').slice(1);
    expect(rows.map((r) => r.querySelector('.c-to')?.textContent)).toEqual(['Kofi', 'Ada']);
    const kofi = must(rows[0]);
    expect(kofi.querySelector('.c-amount')?.textContent).toBe('300.00 USDC');
    expect(kofi.querySelector('.c-status')?.textContent).toBe('Waiting for approval');
    await waitFor(() => {
      expect(kofi.querySelector('.c-rule')?.textContent).toBe('Approval from 250.00 USDC');
    });
    // 5,000 budget, 120 paid, 300 and 260 set aside for the two that wait.
    expect(kofi.querySelector('.c-left')?.textContent).toBe('4,320.00 USDC');
    expect(within(kofi).getByRole('button', { name: 'Approve 300.00 USDC to Kofi' })).toBeTruthy();
    expect(within(kofi).getByRole('button', { name: 'Reject 300.00 USDC to Kofi' })).toBeTruthy();
  });

  it('reads each project on its own', async () => {
    const w = await world();
    const view = render(tree(<ApprovalsPage />, { v1: w.v1, session: sessionFor(w, w.main) }));
    expect(await screen.findByText('1 payout')).toBeTruthy();

    const empty = createFakeV1Api(w.auth, { delayMs: 0, demo: false });
    w.auth.useProject(w.grants.id);
    view.rerender(tree(<ApprovalsPage />, { v1: empty, session: sessionFor(w, w.grants) }));
    expect(await screen.findByText('Nothing waiting for approval.')).toBeTruthy();
    expect(screen.queryByText('Kofi')).toBeNull();
  });

  it('shows a member who is not an approver the item and why, with nothing to sign', async () => {
    const w = await world();
    const create = await w.v1.prepareMandate({
      name: 'Board approves',
      approvers: [OTHER_WALLET],
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
    const fund = await w.v1.mandateAction(id, { kind: 'fund', amount: 500n * UNIT });
    await w.v1.submitSigned(fund.id, 'signed');
    const ada = must((await w.v1.recipients()).items.find((r) => r.label === 'Ada'));
    await w.v1.createPayout(
      { mandateId: id, recipientId: ada.id, amount: usdc(75n), taskId: 'board-1' },
      'board-1',
    );
    const notes: string[] = [];
    const user = userEvent.setup();
    render(
      tree(<ApprovalsV1 v1={w.v1} projectId={w.main.id} />, {
        v1: w.v1,
        session: sessionFor(w, w.main),
        notes,
      }),
    );

    expect(await screen.findByText('2 payouts')).toBeTruthy();
    const row = rowOf('Ada');
    await waitFor(() => {
      expect(within(row).getByText('Not an approver')).toBeTruthy();
    });
    expect(within(row).getByRole('tooltip').textContent).toBe(
      `Only an approver on Board approves can sign this. You are signed in as ${MOCK_WALLET.slice(0, 4)}...${MOCK_WALLET.slice(-4)}.`,
    );
    expect(row.querySelector('.row-actions')).toBeNull();
    expect(row.querySelector('.c-amount')?.textContent).toBe('75.00 USDC');

    // The keys say the same and open nothing.
    within(row)
      .getByRole('button', { name: /^Open payout/ })
      .focus();
    await user.keyboard('a');
    expect(anyDialogOpen()).toBe(false);
    expect(notes.at(-1)).toContain('Only an approver on Board approves can sign this.');
    expect(w.v1.signingRequests()).toBe(0);
  });

  it('approves after restating it, and the row waits until the server shows the decision', async () => {
    const w = await world();
    const { api, release } = gated(w.v1);
    let lag = 0;
    const slow: V1Api = {
      ...api,
      // The worker reads the chain a little after the submit returns.
      payout: async (id) => {
        const p = await api.payout(id);
        if (lag > 0) {
          lag -= 1;
          return { ...p, status: 'pending_approval' };
        }
        return p;
      },
    };
    const notes: string[] = [];
    const user = userEvent.setup();
    render(
      tree(<ApprovalsV1 v1={slow} projectId={w.main.id} readBack={FAST} />, {
        v1: slow,
        session: sessionFor(w, w.main),
        notes,
      }),
    );
    const approve = await screen.findByRole('button', { name: 'Approve 300.00 USDC to Kofi' });
    await waitFor(() => {
      expect(approve.hasAttribute('disabled')).toBe(false);
    });
    await user.click(approve);
    const dialog = openDialog();
    expect(within(dialog).getByRole('heading').textContent).toBe('Approve 300.00 USDC to Kofi?');
    expect(dialog.textContent).toContain('Weekly payouts pays it once Stellar confirms.');
    expect(dialog.textContent).toContain('task-102');
    expect(w.v1.signingRequests()).toBe(0);

    await user.click(within(dialog).getByRole('button', { name: 'Approve' }));
    const sign = await within(dialog).findByRole('button', { name: 'Sign in Demo wallet' });
    expect(dialog.textContent).toContain('Your wallet will show:');
    lag = 2;
    await user.click(sign);

    // Signed: the dialog closes and the row says it waits; nothing is shown as done.
    await waitFor(() => {
      expect(anyDialogOpen()).toBe(false);
    });
    const row = rowOf('Kofi');
    expect(row.querySelector('.c-status')?.textContent).toBe('Waiting for Stellar');
    expect(row.querySelector('.row-actions')).toBeNull();
    expect(
      (await w.v1.payout(must(row.querySelector('[data-approval]')?.getAttribute('data-approval'))))
        .status,
    ).toBe('pending_approval');

    await act(async () => {
      release();
      await Promise.resolve();
    });
    expect(await screen.findByText('Nothing waiting for approval.')).toBeTruthy();
    expect(notes).toContain('Approved 300.00 USDC to Kofi.');
    expect(lag).toBe(0);
  });

  it('says the chain is ahead when the server has not caught up, and keeps the row waiting', async () => {
    const w = await world();
    const stuck: V1Api = {
      ...w.v1,
      payout: async (id) => ({ ...(await w.v1.payout(id)), status: 'pending_approval' }),
      approvals: async (q) => {
        const page = await w.v1.approvals(q);
        if (page.items.length > 0) return page;
        // The server still lists the decided payout as waiting.
        const seeded = (await w.v1.payouts({ status: 'paid' })).items.find(
          (p) => p.taskId === 'task-102',
        );
        return {
          items: seeded === undefined ? [] : [{ ...seeded, status: 'pending_approval' }],
          nextCursor: null,
        };
      },
    };
    const notes: string[] = [];
    const user = userEvent.setup();
    render(
      tree(<ApprovalsV1 v1={stuck} projectId={w.main.id} readBack={FAST} />, {
        v1: stuck,
        session: sessionFor(w, w.main),
        notes,
      }),
    );
    const approve = await screen.findByRole('button', { name: 'Approve 300.00 USDC to Kofi' });
    await waitFor(() => {
      expect(approve.hasAttribute('disabled')).toBe(false);
    });
    await user.click(approve);
    await user.click(within(openDialog()).getByRole('button', { name: 'Approve' }));
    await user.click(
      await within(openDialog()).findByRole('button', { name: 'Sign in Demo wallet' }),
    );
    await waitFor(() => {
      expect(rowOf('Kofi').querySelector('.c-status')?.textContent).toBe('Signed');
    });
    const row = rowOf('Kofi');
    expect(row.querySelector('.c-act > a.mono-link')?.textContent).toContain(
      'opens Stellar Expert',
    );
    expect(notes).toContain('Stellar has it. The queue catches up in a moment.');
    expect(row.querySelector('.row-actions')).toBeNull();
  });

  it('moves with J and K, and rejects with R after restating it', async () => {
    const w = await world();
    const adaId = await secondWaiting(w);
    const user = userEvent.setup();
    render(
      tree(<ApprovalsV1 v1={w.v1} projectId={w.main.id} readBack={FAST} />, {
        v1: w.v1,
        session: sessionFor(w, w.main),
      }),
    );
    const kofi = await screen.findByRole('button', { name: 'Approve 300.00 USDC to Kofi' });
    await waitFor(() => {
      expect(kofi.hasAttribute('disabled')).toBe(false);
    });

    await user.keyboard('j');
    expect(document.activeElement?.closest('tr')).toBe(rowOf('Kofi'));
    expect(rowOf('Kofi').classList.contains('arow-on')).toBe(true);
    await user.keyboard('j');
    expect(document.activeElement?.closest('tr')).toBe(rowOf('Ada'));
    await user.keyboard('j');
    expect(document.activeElement?.closest('tr')).toBe(rowOf('Ada'));
    await user.keyboard('k');
    expect(document.activeElement?.closest('tr')).toBe(rowOf('Kofi'));
    await user.keyboard('j');

    await user.keyboard('r');
    const dialog = openDialog();
    expect(within(dialog).getByRole('heading').textContent).toBe('Reject 260.00 USDC to Ada?');
    expect(dialog.textContent).toContain('It will never be paid.');
    // Keys belong to the dialog while it is open.
    await user.keyboard('k');
    expect(openDialog()).toBe(dialog);

    await user.click(within(dialog).getByRole('button', { name: 'Reject' }));
    await user.click(await within(dialog).findByRole('button', { name: 'Sign in Demo wallet' }));
    await waitFor(() => {
      expect(screen.queryByText('Ada', { selector: '.c-to' })).toBeNull();
    });
    expect((await w.v1.payout(adaId)).status).toBe('rejected');
    expect(screen.getByText('1 payout')).toBeTruthy();
  });

  it('opens A from the keyboard and drops the request on Cancel', async () => {
    const w = await world();
    const user = userEvent.setup();
    render(
      tree(<ApprovalsV1 v1={w.v1} projectId={w.main.id} />, {
        v1: w.v1,
        session: sessionFor(w, w.main),
      }),
    );
    const approve = await screen.findByRole('button', { name: 'Approve 300.00 USDC to Kofi' });
    await waitFor(() => {
      expect(approve.hasAttribute('disabled')).toBe(false);
    });
    await user.keyboard('a');
    expect(anyDialogOpen()).toBe(false);
    await user.keyboard('j');
    await user.keyboard('a');
    const dialog = openDialog();
    expect(within(dialog).getByRole('heading').textContent).toBe('Approve 300.00 USDC to Kofi?');
    await user.click(within(dialog).getByRole('button', { name: 'Approve' }));
    await within(dialog).findByRole('button', { name: 'Sign in Demo wallet' });
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(anyDialogOpen()).toBe(false);
    expect(rowOf('Kofi').querySelector('.c-status')?.textContent).toBe('Waiting for approval');
  });

  it('shows the error with its reference, and loads on Try again', async () => {
    const w = await world();
    let fail = true;
    const api: V1Api = {
      ...w.v1,
      approvals: (q) =>
        fail
          ? Promise.reject(
              new ApiError('INTERNAL', 'The UJIRA server had a problem.', 500, undefined, 'req-81'),
            )
          : w.v1.approvals(q),
    };
    render(
      tree(<ApprovalsV1 v1={api} projectId={w.main.id} />, {
        v1: api,
        session: sessionFor(w, w.main),
      }),
    );
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('The UJIRA server had a problem.');
    expect(alert.textContent).toContain('Reference req-81');
    fail = false;
    await userEvent.setup().click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('1 payout')).toBeTruthy();
  });

  it('shows a refused signing request in the dialog', async () => {
    const w = await world();
    const api: V1Api = {
      ...w.v1,
      mandateAction: () =>
        Promise.reject(
          new ApiError('FORBIDDEN', 'Your role cannot do that here.', 403, undefined, 'req-9'),
        ),
    };
    const user = userEvent.setup();
    render(
      tree(<ApprovalsV1 v1={api} projectId={w.main.id} />, {
        v1: api,
        session: sessionFor(w, w.main),
      }),
    );
    const approve = await screen.findByRole('button', { name: 'Approve 300.00 USDC to Kofi' });
    await waitFor(() => {
      expect(approve.hasAttribute('disabled')).toBe(false);
    });
    await user.click(approve);
    const dialog = openDialog();
    await user.click(within(dialog).getByRole('button', { name: 'Approve' }));
    const alert = await within(dialog).findByRole('alert');
    expect(alert.textContent).toContain('Your role cannot do that here.');
    expect(alert.textContent).toContain('Reference req-9');
  });

  it('opens the payout in the sheet with the decision there, not a link back', async () => {
    const w = await world();
    const user = userEvent.setup();
    render(
      tree(<ApprovalsV1 v1={w.v1} projectId={w.main.id} />, {
        v1: w.v1,
        session: sessionFor(w, w.main),
      }),
    );
    const approve = await screen.findByRole('button', { name: 'Approve 300.00 USDC to Kofi' });
    await waitFor(() => {
      expect(approve.hasAttribute('disabled')).toBe(false);
    });
    await user.click(within(rowOf('Kofi')).getByRole('button', { name: /^Open payout/ }));
    const sheet = await screen.findByRole('dialog', { name: 'Payout' });
    expect(new URLSearchParams(location.search).get('payout')).toMatch(/^[0-9a-f-]{36}$/);
    await within(sheet).findByText('task-102', { exact: false });
    expect(within(sheet).queryByRole('link', { name: /Open approvals/ })).toBeNull();
    await user.click(await within(sheet).findByRole('button', { name: 'Reject' }));
    const dialog = [...document.querySelectorAll('dialog')].find(
      (d) => d.open && d.classList.contains('dialog'),
    );
    expect(within(must(dialog)).getByRole('heading').textContent).toBe(
      'Reject 300.00 USDC to Kofi?',
    );
  });
});
