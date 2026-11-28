// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The switch from /api to /v1, screen by screen, and what a person sees when
// a /v1 answer goes wrong: the error state with the request id and never the
// data, a retry time on a 429, and the sign in screen on a 401.

import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { Amount, ErrorNotice, Skeleton } from '../components/ui';
import { createFakeAuthApi } from '../lib/fakeAuth';
import { createFakeV1Api } from '../lib/fakeV1';
import { createMockApi } from '../lib/mock';
import type { Config } from '../lib/schemas';
import { createHttpV1Api, createV1Transport, type V1Api } from '../lib/v1';
import { MOCK_WALLET } from '../lib/wallet';
import { IDS, RECORDED, payout } from '../test/v1Recorded';
import { App } from './App';
import { AppContext, type AppState } from './context';
import { useResource } from './hooks';
import { SessionContext, type Session } from './session';
import { parseV1Screens, useV1, type V1Screen } from './switch';

const CONFIG: Config = {
  network: 'testnet',
  networkPassphrase: 'Test SDF Network ; September 2015',
  explorerTxBase: 'https://stellar.expert/explorer/testnet/tx/',
  asset: { code: 'USDC', issuer: IDS.principalAddress, decimals: 7 },
  sdpAvailable: false,
};

const PRINCIPAL = { id: IDS.principal, name: 'Acme Ltd', role: 'owner' };
const PROJECT = { id: IDS.project, principalId: IDS.principal, name: 'Main' };

const SESSION: Session = {
  member: { id: 'm-1', address: IDS.principalAddress },
  principals: [PRINCIPAL],
  projects: [PROJECT],
  project: PROJECT,
  principal: PRINCIPAL,
  selectProject: () => undefined,
  createProject: () => Promise.resolve(),
  signOut: () => Promise.resolve(),
};

function respond(status: number, body: unknown, headers: Record<string, string> = {}) {
  return () =>
    Promise.resolve(
      new Response(typeof body === 'string' ? body : JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json', 'Ujira-Request-Id': 'req-9f2c', ...headers },
      }),
    );
}

function Probe() {
  const v1 = useV1('payouts');
  const payouts = useResource(v1 === null ? null : 'v1:payouts', () =>
    v1 === null ? Promise.reject(new Error('Not on /v1')) : v1.payouts(),
  );
  if (v1 === null) return <p>Reading /api</p>;
  if (payouts.error !== null) {
    return (
      <ErrorNotice
        error={payouts.error}
        onRetry={payouts.reload}
        requestId={payouts.errorRequestId}
      />
    );
  }
  if (payouts.data === undefined) return <Skeleton label="Loading payouts" />;
  return (
    <ul aria-label="Payouts">
      {payouts.data.items.map((p) => (
        <li key={p.id}>
          <Amount token={p.amount} />
        </li>
      ))}
    </ul>
  );
}

function renderProbe(
  v1: V1Api | null,
  screens: ReadonlySet<V1Screen>,
  session: Session | null = SESSION,
) {
  const state: AppState = {
    api: createMockApi({ delayMs: 0 }),
    v1,
    v1Screens: screens,
    config: CONFIG,
    mock: true,
    wallet: null,
    setWallet: () => undefined,
    notify: () => undefined,
  };
  return render(
    <AppContext.Provider value={state}>
      <SessionContext.Provider value={session}>
        <Probe />
      </SessionContext.Provider>
    </AppContext.Provider>,
  );
}

const PAYOUTS = new Set<V1Screen>(['payouts']);

describe('the build flag', () => {
  it('names screens one by one, or all of them, and ignores what it does not know', () => {
    expect([...parseV1Screens(undefined)]).toEqual([]);
    expect([...parseV1Screens('')]).toEqual([]);
    expect([...parseV1Screens(' payouts , Receipts,bogus,')]).toEqual(['payouts', 'receipts']);
    expect(parseV1Screens('all').size).toBe(7);
    expect(parseV1Screens('payouts,all').has('developers')).toBe(true);
  });

  it('keeps a screen on /api until the flag names it', () => {
    const v1 = createHttpV1Api(createV1Transport(respond(200, RECORDED['GET /v1/payouts'])));
    renderProbe(v1, new Set(['receipts']));
    expect(screen.getByText('Reading /api')).toBeTruthy();
  });

  it('keeps a named screen on /api while nobody is signed in', () => {
    const v1 = createHttpV1Api(createV1Transport(respond(200, RECORDED['GET /v1/payouts'])));
    renderProbe(v1, PAYOUTS, null);
    expect(screen.getByText('Reading /api')).toBeTruthy();
  });

  it('keeps every screen on /api without a /v1 client', () => {
    renderProbe(null, PAYOUTS);
    expect(screen.getByText('Reading /api')).toBeTruthy();
  });

  it('moves a named screen to /v1 once signed in, with amounts from the one formatter', async () => {
    const v1 = createHttpV1Api(createV1Transport(respond(200, RECORDED['GET /v1/payouts'])));
    renderProbe(v1, PAYOUTS);
    const list = await screen.findByRole('list', { name: 'Payouts' });
    expect(list.textContent).toContain('2.50 USDC');
    // The largest i128, in its 7 decimals.
    expect(list.textContent).toContain('17,014,118,346,046,923,173,168,730,371,588.4105727 USDC');
  });
});

describe('a /v1 answer that goes wrong', () => {
  it('shows the error state with the request id, and none of the data', async () => {
    const leaked = 'GLEAKEDADDRESSSHOULDNOTSHOW';
    const v1 = createHttpV1Api(
      createV1Transport(
        respond(200, {
          items: [{ ...payout, recipient: { id: 1, label: leaked } }],
          nextCursor: null,
        }),
      ),
    );
    renderProbe(v1, PAYOUTS);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('The server sent an answer in a shape we did not expect.');
    expect(alert.textContent).toContain('Reference req-9f2c');
    expect(document.body.textContent).not.toContain(leaked);
    expect(document.body.textContent).not.toContain('USDC');
  });

  it('shows how long to wait on a 429, and loads again on Try again', async () => {
    let limited = true;
    const v1 = createHttpV1Api(
      createV1Transport(() =>
        limited
          ? respond(
              429,
              { error: { code: 'RATE_LIMITED', message: 'Too many', requestId: 'req-429' } },
              { 'Retry-After': '120' },
            )()
          : respond(200, RECORDED['GET /v1/payouts'])(),
      ),
    );
    renderProbe(v1, PAYOUTS);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Try again in about 2 minutes.');
    expect(alert.textContent).toContain('Reference req-429');
    limited = false;
    await userEvent.setup().click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('list', { name: 'Payouts' })).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('sends the person to sign in when any /v1 call finds the session gone', async () => {
    const auth = createFakeAuthApi({
      delayMs: 0,
      seed: [{ address: MOCK_WALLET, principals: [{ name: 'Acme Ltd', projects: ['Payouts'] }] }],
      signedInAs: MOCK_WALLET,
    });
    const v1 = createFakeV1Api(auth, { delayMs: 0 });
    render(
      <App api={createMockApi({ delayMs: 0 })} auth={auth} v1={v1} v1Screens={PAYOUTS} mock />,
    );
    expect(await screen.findByRole('heading', { level: 1, name: 'Overview' })).toBeTruthy();
    expect((await v1.payouts()).items.length).toBeGreaterThan(0);

    await act(async () => {
      auth.expire();
      await v1.payouts().catch(() => undefined);
    });
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Sign in with your wallet' }),
    ).toBeTruthy();
    expect(screen.getByText('Your session has ended. Sign in again.')).toBeTruthy();
    expect(screen.queryByRole('navigation', { name: 'Dashboard' })).toBeNull();
  });
});
