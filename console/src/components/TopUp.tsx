// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The faucet tops a wallet up to a fixed amount of test USDC, as often as the
// cooldown allows, so a reviewer who spent their test money is never stuck.

import { useEffect, useState } from 'react';

import { useApp } from '../app/context';
import { useAction } from '../app/hooks';
import { ApiError } from '../lib/api';
import { formatAmount } from '../lib/money';
import type { Wallet } from '../lib/wallet';
import { cooldownText, cooldownWords } from '../lib/words';
import { ErrorNotice, Notice, Spinner, TxLink } from './ui';

const DEFAULT_TARGET = '500000000';
const DEFAULT_COOLDOWN = 600;

export interface TopUp {
  readonly enabled: boolean;
  readonly busy: boolean;
  readonly error: string | null;
  /** "Top up to 50 test USDC". */
  readonly label: string;
  /** A few words on how often it works, or how long until it works again. */
  readonly hint: string;
  /** True while the faucet is cooling down for this wallet. */
  readonly cooling: boolean;
  /** Not an error: the wallet already holds the target. */
  readonly info: string | null;
  readonly last: { readonly hash: string; readonly amount: string } | null;
  run: () => void;
}

export function useTopUp(wallet: Wallet, onDone?: () => void): TopUp {
  const { api, config, notify } = useApp();
  const target = config.faucet?.target ?? config.faucet?.amount ?? DEFAULT_TARGET;
  const cooldown = config.faucet?.cooldownSeconds ?? DEFAULT_COOLDOWN;
  const [readyAt, setReadyAt] = useState<number | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [last, setLast] = useState<{ hash: string; amount: string } | null>(null);
  const [now, setNow] = useState(() => Date.now());

  // Counts the wait down while there is one, then stops.
  useEffect(() => {
    if (readyAt === null) return;
    const id = setInterval(() => {
      const t = Date.now();
      setNow(t);
      if (t >= readyAt) setReadyAt(null);
    }, 10_000);
    return () => {
      clearInterval(id);
    };
  }, [readyAt]);

  const action = useAction(async () => {
    setInfo(null);
    try {
      const res = await api.onboardUsdc(wallet.address);
      const t = Date.now();
      setLast(res);
      setNow(t);
      setReadyAt(cooldown > 0 ? t + cooldown * 1000 : null);
      notify(
        `${formatAmount(res.amount)} test USDC arrived. Your wallet holds ${formatAmount(target, { minFraction: 0 })} test USDC again.`,
      );
      onDone?.();
    } catch (error) {
      // Waiting and already full are states to explain, not failures.
      if (error instanceof ApiError && error.code === 'faucet_cooldown') {
        const t = Date.now();
        setNow(t);
        setReadyAt(t + (error.retryAfterSeconds ?? cooldown) * 1000);
        return;
      }
      if (error instanceof ApiError && error.code === 'faucet_not_needed') {
        setInfo(error.message);
        return;
      }
      throw error;
    }
  });

  const waiting = readyAt !== null && readyAt > now;
  return {
    enabled: config.faucet?.enabled !== false,
    busy: action.busy,
    error: action.error,
    label: `Top up to ${formatAmount(target, { minFraction: 0 })} test USDC`,
    hint: waiting
      ? cooldownText(Math.ceil((readyAt - now) / 1000))
      : `Free, ${cooldownWords(cooldown)}.`,
    cooling: waiting,
    info,
    last,
    run: () => void action.run(),
  };
}

/** The faucet when it is offline: where else to get test USDC. */
export function FaucetOffline() {
  return (
    <>
      Faucet offline. Try{' '}
      <a href="https://faucet.circle.com" target="_blank" rel="noreferrer">
        faucet.circle.com
        <span className="sr-only"> (Stellar testnet, opens in a new tab)</span>
      </a>
    </>
  );
}

/** A self contained top up: the button, how often it works, and what it did. */
export function TopUpPanel({
  wallet,
  intro,
  onDone,
}: {
  wallet: Wallet;
  /** One short line above the button, when the place needs it. */
  intro?: string;
  onDone?: () => void;
}) {
  const t = useTopUp(wallet, onDone);
  return (
    <div className="stack-sm">
      {intro === undefined && t.enabled ? null : (
        <p className="small">{t.enabled ? intro : <FaucetOffline />}</p>
      )}
      <div className="actions">
        <button type="button" className="btn" disabled={!t.enabled || t.busy} onClick={t.run}>
          {t.busy ? <Spinner /> : null}
          {t.label}
        </button>
        {t.enabled ? (
          <span className="muted small" role="status">
            {t.hint}
          </span>
        ) : null}
      </div>
      <TopUpResult t={t} />
    </div>
  );
}

export function TopUpResult({ t }: { t: TopUp }) {
  return (
    <>
      {t.last === null ? null : (
        <p className="small">
          Sent {formatAmount(t.last.amount)} test USDC to your wallet. <TxLink hash={t.last.hash} />
        </p>
      )}
      {t.info === null ? null : (
        <Notice tone="info">
          <p>{t.info}</p>
        </Notice>
      )}
      {t.error === null ? null : <ErrorNotice error={t.error} />}
    </>
  );
}
