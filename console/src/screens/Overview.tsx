// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

import { type ReactNode } from 'react';

import { useApp } from '../app/context';
import { useAction, useResource, type Resource } from '../app/hooks';
import { useSession } from '../app/session';
import { useV1 } from '../app/switch';
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
import { FaucetOffline, TopUpResult, useTopUp } from '../components/TopUp';
import {
  Amount,
  BrandIcon,
  ErrorNotice,
  Icon,
  Skeleton,
  SoonRow,
  Spinner,
  type BrandIconName,
} from '../components/ui';
import { addMinor, compareMinor, formatAmount } from '../lib/money';
import type { Account } from '../lib/schemas';
import { signAndSubmit } from '../lib/sign';
import type { Wallet } from '../lib/wallet';
import { OverviewV1 } from './OverviewV1';

const STEPS: readonly { icon: BrandIconName; title: string; text: string }[] = [
  { icon: 'mandate', title: 'You set the rules', text: 'Budget, caps, recipients, end date.' },
  { icon: 'agent', title: 'The agent asks', text: 'One payout request per task.' },
  { icon: 'rail', title: 'The contract decides', text: 'Every rule checked on Stellar.' },
  { icon: 'approval', title: 'A person approves big payouts', text: 'Above your limit, you sign.' },
  { icon: 'receipt', title: 'Every payment gets a receipt', text: 'Task, amount, transaction.' },
];

export function HowItWorks() {
  return (
    <section className="card how" aria-labelledby="how-title">
      <h2 id="how-title" className="card-title">
        How UJIRA works
      </h2>
      <ol className="how-steps">
        {STEPS.map((s) => (
          <li key={s.title}>
            <span className="tile">
              <BrandIcon name={s.icon} size={22} />
            </span>
            <span>
              <h3>{s.title}</h3>
              <p className="muted small">{s.text}</p>
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}

function ComingNext() {
  return (
    <SoonRow
      title="Coming next"
      items={['Local currency payouts', 'Bank funding', 'Passkey approvers']}
    />
  );
}

function Welcome() {
  return (
    <section className="welcome" aria-labelledby="hero-title">
      <div className="welcome-copy">
        <p className="eyebrow">Non-custodial payouts</p>
        <h2 id="hero-title">
          Pay people from a mandate <span className="grad">you own.</span>
        </h2>
        <p className="lede">Set the rules once. The contract on Stellar enforces them.</p>
      </div>
      <div className="connect">
        <h3 className="card-title">Connect a wallet</h3>
        <WalletChoices />
        <p className="assure">
          <Icon name="lock" size={16} />
          Your keys stay in your wallet.
        </p>
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
        {props.state === 'done' ? <Icon name="check" size={16} /> : props.n}
      </span>
      <div className="setup-body">
        <h3>
          {props.title}
          <span className="sr-only">{props.state === 'done' ? ' (done)' : ' (to do)'}</span>
        </h3>
        <p className="muted small">{props.detail ?? props.text}</p>
      </div>
      {showAction && props.action !== undefined ? (
        <button
          type="button"
          className={props.state === 'next' ? 'btn btn-primary btn-small' : 'btn btn-small'}
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

/** "10000.5000000" as "10,000.5": thousands grouped, no trailing zeros. */
function xlmText(xlm: string): string {
  const [whole = '0', fraction = ''] = xlm.split('.');
  const shown = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const rest = fraction.replace(/0+$/, '');
  return rest === '' ? shown : `${shown}.${rest}`;
}

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
        {s.ready ? <span className="pill pill-paid">All set</span> : null}
      </div>
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
            text="Pays network fees."
            detail={a?.xlm === null || a?.xlm === undefined ? undefined : `${xlmText(a.xlm)} XLM`}
            action={{ label: 'Get test XLM', busy: xlm.busy, onClick: () => void xlm.run() }}
          />
          <SetupStep
            n={2}
            state={s.trust}
            title="Let your wallet hold USDC"
            text="One signature."
            action={{ label: 'Add USDC', busy: trust.busy, onClick: () => void trust.run() }}
          />
          <SetupStep
            n={3}
            state={s.usdc}
            title="Get test USDC"
            text={topUp.enabled ? topUp.hint : <FaucetOffline />}
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
      {topUp.cooling ? (
        <p className="muted small" role="status">
          {topUp.hint}
        </p>
      ) : null}
      {error === null ? null : <ErrorNotice error={error} />}
      <TopUpResult t={topUp} />
    </section>
  );
}

function Figure({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/** The figure a person looks for first: what they hold, and the two main actions. */
function Balance({
  wallet,
  account,
  bundles,
  canTopUp,
}: {
  wallet: Wallet;
  account: Resource<Account>;
  bundles: readonly MandateBundle[] | undefined;
  canTopUp: boolean;
}) {
  const topUp = useTopUp(wallet, account.reload);
  const a = account.data;
  const held = bundles === undefined ? undefined : heldTotal(bundles);
  const inWallet = a === undefined ? undefined : (a.usdc ?? '0');
  const total = held === undefined || inWallet === undefined ? undefined : addMinor(held, inWallet);
  const checking = <span className="muted">...</span>;
  return (
    <section className="balance" aria-labelledby="balance-title">
      <div className="balance-top">
        <h2 id="balance-title" className="balance-label">
          Total balance
        </h2>
        <span className="assure">
          <Icon name="lock" size={15} />
          Non-custodial. Your wallet signs.
        </span>
      </div>
      <p className="balance-value">
        {total === undefined ? (
          <>
            <span className="skeleton-line balance-skeleton" aria-hidden="true" />
            <span className="sr-only">Checking</span>
          </>
        ) : (
          <Amount minor={total} size="xl" />
        )}
      </p>
      <dl className="balance-split">
        <Figure label="In mandates">
          {held === undefined ? checking : <Amount minor={held} />}
        </Figure>
        <Figure label="In wallet">
          {a === undefined ? checking : a.usdc === null ? 'Not added' : <Amount minor={a.usdc} />}
        </Figure>
        <Figure label="Test XLM">
          {a === undefined ? (
            checking
          ) : a.xlm === null ? (
            'Not funded'
          ) : (
            <span className="amount">{xlmText(a.xlm)}</span>
          )}
        </Figure>
      </dl>
      <div className="balance-actions">
        <Link to="/mandates/new" className="btn btn-primary">
          <Icon name="plus" size={18} />
          Create a mandate
        </Link>
        {canTopUp ? (
          <button
            type="button"
            className="btn"
            disabled={!topUp.enabled || topUp.busy}
            onClick={topUp.run}
            title={topUp.label}
          >
            {topUp.busy ? <Spinner /> : null}
            Top up
          </button>
        ) : null}
      </div>
      {canTopUp ? (
        <div className="balance-note">
          {topUp.cooling ? (
            <p className="small" role="status">
              {topUp.hint}
            </p>
          ) : null}
          <TopUpResult t={topUp} />
        </div>
      ) : null}
    </section>
  );
}

function WaitingStrip({ n }: { n: number }) {
  if (n === 0) return null;
  return (
    <Link to="/approvals" className="strip">
      <span className="strip-dot" aria-hidden="true" />
      <strong>{n === 1 ? '1 payout waiting' : `${String(n)} payouts waiting`}</strong>
      <span className="muted">for your approval</span>
      <Icon name="arrow" size={18} />
    </Link>
  );
}

export function Overview() {
  const v1 = useV1('overview');
  const session = useSession();
  if (v1 !== null && session !== null) {
    return <OverviewV1 key={session.project.id} v1={v1} projectId={session.project.id} />;
  }
  return <OverviewOnApi />;
}

function OverviewOnApi() {
  const { api, wallet } = useApp();
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
  const receipts = bundles === undefined ? undefined : allReceipts(bundles).slice(0, 6);
  const waiting = bundles === undefined ? 0 : waitingPayouts(bundles).length;

  if (!hasMandates) {
    return (
      <div className="stack">
        <Balance wallet={wallet} account={account} bundles={bundles} canTopUp={false} />
        <div className="grid-2">
          <SetupChecklist wallet={wallet} account={account} />
          <HowItWorks />
        </div>
        <ComingNext />
      </div>
    );
  }

  return (
    <div className="stack">
      <div className="grid-main">
        <Balance wallet={wallet} account={account} bundles={bundles} canTopUp />
        <section className="card" aria-labelledby="mine-title">
          <div className="card-head">
            <h2 id="mine-title" className="card-title">
              Your mandates
            </h2>
            <Link to="/mandates" className="card-link">
              See all
            </Link>
          </div>
          <MandateList portfolio={portfolio} limit={3} compact />
        </section>
      </div>
      <WaitingStrip n={waiting} />
      <ReceiptsTable
        title="Recent payouts"
        rows={receipts}
        loading={portfolio?.loading ?? false}
        error={portfolio?.error ?? null}
        onRetry={portfolio?.reload ?? (() => undefined)}
        showMandate
        empty="No payouts yet."
        more={
          <Link to="/receipts" className="card-link">
            See all
          </Link>
        }
      />
      <ComingNext />
    </div>
  );
}
