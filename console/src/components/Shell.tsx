// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';

import { explorerAccount, useApp } from '../app/context';
import { usePortfolio, waitingPayouts } from '../app/portfolio';
import type { PageName } from '../app/routes';
import { shortAddress } from '../lib/strkey';
import { WALLET_NAMES, rememberWallet } from '../lib/wallet';
import { ConnectDialog } from './Connect';
import { Link } from './Link';
import { BrandIcon, Icon, Logo, SoonTag, type BrandIconName, type IconName } from './ui';

type Theme = 'system' | 'light' | 'dark';
const THEME_KEY = 'ujira.console.theme';
const NEXT: Record<Theme, Theme> = { system: 'light', light: 'dark', dark: 'system' };
const THEME_LABEL: Record<Theme, string> = {
  system: 'Theme: follows your device',
  light: 'Theme: light',
  dark: 'Theme: dark',
};
const THEME_ICON: Record<Theme, IconName> = { system: 'auto', light: 'sun', dark: 'moon' };

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
      className="btn-icon"
      onClick={() => {
        setTheme(NEXT[theme]);
      }}
      title={THEME_LABEL[theme]}
    >
      <Icon name={THEME_ICON[theme]} size={18} />
      <span className="sr-only">{THEME_LABEL[theme]}. Press to change.</span>
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
          className="btn btn-primary btn-small"
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
      <span className="wallet-dot" aria-hidden="true" />
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
        className="btn-icon btn-icon-sm"
        title="Disconnect"
        onClick={() => {
          rememberWallet(null);
          setWallet(null);
        }}
      >
        <Icon name="power" size={16} />
        <span className="sr-only">Disconnect</span>
      </button>
    </div>
  );
}

type NavIcon = { brand: BrandIconName } | { line: IconName };

interface NavItem {
  readonly to: string;
  readonly label: string;
  readonly icon: NavIcon;
  readonly pages: readonly PageName[];
  readonly soon?: boolean;
}

const NAV: readonly (readonly NavItem[])[] = [
  [
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
    { to: '/recipients', label: 'Recipients', icon: { brand: 'recipient' }, pages: ['recipients'] },
  ],
  [{ to: '/developers', label: 'Developers', icon: { line: 'code' }, pages: ['developers'] }],
  [
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
];

function NavGlyph({ icon }: { icon: NavIcon }) {
  return 'brand' in icon ? <BrandIcon name={icon.brand} /> : <Icon name={icon.line} />;
}

function useWaiting(): number {
  const portfolio = usePortfolio();
  return portfolio?.data === undefined ? 0 : waitingPayouts(portfolio.data).length;
}

function Count({ n }: { n: number }) {
  return n > 0 ? (
    <span className="nav-count">
      {n}
      <span className="sr-only"> waiting</span>
    </span>
  ) : null;
}

function SideNav({ page }: { page: PageName }) {
  const waiting = useWaiting();
  return (
    <nav className="side-nav" aria-label="Dashboard">
      {NAV.map((group, g) => (
        <ul key={g} className="nav-group">
          {group.map((item) => (
            <li key={item.to}>
              <Link to={item.to} className="nav-link" current={item.pages.includes(page)}>
                <NavGlyph icon={item.icon} />
                <span className="nav-label">{item.label}</span>
                {item.soon === true ? <SoonTag /> : null}
                {item.to === '/approvals' ? <Count n={waiting} /> : null}
              </Link>
            </li>
          ))}
        </ul>
      ))}
      <ul className="nav-group">
        <li>
          <a className="nav-link" href="/instaward">
            <Icon name="proof" />
            <span className="nav-label">Testnet proof</span>
          </a>
        </li>
      </ul>
    </nav>
  );
}

const TABS: readonly NavItem[] = [
  { to: '/', label: 'Overview', icon: { line: 'home' }, pages: ['overview'] },
  {
    to: '/mandates',
    label: 'Mandates',
    icon: { brand: 'mandate' },
    pages: ['mandates', 'new', 'mandate'],
  },
  { to: '/approvals', label: 'Approvals', icon: { brand: 'approval' }, pages: ['approvals'] },
  { to: '/receipts', label: 'Receipts', icon: { brand: 'receipt' }, pages: ['receipts'] },
];

/** The phone's bottom bar: the four pages used most, and the full menu. */
function TabBar({
  page,
  menuOpen,
  onMenu,
  menuButton,
}: {
  page: PageName;
  menuOpen: boolean;
  onMenu: () => void;
  menuButton: RefObject<HTMLButtonElement | null>;
}) {
  const waiting = useWaiting();
  const inTabs = TABS.some((t) => t.pages.includes(page));
  return (
    <nav className="tabbar" aria-label="Shortcuts">
      {TABS.map((t) => (
        <Link key={t.to} to={t.to} className="tab" current={t.pages.includes(page)}>
          <span className="tab-icon">
            <NavGlyph icon={t.icon} />
          </span>
          <span className="tab-label">{t.label}</span>
          {t.to === '/approvals' ? <Count n={waiting} /> : null}
        </Link>
      ))}
      <button
        ref={menuButton}
        type="button"
        className={`tab${inTabs ? '' : ' tab-on'}`}
        aria-expanded={menuOpen}
        aria-controls="side-menu"
        onClick={onMenu}
      >
        <span className="tab-icon">
          <Icon name="more" />
        </span>
        <span className="tab-label">Menu</span>
      </button>
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
  const menuButton = useRef<HTMLButtonElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);

  // A new page moves focus to its title, so a screen reader hears where it is.
  useEffect(() => {
    document.title = `${title} | UJIRA`;
    setMenuOpen(false);
    if (first.current) {
      first.current = false;
      return;
    }
    heading.current?.focus();
  }, [page, title]);

  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle('menu-open', menuOpen);
    if (!menuOpen) return;
    closeButton.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setMenuOpen(false);
        menuButton.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      root.classList.remove('menu-open');
    };
  }, [menuOpen]);

  const closeMenu = () => {
    setMenuOpen(false);
    menuButton.current?.focus();
  };

  return (
    <>
      <a className="skip" href="#main">
        Skip to the content
      </a>
      <div className="shell">
        <aside id="side-menu" className={`side${menuOpen ? ' side-open' : ''}`}>
          <div className="side-head">
            <a href="/" className="logo" aria-label="UJIRA home page">
              <Logo />
            </a>
            <button
              ref={closeButton}
              type="button"
              className="btn-icon side-close"
              onClick={closeMenu}
            >
              <Icon name="close" size={18} />
              <span className="sr-only">Close the menu</span>
            </button>
          </div>
          <SideNav page={page} />
        </aside>
        {menuOpen ? <div className="scrim" aria-hidden="true" onClick={closeMenu} /> : null}
        <div className="frame">
          <header className="top">
            <h1 ref={heading} tabIndex={-1} className="top-title">
              {title}
            </h1>
            <div className="top-right">
              <span className="top-mark" aria-hidden="true">
                <Logo height={22} />
              </span>
              <span className="top-status">
                <span className="net" title="Stellar testnet. Test money only.">
                  <span className="net-dot" aria-hidden="true" />
                  Testnet
                </span>
                {mock ? (
                  <span
                    className="net net-mock"
                    title="Mock mode: nothing here touches the network."
                  >
                    Mock
                  </span>
                ) : null}
              </span>
              <span className="top-user">
                <WalletChip />
                <ThemeToggle />
              </span>
            </div>
          </header>
          <main id="main" className="main" tabIndex={-1}>
            {children}
          </main>
        </div>
      </div>
      <TabBar
        page={page}
        menuOpen={menuOpen}
        menuButton={menuButton}
        onMenu={() => {
          setMenuOpen((o) => !o);
        }}
      />
    </>
  );
}
