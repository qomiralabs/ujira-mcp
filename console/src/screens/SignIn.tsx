// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The screens before the dashboard: sign in with a wallet, name the
// organisation on a first visit, and the states in between.

import { useEffect, useRef, useState, type SyntheticEvent, type ReactNode } from 'react';

import { useApp } from '../app/context';
import { useAction } from '../app/hooks';
import { ThemeToggle } from '../components/ThemeToggle';
import { ErrorNotice, Field, Icon, Logo, Notice, Spinner } from '../components/ui';
import { errorMessage } from '../lib/api';
import { checkName, type AuthApi, type SessionInfo } from '../lib/auth';
import { WALLET_NAMES, connectWallet, type Wallet, type WalletKind } from '../lib/wallet';

/**
 * The page around every signed out screen: the logo, the network and the
 * theme, then one heading that takes focus when the screen changes.
 */
export function AuthFrame({
  title,
  lede,
  focusKey,
  children,
}: {
  title: string;
  lede?: string;
  /** A new value moves focus to the heading, so a screen reader hears the change. */
  focusKey: string;
  children: ReactNode;
}) {
  const { mock } = useApp();
  const heading = useRef<HTMLHeadingElement>(null);
  const first = useRef(true);
  useEffect(() => {
    document.title = `${title} | UJIRA`;
  }, [title]);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    heading.current?.focus();
  }, [focusKey]);
  return (
    <div className="auth">
      <header className="auth-top">
        <a href="/" className="logo" aria-label="UJIRA home page">
          <Logo />
        </a>
        <span className="top-status">
          <span className="net" title="Stellar testnet. Test money only.">
            <span className="net-dot" aria-hidden="true" />
            Testnet
          </span>
          {mock ? (
            <span className="net net-mock" title="Mock mode: nothing here touches the network.">
              Mock
            </span>
          ) : null}
          <ThemeToggle />
        </span>
      </header>
      <main id="main" className="auth-main">
        <section className="welcome auth-card" aria-labelledby="auth-title">
          <div className="welcome-copy">
            <p className="eyebrow">Non-custodial payouts</p>
            <h1 id="auth-title" ref={heading} tabIndex={-1}>
              {title}
            </h1>
            {lede === undefined ? null : <p className="lede">{lede}</p>}
          </div>
          <div className="connect">{children}</div>
        </section>
      </main>
    </div>
  );
}

type Step = 'connect' | 'challenge' | 'sign' | 'session';

const STEPS: readonly { readonly at: readonly Step[]; readonly label: string }[] = [
  { at: ['connect'], label: 'Connect your wallet' },
  { at: ['challenge', 'sign'], label: 'Sign the message' },
  { at: ['session'], label: 'Start your session' },
];

const ORDER: readonly Step[] = ['connect', 'challenge', 'sign', 'session'];

function nowText(step: Step, wallet: string): string {
  switch (step) {
    case 'connect':
      return `Waiting for ${wallet}`;
    case 'challenge':
      return 'Preparing the message';
    case 'sign':
      return `Sign in ${wallet}`;
    case 'session':
      return 'Signing you in';
  }
}

type StepMark = 'done' | 'now' | 'failed' | 'later';

const MARK_WORDS: Record<StepMark, string> = {
  done: 'done',
  now: 'in progress',
  failed: 'stopped',
  later: 'to do',
};

/** Where the sign in is: each step with a mark and a word, never colour alone. */
function SignInSteps({
  current,
  failedAt,
  wallet,
}: {
  current: Step | null;
  failedAt: Step | null;
  wallet: string;
}) {
  const at = current ?? failedAt;
  const reached = at === null ? -1 : ORDER.indexOf(at);
  return (
    <ol className="signin-steps" aria-label="Sign in steps">
      {STEPS.map((s, i) => {
        const first = ORDER.indexOf(s.at[0] ?? 'connect');
        const last = ORDER.indexOf(s.at[s.at.length - 1] ?? 'connect');
        const mark: StepMark =
          reached > last
            ? 'done'
            : reached >= first
              ? failedAt !== null
                ? 'failed'
                : 'now'
              : 'later';
        return (
          <li key={s.label} className={`signin-step step-${mark}`}>
            <span className="signin-mark" aria-hidden="true">
              {mark === 'done' ? (
                <Icon name="check" size={14} />
              ) : mark === 'failed' ? (
                <Icon name="close" size={14} />
              ) : mark === 'now' ? (
                <Spinner />
              ) : (
                i + 1
              )}
            </span>
            <span>
              {mark === 'now' && current !== null ? nowText(current, wallet) : s.label}
              <span className="sr-only"> ({MARK_WORDS[mark]})</span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}

const CHOICES: readonly { kind: WalletKind; text: string }[] = [
  { kind: 'freighter', text: 'Extension, set to Testnet' },
  { kind: 'albedo', text: 'Nothing to install' },
];

/**
 * Connect a wallet, sign a one time message, start a session. The signature
 * goes straight to the server and is never kept.
 */
export function SignInScreen({
  auth,
  notice,
  onSignedIn,
}: {
  auth: AuthApi;
  notice: string | null;
  onSignedIn: (info: SessionInfo, wallet: Wallet) => void;
}) {
  const { config, mock } = useApp();
  const [kind, setKind] = useState<WalletKind | null>(null);
  const [step, setStep] = useState<Step | null>(null);
  const [failedAt, setFailedAt] = useState<Step | null>(null);
  const [error, setError] = useState<string | null>(null);
  const busy = step !== null;

  const run = async (chosen: WalletKind) => {
    if (busy) return;
    setKind(chosen);
    setError(null);
    setFailedAt(null);
    let at: Step = 'connect';
    setStep(at);
    try {
      const wallet = await connectWallet(chosen, config.networkPassphrase);
      at = 'challenge';
      setStep(at);
      const challenge = await auth.challenge(wallet.address);
      at = 'sign';
      setStep(at);
      const signature = await wallet.signMessage(challenge.message);
      at = 'session';
      setStep(at);
      const info = await auth.startSession({
        challengeId: challenge.challengeId,
        address: wallet.address,
        signature,
      });
      setStep(null);
      onSignedIn(info, wallet);
    } catch (e) {
      setFailedAt(at);
      setError(errorMessage(e));
      setStep(null);
    }
  };

  const choices = mock
    ? [{ kind: 'mock' as const, text: 'Mock mode, nothing is sent' }, ...CHOICES]
    : CHOICES;

  return (
    <AuthFrame
      title="Sign in with your wallet"
      lede="One signature proves the wallet is yours. Nothing is sent and nothing is paid."
      focusKey="signed-out"
    >
      {notice === null ? null : <Notice tone="info">{notice}</Notice>}
      <div className="wallet-options">
        {choices.map((c, i) => (
          <button
            key={c.kind}
            type="button"
            className={`wallet-option${i === 0 ? ' wallet-option-primary' : ''}`}
            onClick={() => void run(c.kind)}
            disabled={busy}
          >
            <span>
              <strong>
                {busy && kind === c.kind
                  ? `Signing in with ${WALLET_NAMES[c.kind]}`
                  : `Continue with ${WALLET_NAMES[c.kind]}`}
              </strong>
              <span className="muted small">{c.text}</span>
            </span>
            {busy && kind === c.kind ? <Spinner /> : <Icon name="arrow" size={18} />}
          </button>
        ))}
      </div>
      {kind === null ? null : (
        <SignInSteps current={step} failedAt={failedAt} wallet={WALLET_NAMES[kind]} />
      )}
      {error === null || kind === null ? null : (
        <ErrorNotice error={error} onRetry={() => void run(kind)} />
      )}
      <p className="assure">
        <Icon name="lock" size={16} />
        Your keys stay in your wallet.
      </p>
    </AuthFrame>
  );
}

/** A one field form with its own busy and error states. */
function NameForm({
  label,
  placeholder,
  autoComplete,
  submit,
  busyLabel,
  what,
  onSubmit,
}: {
  label: string;
  placeholder: string;
  autoComplete?: string;
  submit: string;
  busyLabel: string;
  what: string;
  onSubmit: (name: string) => Promise<void>;
}) {
  const [value, setValue] = useState('');
  const [invalid, setInvalid] = useState<string | undefined>(undefined);
  const action = useAction(async (name: string) => {
    await onSubmit(name);
  });
  const send = (e: SyntheticEvent) => {
    e.preventDefault();
    const checked = checkName(value, what);
    if (!checked.ok) {
      setInvalid(checked.error);
      return;
    }
    setInvalid(undefined);
    void action.run(checked.name);
  };
  return (
    <form className="name-form" onSubmit={send} noValidate>
      <Field
        label={label}
        value={value}
        onChange={(v) => {
          setValue(v);
          if (invalid !== undefined) setInvalid(undefined);
        }}
        placeholder={placeholder}
        error={invalid}
        {...(autoComplete === undefined ? {} : { autoComplete })}
      />
      {action.error === null ? null : <ErrorNotice error={action.error} />}
      <button type="submit" className="btn btn-primary" disabled={action.busy}>
        {action.busy ? <Spinner /> : null}
        {action.busy ? busyLabel : submit}
      </button>
    </form>
  );
}

function SignOutLink({ onSignOut }: { onSignOut: () => Promise<void> }) {
  const action = useAction(onSignOut);
  return (
    <div className="auth-out">
      <button
        type="button"
        className="btn btn-ghost btn-small"
        onClick={() => void action.run()}
        disabled={action.busy}
      >
        {action.busy ? <Spinner /> : <Icon name="power" size={16} />}
        {action.busy ? 'Signing out' : 'Use another wallet'}
      </button>
      {action.error === null ? null : <p className="error-text">{action.error}</p>}
    </div>
  );
}

/** The first sign in: the wallet has no organisation yet, so it names one. */
export function NameOrganisation({
  onCreate,
  onSignOut,
}: {
  onCreate: (name: string) => Promise<void>;
  onSignOut: () => Promise<void>;
}) {
  return (
    <AuthFrame
      title="Name your organisation"
      lede="It holds your projects, mandates and receipts. We set up your first project with it."
      focusKey="naming"
    >
      <NameForm
        label="Organisation name"
        placeholder="Acme Ltd"
        autoComplete="organization"
        submit="Create organisation"
        busyLabel="Creating"
        what="your organisation name"
        onSubmit={onCreate}
      />
      <SignOutLink onSignOut={onSignOut} />
    </AuthFrame>
  );
}

/** Signed in, with an organisation but no project: one to make, and nothing else. */
export function FirstProject({
  principalName,
  onCreate,
  onSignOut,
}: {
  principalName: string;
  onCreate: (name: string) => Promise<void>;
  onSignOut: () => Promise<void>;
}) {
  return (
    <AuthFrame
      title="Create a project"
      lede={`${principalName} has no projects yet.`}
      focusKey="no-projects"
    >
      <NameForm
        label="Project name"
        placeholder="Payouts"
        submit="Create project"
        busyLabel="Creating"
        what="a project name"
        onSubmit={onCreate}
      />
      <SignOutLink onSignOut={onSignOut} />
    </AuthFrame>
  );
}

/** A step that failed for a reason other than a lost session, with a way on. */
export function SessionProblem({
  title,
  error,
  onRetry,
  onSignOut,
  focusKey,
}: {
  title: string;
  error: string;
  onRetry: () => void;
  onSignOut?: () => Promise<void>;
  focusKey: string;
}) {
  return (
    <AuthFrame title={title} focusKey={focusKey}>
      <ErrorNotice error={error} onRetry={onRetry} />
      {onSignOut === undefined ? null : <SignOutLink onSignOut={onSignOut} />}
    </AuthFrame>
  );
}
