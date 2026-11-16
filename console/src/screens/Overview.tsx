// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

import { type ReactNode } from 'react';

import { explorerAccount, useApp } from '../app/context';
import { useAction, useResource, type Resource } from '../app/hooks';
import {
  allReceipts,
  heldTotal,
  usePortfolio,
  waitingPayouts,
  type MandateBundle,
} from '../app/portfolio';
import { WalletChoices } from '../components/Connect';
import { Link } from '../components/Link';
import { MandateList } from '../components/MandateList';
import { ReceiptsTable } from '../components/ReceiptsTable';
import { FaucetOffline, TopUpPanel, TopUpResult, useTopUp } from '../components/TopUp';
import {
  Amount,
  BrandIcon,
  ErrorNotice,
  Kpi,
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
import type { Wallet } from '../lib/wallet';

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
        <li>
          <BrandIcon name="approval" />
          <span>
            <strong>Several approvers with passkeys</strong>
            <span className="muted">
              Two of three people approve a big payout. No seed phrases.
            </span>
          </span>
          <SoonTag />
        </li>
      </ul>
    </section>
  );
}

function Welcome() {
  return (
    <section className="hero" aria-labelledby="hero-title">
      <div className="hero-copy">
        <p className="label">UJIRA dashboard</p>
        <h2 id="hero-title">Pay the people who do the work.</h2>
        <p className="lead">
          Create a spending mandate on Stellar with your own wallet, fund it with test USDC, and
          watch an AI agent ask it for payouts. The contract decides, you approve the big ones, and
          every payment leaves a receipt.
        </p>
      </div>
      <div className="connect">
        <h3 className="card-title">Connect a wallet to start</h3>
        <p className="muted">
          Your keys stay in your wallet. You approve each step there, and nothing moves without your
          signature.
        </p>
        <WalletChoices />
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

const xlmText = (xlm: string) => xlm.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');

function SetupChecklist({ wallet, account }: { wallet: Wallet; account: Resource<Account> }) {
  const { api, config, notify } = useApp();
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
                : `${xlmText(a.xlm)} XLM in your wallet`
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
        <Link to="/mandates/new" className={s.ready ? 'btn btn-primary' : 'btn'}>
          Create a mandate
        </Link>
        {!s.ready && !account.loading ? (
          <span className="muted small">
            Finish the steps above first, or create one anyway if you already hold test USDC.
          </span>
        ) : null}
      </div>
    </section>
  );
}

function WalletCard({ wallet, account }: { wallet: Wallet; account: Resource<Account> }) {
  return (
    <section className="card" aria-labelledby="wallet-title">
      <h2 id="wallet-title" className="card-title">
        Your wallet
      </h2>
      <p className="muted">
        Fees are paid in test XLM. Mandates are funded from the test USDC here.
      </p>
      <TopUpPanel
        wallet={wallet}
        intro="Running low? The faucet tops your wallet up with test USDC, then add funds to a mandate from its page."
        onDone={account.reload}
      />
    </section>
  );
}

function Figures({
  account,
  bundles,
}: {
  account: Resource<Account>;
  bundles: readonly MandateBundle[] | undefined;
}) {
  const a = account.data;
  const waiting = bundles === undefined ? undefined : waitingPayouts(bundles).length;
  const pending = <span className="muted">Checking</span>;
  return (
    <div className="kpis">
      <Kpi
        label="Test XLM"
        value={
          a === undefined ? (
            pending
          ) : a.xlm === null ? (
            'Not funded'
          ) : (
            <span className="amount">{xlmText(a.xlm)}</span>
          )
        }
        note="Pays the network fees"
      />
      <Kpi
        label="USDC in your wallet"
        value={
          a === undefined ? pending : a.usdc === null ? 'Not added' : <Amount minor={a.usdc} />
        }
        note="Moves into a mandate when you fund it"
      />
      <Kpi
        label="Held in your mandates"
        value={bundles === undefined ? pending : <Amount minor={heldTotal(bundles)} />}
        note={
          bundles === undefined
            ? ' '
            : bundles.length === 1
              ? 'Across 1 mandate'
              : `Across ${String(bundles.length)} mandates`
        }
      />
      <Kpi
        label="Waiting for you"
        value={waiting === undefined ? pending : <span className="amount">{waiting}</span>}
        note={waiting === 1 ? 'Payout to approve or pay' : 'Payouts to approve or pay'}
        action={
          waiting !== undefined && waiting > 0 ? (
            <Link to="/approvals" className="kpi-link">
              Review approvals
            </Link>
          ) : undefined
        }
      />
    </div>
  );
}

function greeting(): string {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning.' : h < 17 ? 'Good afternoon.' : 'Good evening.';
}

export function Overview() {
  const { api, config, wallet } = useApp();
  const address = wallet?.address ?? null;
  const account = useResource(address === null ? null : `account:${address}`, () =>
    api.account(address ?? ''),
  );
  const portfolio = usePortfolio();

  if (wallet === null) {
    return (
      <div className="stack">
        <Welcome />
        <HowItWorks />
        <ComingNext />
      </div>
    );
  }

  const bundles = portfolio?.data;
  const hasMandates = bundles !== undefined && bundles.length > 0;
  const receipts = bundles === undefined ? undefined : allReceipts(bundles).slice(0, 5);

  return (
    <div className="stack">
      <section className="greet" aria-labelledby="greet-title">
        <div>
          <h2 id="greet-title">
            {greeting()} <span className="greet-accent">Ready to pay.</span>
          </h2>
          <p className="muted">
            Wallet <span className="mono">{shortAddress(wallet.address, 6)}</span> on Stellar
            testnet.{' '}
            <a href={explorerAccount(config, wallet.address)} target="_blank" rel="noreferrer">
              See it on Stellar Expert<span className="sr-only"> (opens in a new tab)</span>
            </a>
          </p>
        </div>
        {hasMandates ? (
          <div className="actions">
            <Link to="/payouts" className="btn">
              Ask for a payout
            </Link>
            <Link to="/mandates/new" className="btn btn-primary">
              Create a mandate
            </Link>
          </div>
        ) : null}
      </section>
      <Figures account={account} bundles={bundles} />
      <div className="grid-2">
        {hasMandates ? (
          <WalletCard wallet={wallet} account={account} />
        ) : (
          <SetupChecklist wallet={wallet} account={account} />
        )}
        <section className="card" aria-labelledby="mine-title">
          <div className="card-head">
            <h2 id="mine-title" className="card-title">
              Your mandates
            </h2>
            {hasMandates ? (
              <Link to="/mandates" className="btn btn-ghost btn-small">
                See all
              </Link>
            ) : null}
          </div>
          <MandateList portfolio={portfolio} limit={4} compact />
        </section>
      </div>
      {hasMandates ? (
        <ReceiptsTable
          title="Latest receipts"
          rows={receipts}
          loading={portfolio?.loading ?? false}
          error={portfolio?.error ?? null}
          onRetry={portfolio?.reload ?? (() => undefined)}
          showMandate
        />
      ) : (
        <HowItWorks />
      )}
      <ComingNext />
      <Notice tone="info">
        <p>
          Prefer to drive it from an AI client? Every mandate has its own MCP address.{' '}
          <Link to="/developers">Connect Claude</Link> from the Developers page.
        </p>
      </Notice>
    </div>
  );
}
