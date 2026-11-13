// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

import { useEffect, useState, type ReactNode } from 'react';

import { explorerAccount, useApp } from '../app/context';
import lockupDefault from '../brand/lockup-default.svg';
import lockupReverse from '../brand/lockup-reverse.svg';
import { shortAddress } from '../lib/strkey';
import { WALLET_NAMES, rememberWallet } from '../lib/wallet';

type Theme = 'system' | 'light' | 'dark';
const THEME_KEY = 'ujira.console.theme';
const NEXT: Record<Theme, Theme> = { system: 'light', light: 'dark', dark: 'system' };
const THEME_LABEL: Record<Theme, string> = {
  system: 'Theme: follows your device',
  light: 'Theme: light',
  dark: 'Theme: dark',
};

function readTheme(): Theme {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(readTheme);
  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', theme);
    try {
      if (theme === 'system') localStorage.removeItem(THEME_KEY);
      else localStorage.setItem(THEME_KEY, theme);
    } catch {
      // Without storage the choice lasts for this visit only.
    }
  }, [theme]);
  return (
    <button
      type="button"
      className="btn btn-ghost btn-small"
      onClick={() => {
        setTheme(NEXT[theme]);
      }}
      title={THEME_LABEL[theme]}
    >
      <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        <circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <path d="M8 2.5a5.5 5.5 0 0 1 0 11z" fill="currentColor" />
      </svg>
      <span className="sr-only">{THEME_LABEL[theme]}. Press to change.</span>
      <span aria-hidden="true" className="theme-word">
        {theme === 'system' ? 'Auto' : theme === 'light' ? 'Light' : 'Dark'}
      </span>
    </button>
  );
}

function WalletChip() {
  const { wallet, setWallet, config } = useApp();
  if (wallet === null) return null;
  return (
    <div className="wallet-chip">
      <a
        className="mono-link"
        href={explorerAccount(config, wallet.address)}
        target="_blank"
        rel="noreferrer"
        title={wallet.address}
      >
        {shortAddress(wallet.address)}
        <span className="sr-only"> in {WALLET_NAMES[wallet.kind]}, opens Stellar Expert</span>
      </a>
      <span className="wallet-name" aria-hidden="true">
        {WALLET_NAMES[wallet.kind]}
      </span>
      <button
        type="button"
        className="btn btn-ghost btn-small"
        onClick={() => {
          rememberWallet(null);
          setWallet(null);
        }}
      >
        Disconnect
      </button>
    </div>
  );
}

export function Shell({ children }: { children: ReactNode }) {
  const { mock } = useApp();
  return (
    <>
      <a className="skip" href="#main">
        Skip to the content
      </a>
      <div className="banner" role="note">
        <span className="banner-dot" aria-hidden="true" />
        Stellar testnet. Test money only.
        {mock ? <strong> Mock mode: nothing here touches the network.</strong> : null}
      </div>
      <header className="top">
        <a href="#/" className="logo" aria-label="UJIRA Console home">
          <img className="logo-light" src={lockupDefault} alt="" width="116" height="30" />
          <img className="logo-dark" src={lockupReverse} alt="" width="116" height="30" />
          <span className="logo-word">Console</span>
        </a>
        <div className="top-right">
          <WalletChip />
          <ThemeToggle />
        </div>
      </header>
      <main id="main" className="main" tabIndex={-1}>
        {children}
      </main>
      <footer className="foot">
        <div className="foot-inner">
          <p>
            Built on Stellar. UJIRA never holds your keys: your wallet signs every change to your
            mandate.
          </p>
          <p className="label">Built at Qomira Labs</p>
        </div>
        <div className="weave" aria-hidden="true" />
      </footer>
    </>
  );
}
