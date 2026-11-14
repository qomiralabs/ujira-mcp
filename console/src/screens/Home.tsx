// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

import { useState, type ReactNode } from 'react';

import { useApp } from '../app/context';
import { useAction, useResource } from '../app/hooks';
import { FaucetOffline, TopUpResult, useTopUp } from '../components/TopUp';
import {
  BrandIcon,
  ErrorNotice,
  Notice,
  Skeleton,
  SoonTag,
  Spinner,
  type BrandIconName,
} from '../components/ui';
import { compareMinor, formatAmount } from '../lib/money';
import type { Account } from '../lib/schemas';
import { signAndSubmit } from '../lib/sign';
import { shortAddress } from '../lib/strkey';
import {
  MOCK_WALLET,
  connectAlbedo,
  connectFreighter,
  mockWallet,
  rememberWallet,
  type Wallet,
  type WalletKind,
} from '../lib/wallet';

const STEPS: readonly { icon: BrandIconName; title: string; text: string }[] = [
  {
    icon: 'mandate',
    title: 'You set the rules',
    text: 'A total budget, a limit per payment and per person per day, who can be paid, and an end date.',
  },
  {
    icon: 'agent',
    title: 'The agent asks',
    text: 'Your AI agent asks the mandate to pay someone for a task. It never holds your money.',
  },
  {
    icon: 'rail',
    title: 'The contract decides',
    text: 'The mandate on Stellar checks every rule. If one fails, nothing is paid and you see why.',
  },
  {
    icon: 'approval',
    title: 'A person approves big payouts',
    text: 'Anything at or above your approval amount waits until you approve it from your wallet.',
  },
  {
    icon: 'receipt',
    title: 'Every payment gets a receipt',
    text: 'Task, recipient, amount and the Stellar transaction, so anyone can check it.',
  },
];

export function HowItWorks() {
  return (
    <section className="how" aria-labelledby="how-title">
      <h2 id="how-title" className="section-title">
        How UJIRA works
      </h2>
      <ol className="how-steps">
        {STEPS.map((s, i) => (
          <li key={s.title}>
            <span className="how-icon">
              <BrandIcon name={s.icon} size={22} />
            </span>
            <span className="how-n label">{String(i + 1).padStart(2, '0')}</span>
            <h3>{s.title}</h3>
            <p>{s.text}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}

function ComingNext() {
  return (
    <section className="card" aria-labelledby="soon-title">
      <h2 id="soon-title" className="card-title">
        Coming next
      </h2>
      <ul className="soon-list">
        <li>
          <BrandIcon name="local-currency" />
          <span>
            <strong>Local currency payouts</strong>
            <span className="muted">Bank, mobile money and cash through Stellar anchors.</span>
          </span>
          <SoonTag />
        </li>
        <li>
          <BrandIcon name="payout" />
          <span>
            <strong>Fund with a bank transfer</strong>
            <span className="muted">Top up a mandate from a bank account instead of USDC.</span>
          </span>
          <SoonTag />
        </li>
      </ul>
    </section>
  );
}

const WALLET_CHOICES: readonly { kind: WalletKind; name: string; text: string }[] = [
  {
    kind: 'freighter',
    name: 'Freighter',
    text: 'Browser extension. Switch it to Testnet before you connect.',
  },
  { kind: 'albedo', name: 'Albedo', text: 'Signs in a pop-up window. Nothing to install.' },
];

function ConnectPanel() {
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
    } finally {
      setPending(null);
    }
  });
  const choices = mock
    ? [
        {
          kind: 'mock' as const,
          name: 'Demo wallet',
          text: 'Mock mode only. Nothing is signed or sent.',
        },
        ...WALLET_CHOICES,
      ]
    : WALLET_CHOICES;
  return (
    <section className="hero" aria-labelledby="hero-title">
      <div className="hero-copy">
        <p className="label">UJIRA Console</p>
        <h1 id="hero-title">Let an agent pay people, inside rules you set.</h1>
        <p className="lead">
          Create a spending mandate on Stellar with your own wallet, fund it with test USDC, and
          watch an AI agent ask it for payouts. The contract decides, you approve the big ones, and
          every payment leaves a receipt.
        </p>
      </div>
      <div className="connect">
        <h2 className="card-title">Connect a wallet to start</h2>
        <p className="muted">
          Your keys stay in your wallet. You approve each step there, and nothing moves without your
          signature.
        </p>
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
                <strong>
                  {pending === c.kind ? `Waiting for ${c.name}` : `Connect ${c.name}`}
                </strong>
                <span className="muted">{c.text}</span>
              </span>
              {pending === c.kind ? <Spinner /> : <span aria-hidden="true">&rarr;</span>}
            </button>
          ))}
        </div>
        {connect.error === null ? null : <ErrorNotice error={connect.error} />}
      </div>
    </section>
  );
}

type StepState = 'done' | 'next' | 'later';

function SetupStep(props: {
  n: number;
  state: StepState;
  title: string;
  text: ReactNode;
  detail?: string | undefined;
  action?: { label: string; busy: boolean; onClick: () => void; disabled?: boolean } | undefined;
  /** The action stays usable once the step is done, like a top up. */
  repeatable?: boolean;
}) {
  const showAction = props.action !== undefined && (props.state !== 'done' || props.repeatable);
  const usable = props.state === 'next' || (props.state === 'done' && props.repeatable === true);
  return (
    <li className={`setup-step setup-${props.state}`}>
      <span className="setup-n" aria-hidden="true">
        {props.state === 'done' ? (
          <svg width="16" height="16" viewBox="0 0 16 16">
            <path d="M4 8.5 6.8 11.3 12 5.5" />
          </svg>
        ) : (
          props.n
        )}
      </span>
      <div className="setup-body">
        <h3>
          {props.title}
          <span className="sr-only">{props.state === 'done' ? ' (done)' : ' (to do)'}</span>
        </h3>
        <p className="muted">{props.text}</p>
        {props.detail === undefined ? null : <p className="setup-detail">{props.detail}</p>}
      </div>
      {showAction && props.action !== undefined ? (
        <button
          type="button"
          className={props.state === 'next' ? 'btn btn-primary' : 'btn'}
          disabled={!usable || props.action.busy || props.action.disabled === true}
          onClick={props.action.onClick}
        >
          {props.action.busy ? <Spinner /> : null}
          {props.action.label}
        </button>
      ) : null}
    </li>
  );
}

function setupStates(a: Account | undefined): {
  xlm: StepState;
  trust: StepState;
  usdc: StepState;
  ready: boolean;
} {
  const hasXlm = a?.exists === true;
  const hasTrust = hasXlm && a.usdc !== null;
  const hasUsdc = hasTrust && a.usdc !== null && compareMinor(a.usdc, '0') > 0;
  return {
    xlm: hasXlm ? 'done' : 'next',
    trust: hasTrust ? 'done' : hasXlm ? 'next' : 'later',
    usdc: hasUsdc ? 'done' : hasTrust ? 'next' : 'later',
    ready: hasUsdc,
  };
}

export function SetupChecklist({ wallet }: { wallet: Wallet }) {
  const { api, config, notify } = useApp();
  const account = useResource(`account:${wallet.address}`, () => api.account(wallet.address));
  const topUp = useTopUp(wallet, account.reload);
  const xlm = useAction(async () => {
    await api.onboardXlm(wallet.address);
    notify('Your wallet now has test XLM.');
    account.reload();
  });
  const trust = useAction(async () => {
    const tx = await api.trustline(wallet.address);
    await signAndSubmit(api, config, wallet, tx);
    notify('Your wallet can now hold USDC.');
    account.reload();
  });
  const a = account.data;
  const s = setupStates(a);
  const error = xlm.error ?? trust.error;

  return (
    <section className="card" aria-labelledby="setup-title">
      <div className="card-head">
        <h2 id="setup-title" className="card-title">
          Get your wallet ready
        </h2>
        {s.ready ? <span className="muted">All set</span> : null}
      </div>
      <p className="muted">
        Three quick steps. Come back to top up whenever you run low. Everything here is test money.
      </p>
      {account.loading ? (
        <Skeleton lines={3} label="Checking your wallet" />
      ) : account.error !== null && a === undefined ? (
        <ErrorNotice error={account.error} onRetry={account.reload} />
      ) : (
        <ol className="setup">
          <SetupStep
            n={1}
            state={s.xlm}
            title="Get test XLM"
            text="Pays the tiny network fees. It comes from Stellar's free test faucet."
            detail={
              a?.xlm === null || a?.xlm === undefined
                ? undefined
                : `${a.xlm.replace(/\.?0+$/, '')} XLM in your wallet`
            }
            action={{ label: 'Get test XLM', busy: xlm.busy, onClick: () => void xlm.run() }}
          />
          <SetupStep
            n={2}
            state={s.trust}
            title="Let your wallet hold USDC"
            text="Adds a USDC trustline. Your wallet asks you to sign one transaction."
            action={{ label: 'Add USDC', busy: trust.busy, onClick: () => void trust.run() }}
          />
          <SetupStep
            n={3}
            state={s.usdc}
            title="Get test USDC"
            text={
              topUp.enabled ? (
                `Our faucet tops your wallet up so you can fund a mandate. ${topUp.hint}`
              ) : (
                <FaucetOffline />
              )
            }
            detail={
              a?.usdc === null || a?.usdc === undefined
                ? undefined
                : `${formatAmount(a.usdc)} USDC in your wallet`
            }
            action={{
              label: topUp.label,
              busy: topUp.busy,
              onClick: topUp.run,
              disabled: !topUp.enabled,
            }}
            repeatable
          />
        </ol>
      )}
      {error === null ? null : <ErrorNotice error={error} />}
      <TopUpResult t={topUp} />
      <div className="actions">
        <a href="#/new" className={s.ready ? 'btn btn-primary' : 'btn'}>
          Create a mandate
        </a>
        {!s.ready && !account.loading ? (
          <span className="muted small">
            Finish the steps above first, or create one anyway if you already hold test USDC.
          </span>
        ) : null}
      </div>
    </section>
  );
}

export function MyMandates({ wallet }: { wallet: Wallet }) {
  const { api } = useApp();
  const list = useResource(`mandates:${wallet.address}`, () => api.mandates(wallet.address));
  return (
    <section className="card" aria-labelledby="mine-title">
      <h2 id="mine-title" className="card-title">
        Your mandates
      </h2>
      {list.loading ? (
        <Skeleton lines={2} label="Loading your mandates" />
      ) : list.error !== null && list.data === undefined ? (
        <ErrorNotice error={list.error} onRetry={list.reload} />
      ) : list.data === undefined || list.data.length === 0 ? (
        <p className="muted">
          None yet. A mandate is where your rules and your test USDC live; create one to watch an
          agent pay inside it.
        </p>
      ) : (
        <ul className="mandate-list">
          {list.data.map((m) => (
            <li key={m.id}>
              <a href={`#/m/${m.id}`} className="mandate-link">
                <BrandIcon name="mandate" />
                <span className="mono">{shortAddress(m.id, 6)}</span>
                <span className="muted small">
                  {m.createdAt === null || m.createdAt === undefined
                    ? ''
                    : `Created ${new Date(m.createdAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}`}
                </span>
                <span aria-hidden="true">&rarr;</span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function Home() {
  const { wallet } = useApp();
  if (wallet === null) {
    return (
      <div className="stack">
        <ConnectPanel />
        <HowItWorks />
        <ComingNext />
      </div>
    );
  }
  return (
    <div className="stack">
      <div className="page-head">
        <h1>Welcome. Here is your testnet desk.</h1>
        <p className="muted">
          Wallet <span className="mono">{shortAddress(wallet.address, 6)}</span> on Stellar testnet.
        </p>
      </div>
      <div className="grid-2">
        <SetupChecklist wallet={wallet} />
        <MyMandates wallet={wallet} />
      </div>
      <HowItWorks />
      <ComingNext />
      <Notice tone="info">
        <p>
          Prefer to drive it from an AI client? Every mandate has its own MCP address; open a
          mandate and look for Connect Claude.
        </p>
      </Notice>
    </div>
  );
}
