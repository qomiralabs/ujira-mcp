// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// One wallet signature against /v1: the server prepares a signing request,
// the person signs it in their wallet, the server relays it to Stellar, and
// the screen reads the result back before it says done. Nothing on screen
// changes until the server shows the new state; until then the panel says
// what it is waiting for.

import { useCallback, useEffect, useRef, useState } from 'react';

import { useApp } from '../app/context';
import { errorMessage, errorRequestId } from '../lib/api';
import { shortAddress } from '../lib/strkey';
import type { V1Api } from '../lib/v1';
import { v1Network } from '../lib/mandateV1';
import type { SigningRequest, Submitted } from '../lib/v1Schemas';
import { WALLET_NAMES } from '../lib/wallet';
import { ErrorNotice, Spinner, TxLink } from './ui';

export type SignPhase =
  | { readonly kind: 'idle' }
  | { readonly kind: 'preparing' }
  | { readonly kind: 'ready'; readonly request: SigningRequest }
  | { readonly kind: 'signing'; readonly request: SigningRequest }
  | { readonly kind: 'confirming'; readonly request: SigningRequest }
  | { readonly kind: 'done'; readonly txHash: string; readonly caughtUp: boolean }
  | { readonly kind: 'error'; readonly error: string; readonly requestId: string | null };

export interface SignJob {
  readonly prepare: () => Promise<SigningRequest>;
  /** Reads the result back from the server; true once it shows the change. */
  readonly confirm: (submitted: Submitted) => Promise<boolean>;
  readonly onDone?: (submitted: Submitted, caughtUp: boolean) => void;
}

export interface Signing {
  readonly phase: SignPhase;
  /** True from the first request until done or an error. */
  readonly busy: boolean;
  start: (job: SignJob) => void;
  /** Opens the wallet. Called from a click, so a popup wallet is not blocked. */
  sign: () => void;
  /** Starts the last job again from a fresh signing request. */
  retry: () => void;
  reset: () => void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Reads until `ok` holds or the tries run out; true when it held. */
export async function readUntil<T>(
  read: () => Promise<T>,
  ok: (value: T) => boolean,
  { tries = 10, intervalMs = 2000 }: { tries?: number; intervalMs?: number } = {},
): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    if (i > 0) await sleep(intervalMs);
    if (ok(await read())) return true;
  }
  return false;
}

export function useV1Signing(v1: V1Api): Signing {
  const { config, wallet } = useApp();
  const [phase, setPhase] = useState<SignPhase>({ kind: 'idle' });
  const job = useRef<SignJob | null>(null);
  const request = useRef<SigningRequest | null>(null);
  const running = useRef(false);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  // What the panel shows now, for the callbacks that must not wait for a render.
  const shown = useRef<SignPhase['kind']>('idle');
  const set = useCallback((p: SignPhase) => {
    shown.current = p.kind;
    if (live.current) setPhase(p);
  }, []);

  const fail = useCallback(
    (e: unknown) => {
      running.current = false;
      request.current = null;
      set({ kind: 'error', error: errorMessage(e), requestId: errorRequestId(e) });
    },
    [set],
  );

  const start = useCallback(
    (next: SignJob) => {
      if (running.current) return;
      running.current = true;
      job.current = next;
      request.current = null;
      set({ kind: 'preparing' });
      next.prepare().then((r) => {
        request.current = r;
        set({ kind: 'ready', request: r });
      }, fail);
    },
    [fail, set],
  );

  const sign = useCallback(() => {
    const r = request.current;
    const current = job.current;
    if (r === null || current === null) return;
    request.current = null;
    const run = async () => {
      if (wallet === null) throw new Error('Connect your wallet to sign.');
      if (wallet.address !== r.signer) {
        throw new Error(
          `This needs the wallet ${shortAddress(r.signer)}. You are connected with ${shortAddress(wallet.address)}.`,
        );
      }
      if (r.network !== v1Network(config.network)) {
        throw new Error('This request is for another Stellar network. Start again.');
      }
      if (Date.parse(r.expiresAt) <= Date.now()) {
        throw new Error('The request ran out of time before it was signed. Start again.');
      }
      set({ kind: 'signing', request: r });
      const signed = await wallet.sign(r.xdr, {
        networkPassphrase: config.networkPassphrase,
        description: r.summary,
      });
      set({ kind: 'confirming', request: r });
      const submitted = await v1.submitSigned(r.id, signed);
      const caughtUp = await current.confirm(submitted);
      running.current = false;
      set({ kind: 'done', txHash: submitted.txHash, caughtUp });
      if (live.current) current.onDone?.(submitted, caughtUp);
    };
    run().catch(fail);
  }, [config.network, config.networkPassphrase, fail, set, v1, wallet]);

  const retry = useCallback(() => {
    const last = job.current;
    running.current = false;
    if (last !== null) start(last);
  }, [start]);

  // A request that waits for its signature can be dropped; one in flight cannot.
  const reset = useCallback(() => {
    const kind = shown.current;
    if (kind === 'preparing' || kind === 'signing' || kind === 'confirming') return;
    running.current = false;
    job.current = null;
    request.current = null;
    set({ kind: 'idle' });
  }, [set]);

  const busy = phase.kind !== 'idle' && phase.kind !== 'done' && phase.kind !== 'error';
  return { phase, busy, start, sign, retry, reset };
}

/** What the signature is waiting for, and the one button that moves it on. */
export function SignPanel({
  signing,
  done,
  showSignButton = true,
}: {
  signing: Signing;
  /** One line for when the server shows the change. */
  done: string;
  /** Off when a dialog's own button signs. */
  showSignButton?: boolean;
}) {
  const { wallet } = useApp();
  const { phase } = signing;
  const walletName = wallet === null ? 'your wallet' : WALLET_NAMES[wallet.kind];
  switch (phase.kind) {
    case 'idle':
      return null;
    case 'preparing':
      return (
        <p className="muted small" role="status">
          <Spinner /> Preparing the transaction
        </p>
      );
    case 'ready':
      return (
        <div className="sign-ready">
          <p className="muted small" role="status">
            Your wallet will show: {phase.request.summary}
          </p>
          {showSignButton ? (
            <button type="button" className="btn btn-primary" onClick={signing.sign}>
              Sign in {walletName}
            </button>
          ) : null}
        </div>
      );
    case 'signing':
      return (
        <p className="muted small" role="status">
          <Spinner /> Waiting for {walletName}
        </p>
      );
    case 'confirming':
      return (
        <p className="muted small" role="status">
          <Spinner /> Waiting for Stellar to confirm
        </p>
      );
    case 'done':
      return (
        <p className="small" role="status">
          {phase.caughtUp ? done : 'Stellar confirmed it. This page catches up in a moment.'}{' '}
          <TxLink hash={phase.txHash} />
        </p>
      );
    case 'error':
      return (
        <ErrorNotice error={phase.error} onRetry={signing.retry} requestId={phase.requestId} />
      );
  }
}

/** The label for a button that signs, by what the signature is doing now. */
export function signLabel(signing: Signing, idle: string, walletName: string): string {
  switch (signing.phase.kind) {
    case 'preparing':
      return 'Preparing';
    case 'ready':
      return `Sign in ${walletName}`;
    case 'signing':
      return `Waiting for ${walletName}`;
    case 'confirming':
      return 'Waiting for Stellar';
    default:
      return idle;
  }
}
