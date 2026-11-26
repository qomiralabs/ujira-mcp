// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

import { useCallback, useEffect, useMemo, useState } from 'react';

import { Shell } from '../components/Shell';
import { ErrorNotice, Skeleton } from '../components/ui';
import type { ConsoleApi } from '../lib/api';
import type { AuthApi } from '../lib/auth';
import { rememberWallet, rememberedWallet, restoreWallet, type Wallet } from '../lib/wallet';
import { ActivityPage, LocalCurrencyPage, NotFoundPage, TeamPage } from '../screens/Coming';
import { CreateMandate } from '../screens/CreateMandate';
import { DevelopersPage } from '../screens/Developers';
import { MandatePage } from '../screens/MandatePage';
import { Overview } from '../screens/Overview';
import { ApprovalsPage, MandatesPage, PayoutsPage, ReceiptsPage } from '../screens/Pages';
import { RecipientsPage } from '../screens/Recipients';
import { AppContext, type AppState } from './context';
import { useResource, useRoute } from './hooks';
import { PORTFOLIO_POLL_MS, PortfolioContext, loadPortfolio } from './portfolio';
import type { Route } from './routes';
import { SessionGate } from './session';

const TITLES: Record<Exclude<Route['name'], 'mandate'>, string> = {
  overview: 'Overview',
  mandates: 'Mandates',
  new: 'Create a mandate',
  approvals: 'Approvals',
  payouts: 'Payouts',
  receipts: 'Receipts',
  recipients: 'Recipients',
  developers: 'Developers',
  'local-currency': 'Local currency',
  team: 'Team and keys',
  activity: 'Wallet activity',
  'not-found': 'Page not found',
};

function titleOf(route: Route): string {
  // The mandate page shows its full ID, with a copy button, under the title.
  return route.name === 'mandate' ? 'Mandate' : TITLES[route.name];
}

function Page({ route }: { route: Route }) {
  switch (route.name) {
    case 'overview':
      return <Overview />;
    case 'mandates':
      return <MandatesPage />;
    case 'new':
      return <CreateMandate />;
    case 'mandate':
      return <MandatePage key={route.id} id={route.id} />;
    case 'approvals':
      return <ApprovalsPage />;
    case 'payouts':
      return <PayoutsPage />;
    case 'receipts':
      return <ReceiptsPage />;
    case 'recipients':
      return <RecipientsPage />;
    case 'developers':
      return <DevelopersPage />;
    case 'local-currency':
      return <LocalCurrencyPage />;
    case 'team':
      return <TeamPage />;
    case 'activity':
      return <ActivityPage />;
    case 'not-found':
      return <NotFoundPage />;
  }
}

function Toast({ message }: { message: string | null }) {
  return (
    <div className={`toast${message === null ? '' : ' toast-on'}`} role="status" aria-live="polite">
      {message}
    </div>
  );
}

/**
 * The console. With `auth`, every page sits behind wallet sign in: always in
 * mock mode, and on a live server once its config says sign in is on.
 */
export function App({ api, auth, mock }: { api: ConsoleApi; auth?: AuthApi; mock: boolean }) {
  const config = useResource('config', () => api.config());
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [toast, setToast] = useState<{ message: string; n: number } | null>(null);
  const route = useRoute();
  const passphrase = config.data?.networkPassphrase;
  const address = wallet?.address ?? null;
  // Shared by every page, so moving between them shows data at once.
  const portfolio = useResource(
    address === null ? null : `portfolio:${address}`,
    () => loadPortfolio(api, address ?? ''),
    PORTFOLIO_POLL_MS,
  );

  useEffect(() => {
    if (passphrase === undefined) return;
    const saved = rememberedWallet();
    if (saved === null) return;
    if (saved.kind === 'mock' && !mock) return;
    let live = true;
    restoreWallet(saved, passphrase).then(
      (w) => {
        if (!live) return;
        if (w === null) rememberWallet(null);
        else setWallet((current) => current ?? w);
      },
      () => {
        if (live) rememberWallet(null);
      },
    );
    return () => {
      live = false;
    };
  }, [passphrase, mock]);

  const notify = useCallback((message: string) => {
    setToast((t) => ({ message, n: (t?.n ?? 0) + 1 }));
  }, []);

  useEffect(() => {
    if (toast === null) return;
    const id = setTimeout(() => {
      setToast(null);
    }, 4500);
    return () => {
      clearTimeout(id);
    };
  }, [toast]);

  const state = useMemo<AppState | null>(
    () =>
      config.data === undefined
        ? null
        : { api, config: config.data, mock, wallet, setWallet, notify },
    [api, config.data, mock, wallet, notify],
  );

  if (state === null) {
    return (
      <main className="main boot">
        {config.error === null ? (
          <Skeleton lines={4} label="Loading the UJIRA dashboard" />
        ) : (
          <ErrorNotice error={config.error} onRetry={config.reload} />
        )}
      </main>
    );
  }

  const dashboard = (
    <PortfolioContext.Provider value={address === null ? null : portfolio}>
      <Shell page={route.name} title={titleOf(route)}>
        <Page route={route} />
      </Shell>
    </PortfolioContext.Provider>
  );
  const gated = auth !== undefined && (mock || state.config.signIn === true);

  return (
    <AppContext.Provider value={state}>
      {gated ? <SessionGate auth={auth}>{dashboard}</SessionGate> : dashboard}
      <Toast message={toast?.message ?? null} />
    </AppContext.Provider>
  );
}
