// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

import { useEffect, useRef, useState, type ReactNode } from 'react';

import { explorerAccount, useApp } from '../app/context';
import { usePortfolio, waitingPayouts } from '../app/portfolio';
import type { PageName } from '../app/routes';
import lockupDefault from '../brand/lockup-default.svg';
import lockupReverse from '../brand/lockup-reverse.svg';
import { shortAddress } from '../lib/strkey';
import { WALLET_NAMES, rememberWallet } from '../lib/wallet';
import { ConnectDialog } from './Connect';
import { Link } from './Link';
import { BrandIcon, SoonTag, type BrandIconName } from './ui';

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
  const [connecting, setConnecting] = useState(false);
  if (wallet === null) {
    return (
      <>
        <button
          type="button"
          className="btn btn-small btn-connect"
          onClick={() => {
            setConnecting(true);
          }}
        >
          Connect wallet
        </button>
        <ConnectDialog
          open={connecting}
          onClose={() => {
            setConnecting(false);
          }}
        />
      </>
    );
  }
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

type LineIconName = 'home' | 'code' | 'key' | 'activity' | 'proof';

const LINE_ICONS: Record<LineIconName, string> = {
  home: 'M3.5 9 10 3.5 16.5 9v7a1 1 0 0 1-1 1h-3v-5h-5v5h-3a1 1 0 0 1-1-1z',
  code: 'M7 6 3 10l4 4M13 6l4 4-4 4',
  key: 'M9.5 10 16 3.5M13.5 6l2 2M7 16a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z',
  activity: 'M2.5 10h3l2-5 4 10 2-5h4',
  proof: 'M12.2 12.2 16.5 16.5M6.5 8.6l1.5 1.5 2.6-2.8M8.5 13.5a5 5 0 1 0 0-10 5 5 0 0 0 0 10z',
};

/** Simple line icons for the pages the nine brand icons do not cover. */
function LineIcon({ name }: { name: LineIconName }) {
  return (
    <svg
      className="icon line-icon"
      width="20"
      height="20"
      viewBox="0 0 20 20"
      aria-hidden="true"
      focusable="false"
    >
      <path d={LINE_ICONS[name]} />
    </svg>
  );
}

interface NavItem {
  readonly to: string;
  readonly label: string;
  readonly icon: { brand: BrandIconName } | { line: LineIconName };
  readonly pages: readonly PageName[];
  readonly soon?: boolean;
}

const NAV: readonly { readonly group: string; readonly items: readonly NavItem[] }[] = [
  {
    group: 'Pay',
    items: [
      { to: '/', label: 'Overview', icon: { line: 'home' }, pages: ['overview'] },
      {
        to: '/mandates',
        label: 'Mandates',
        icon: { brand: 'mandate' },
        pages: ['mandates', 'new', 'mandate'],
      },
      { to: '/payouts', label: 'Payouts', icon: { brand: 'payout' }, pages: ['payouts'] },
      { to: '/approvals', label: 'Approvals', icon: { brand: 'approval' }, pages: ['approvals'] },
      { to: '/receipts', label: 'Receipts', icon: { brand: 'receipt' }, pages: ['receipts'] },
      {
        to: '/recipients',
        label: 'Recipients',
        icon: { brand: 'recipient' },
        pages: ['recipients'],
      },
    ],
  },
  {
    group: 'Build',
    items: [
      { to: '/developers', label: 'Developers', icon: { line: 'code' }, pages: ['developers'] },
    ],
  },
  {
    group: 'Coming in',
    items: [
      {
        to: '/local-currency',
        label: 'Local currency',
        icon: { brand: 'local-currency' },
        pages: ['local-currency'],
        soon: true,
      },
      { to: '/team', label: 'Team and keys', icon: { line: 'key' }, pages: ['team'], soon: true },
      {
        to: '/activity',
        label: 'Wallet activity',
        icon: { line: 'activity' },
        pages: ['activity'],
        soon: true,
      },
    ],
  },
];

function SideNav({ page }: { page: PageName }) {
  const portfolio = usePortfolio();
  const waiting = portfolio?.data === undefined ? 0 : waitingPayouts(portfolio.data).length;
  return (
    <nav className="side-nav" aria-label="Dashboard">
      {NAV.map((g) => (
        <div key={g.group} className="nav-group">
          <p className="nav-group-title" aria-hidden="true">
            {g.group}
          </p>
          <ul>
            {g.items.map((item) => (
              <li key={item.to}>
                <Link to={item.to} className="nav-link" current={item.pages.includes(page)}>
                  {'brand' in item.icon ? (
                    <BrandIcon name={item.icon.brand} />
                  ) : (
                    <LineIcon name={item.icon.line} />
                  )}
                  <span className="nav-label">{item.label}</span>
                  {item.soon === true ? <SoonTag /> : null}
                  {item.to === '/approvals' && waiting > 0 ? (
                    <span className="nav-count">
                      {waiting}
                      <span className="sr-only"> waiting</span>
                    </span>
                  ) : null}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ))}
      <div className="nav-group">
        <ul>
          <li>
            <a className="nav-link" href="/instaward">
              <LineIcon name="proof" />
              <span className="nav-label">Testnet proof</span>
            </a>
          </li>
        </ul>
      </div>
    </nav>
  );
}

export function Shell({
  page,
  title,
  children,
}: {
  page: PageName;
  title: string;
  children: ReactNode;
}) {
  const { mock } = useApp();
  const heading = useRef<HTMLHeadingElement>(null);
  const first = useRef(true);

  // A new page moves focus to its title, so a screen reader hears where it is.
  useEffect(() => {
    document.title = `${title} | UJIRA`;
    if (first.current) {
      first.current = false;
      return;
    }
    heading.current?.focus();
  }, [page, title]);

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
      <div className="shell">
        <aside className="side">
          <a href="/" className="logo" aria-label="UJIRA home page">
            <img className="logo-light" src={lockupDefault} alt="" width="116" height="30" />
            <img className="logo-dark" src={lockupReverse} alt="" width="116" height="30" />
          </a>
          <SideNav page={page} />
          <p className="side-foot">
            <strong>Testnet preview.</strong> No real money moves here. Your wallet signs every
            change.
          </p>
        </aside>
        <div className="frame">
          <header className="top">
            <h1 ref={heading} tabIndex={-1} className="top-title">
              {title}
            </h1>
            <div className="top-right">
              <span className="net">
                <span className="banner-dot" aria-hidden="true" />
                Stellar testnet
              </span>
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
                Built on Stellar. UJIRA never holds your keys: your wallet signs every change to
                your mandate.
              </p>
              <p className="label">Built at Qomira Labs</p>
            </div>
            <div className="weave" aria-hidden="true" />
          </footer>
        </div>
      </div>
    </>
  );
}
