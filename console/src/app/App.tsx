// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

import { useCallback, useEffect, useMemo, useState } from 'react';

import { Shell } from '../components/Shell';
import { ErrorNotice, Skeleton } from '../components/ui';
import type { ConsoleApi } from '../lib/api';
import { rememberWallet, rememberedWallet, restoreWallet, type Wallet } from '../lib/wallet';
import { CreateMandate } from '../screens/CreateMandate';
import { Home } from '../screens/Home';
import { MandatePage } from '../screens/MandatePage';
import { AppContext, type AppState } from './context';
import { useResource, useRoute } from './hooks';

function Toast({ message }: { message: string | null }) {
  return (
    <div className={`toast${message === null ? '' : ' toast-on'}`} role="status" aria-live="polite">
      {message}
    </div>
  );
}

export function App({ api, mock }: { api: ConsoleApi; mock: boolean }) {
  const config = useResource('config', () => api.config());
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [toast, setToast] = useState<{ message: string; n: number } | null>(null);
  const route = useRoute();
  const passphrase = config.data?.networkPassphrase;

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
          <Skeleton lines={4} label="Loading the UJIRA Console" />
        ) : (
          <ErrorNotice error={config.error} onRetry={config.reload} />
        )}
      </main>
    );
  }

  return (
    <AppContext.Provider value={state}>
      <Shell>
        {route.name === 'mandate' ? (
          <MandatePage key={route.id} id={route.id} />
        ) : route.name === 'new' ? (
          <CreateMandate />
        ) : (
          <Home />
        )}
      </Shell>
      <Toast message={toast?.message ?? null} />
    </AppContext.Provider>
  );
}
