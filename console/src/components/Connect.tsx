// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

import { useEffect, useId, useRef, useState } from 'react';

import { useApp } from '../app/context';
import { useAction } from '../app/hooks';
import {
  MOCK_WALLET,
  connectAlbedo,
  connectFreighter,
  mockWallet,
  rememberWallet,
  type Wallet,
  type WalletKind,
} from '../lib/wallet';
import { ErrorNotice, Icon, Spinner } from './ui';

const WALLET_CHOICES: readonly { kind: WalletKind; name: string; text: string }[] = [
  { kind: 'freighter', name: 'Freighter', text: 'Extension, set to Testnet' },
  { kind: 'albedo', name: 'Albedo', text: 'Nothing to install' },
];

/** One button per wallet a person can bring, plus the demo wallet in mock mode. */
export function WalletChoices({ onConnected }: { onConnected?: () => void }) {
  const { config, mock, setWallet } = useApp();
  const [pending, setPending] = useState<WalletKind | null>(null);
  const connect = useAction(async (kind: WalletKind) => {
    setPending(kind);
    try {
      let w: Wallet;
      if (kind === 'mock') w = mockWallet(MOCK_WALLET);
      else if (kind === 'freighter') w = await connectFreighter(config.networkPassphrase);
      else w = await connectAlbedo();
      rememberWallet(w);
      setWallet(w);
      onConnected?.();
    } finally {
      setPending(null);
    }
  });
  const choices = mock
    ? [
        { kind: 'mock' as const, name: 'Demo wallet', text: 'Mock mode, nothing is sent' },
        ...WALLET_CHOICES,
      ]
    : WALLET_CHOICES;
  return (
    <div className="wallet-options">
      {choices.map((c, i) => (
        <button
          key={c.kind}
          type="button"
          className={`wallet-option${i === 0 ? ' wallet-option-primary' : ''}`}
          onClick={() => void connect.run(c.kind)}
          disabled={connect.busy}
        >
          <span>
            <strong>{pending === c.kind ? `Waiting for ${c.name}` : `Connect ${c.name}`}</strong>
            <span className="muted small">{c.text}</span>
          </span>
          {pending === c.kind ? <Spinner /> : <Icon name="arrow" size={18} />}
        </button>
      ))}
      {connect.error === null ? null : <ErrorNotice error={connect.error} />}
    </div>
  );
}

/** The wallet choices in a dialog, opened from the header on any page. */
export function ConnectDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const d = ref.current;
    if (d === null) return;
    if (open && !d.open) {
      if (typeof d.showModal === 'function') d.showModal();
      else d.setAttribute('open', '');
    }
    if (!open && d.open) {
      if (typeof d.close === 'function') d.close();
      else d.removeAttribute('open');
    }
  }, [open]);
  return (
    <dialog
      ref={ref}
      className="dialog"
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      {open ? (
        <>
          <h2 id={titleId}>Connect a wallet</h2>
          <div className="dialog-body">
            <p className="assure">
              <Icon name="lock" size={16} />
              Your keys stay in your wallet.
            </p>
            <WalletChoices onConnected={onClose} />
          </div>
          <div className="actions">
            <button type="button" className="btn" onClick={onClose}>
              Not now
            </button>
          </div>
        </>
      ) : null}
    </dialog>
  );
}

/** Shown on a page that needs a wallet before it has anything to show. */
export function ConnectPrompt({ what }: { what: string }) {
  const id = useId();
  return (
    <section className="card connect-prompt" aria-labelledby={id}>
      <h2 id={id} className="card-title">
        Connect a wallet to see {what}
      </h2>
      <p className="assure">
        <Icon name="lock" size={16} />
        Non-custodial. Your wallet signs.
      </p>
      <WalletChoices />
    </section>
  );
}
