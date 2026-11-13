// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

import { useEffect, useRef, useState } from 'react';

import { useApp } from '../app/context';
import { errorMessage } from '../lib/api';
import type { UnsignedTx } from '../lib/schemas';
import { TxFailedError, signAndSubmit } from '../lib/sign';
import { WALLET_NAMES } from '../lib/wallet';
import { ErrorNotice, Notice, Spinner, TxLink } from './ui';

export interface SigningStep {
  readonly title: string;
  /** What signing this step does, in plain words, shown before the wallet opens. */
  readonly why: string;
}

type Phase = 'building' | 'ready' | 'signing' | 'error';

interface Context {
  readonly mandate?: string;
}

export function SigningSteps({
  steps,
  run,
  onBack,
}: {
  steps: readonly SigningStep[];
  /** Builds the unsigned transaction for a step. */
  run: (index: number, ctx: Context) => Promise<UnsignedTx>;
  onBack: () => void;
}) {
  const { api, config, wallet, notify } = useApp();
  const [index, setIndex] = useState(0);
  const [phase, setPhase] = useState<Phase>('building');
  const [tx, setTx] = useState<UnsignedTx | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [failedHash, setFailedHash] = useState<string | null>(null);
  const [hashes, setHashes] = useState<string[]>([]);
  const [ctx, setCtx] = useState<Context>({});
  const [attempt, setAttempt] = useState(0);
  const runRef = useRef(run);
  useEffect(() => {
    runRef.current = run;
  });
  const done = index >= steps.length;

  useEffect(() => {
    if (done) return;
    let live = true;
    runRef.current(index, ctx).then(
      (built) => {
        if (!live) return;
        setTx(built);
        setPhase('ready');
      },
      (e: unknown) => {
        if (!live) return;
        setError(errorMessage(e));
        setPhase('error');
      },
    );
    return () => {
      live = false;
    };
    // The context only changes together with the index.
  }, [index, attempt, done]);

  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, [index]);

  if (wallet === null) return null;

  const sign = async () => {
    if (tx === null) return;
    setError(null);
    setFailedHash(null);
    setPhase('signing');
    try {
      const result = await signAndSubmit(api, config, wallet, tx);
      setHashes((h) => [...h, result.hash]);
      if (typeof result.mandate === 'string' && result.mandate !== '') {
        setCtx({ mandate: result.mandate });
      }
      notify(`Step ${index + 1} of ${steps.length} is done.`);
      setTx(null);
      setPhase('building');
      setIndex((i) => i + 1);
    } catch (e) {
      if (e instanceof TxFailedError) setFailedHash(e.hash);
      setError(errorMessage(e));
      setPhase('error');
    }
  };

  const retry = () => {
    setError(null);
    setFailedHash(null);
    setTx(null);
    setPhase('building');
    setAttempt((a) => a + 1);
  };

  return (
    <section className="card signing" aria-labelledby="signing-title">
      <h2 id="signing-title" className="card-title" tabIndex={-1} ref={heading}>
        {done ? 'Your mandate is live' : `Sign step ${index + 1} of ${steps.length}`}
      </h2>
      <ol className="sign-steps">
        {steps.map((s, i) => {
          const state = i < index ? 'done' : i === index ? 'current' : 'later';
          const hash = hashes[i];
          return (
            <li
              key={s.title}
              className={`sign-step sign-${state}`}
              aria-current={state === 'current' ? 'step' : undefined}
            >
              <span className="setup-n" aria-hidden="true">
                {state === 'done' ? (
                  <svg width="16" height="16" viewBox="0 0 16 16">
                    <path d="M4 8.5 6.8 11.3 12 5.5" />
                  </svg>
                ) : (
                  i + 1
                )}
              </span>
              <div className="setup-body">
                <h3>
                  {s.title}
                  <span className="sr-only">
                    {state === 'done' ? ' (done)' : state === 'current' ? ' (now)' : ' (next)'}
                  </span>
                </h3>
                {state === 'current' ? <p>{s.why}</p> : null}
                {hash === undefined ? null : (
                  <p className="small">
                    Settled on Stellar: <TxLink hash={hash} />
                  </p>
                )}
                {state === 'current' && phase === 'building' ? (
                  <p className="muted small" role="status">
                    <Spinner /> Preparing the transaction
                  </p>
                ) : null}
                {state === 'current' && phase === 'ready' && tx !== null ? (
                  <div className="sign-ready">
                    {tx.description === undefined ? null : (
                      <p className="muted small">Your wallet will show: {tx.description}</p>
                    )}
                    <button type="button" className="btn btn-primary" onClick={() => void sign()}>
                      Sign in {WALLET_NAMES[wallet.kind]}
                    </button>
                  </div>
                ) : null}
                {state === 'current' && phase === 'signing' ? (
                  <p className="muted small" role="status">
                    <Spinner /> Waiting for your wallet, then for Stellar to settle it. This takes a
                    few seconds.
                  </p>
                ) : null}
              </div>
            </li>
          );
        })}
      </ol>
      {phase === 'error' && error !== null ? (
        <div className="stack-sm">
          <ErrorNotice error={error} onRetry={retry} />
          {failedHash === null ? null : (
            <p className="small">
              The refused transaction: <TxLink hash={failedHash} />
            </p>
          )}
        </div>
      ) : null}
      {done ? (
        <div className="stack-sm">
          <Notice tone="paid" title="Created, allowed and funded">
            <p>
              Your rules are now on chain. Next, act as the agent and ask for a payout, or connect
              Claude to it.
            </p>
          </Notice>
          <div className="actions">
            {ctx.mandate === undefined ? (
              <a className="btn btn-primary" href="#/">
                See your mandates
              </a>
            ) : (
              <a className="btn btn-primary" href={`#/m/${ctx.mandate}`}>
                Open your mandate
              </a>
            )}
          </div>
        </div>
      ) : index === 0 && phase !== 'signing' ? (
        <div className="actions">
          <button type="button" className="btn btn-ghost" onClick={onBack}>
            Change the rules
          </button>
        </div>
      ) : null}
    </section>
  );
}
