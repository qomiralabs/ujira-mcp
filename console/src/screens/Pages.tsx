// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The pages that look across every mandate the connected wallet owns.

import { useId, useState, type ReactNode } from 'react';

import { useApp } from '../app/context';
import { useSession } from '../app/session';
import { useV1 } from '../app/switch';
import {
  allPayouts,
  allReceipts,
  isWaiting,
  loaded,
  usable,
  usePortfolio,
  type Portfolio,
} from '../app/portfolio';
import { AgentPanel, RequestNotice } from '../components/AgentPanel';
import { Approvals } from '../components/Approvals';
import { ConnectPrompt } from '../components/Connect';
import { Link } from '../components/Link';
import { MandateList } from '../components/MandateList';
import { PayoutsTable, ReceiptsTable } from '../components/ReceiptsTable';
import { Amount, Empty, ErrorNotice, Icon, Notice, Skeleton, SoonRow } from '../components/ui';
import { formatUsdc } from '../lib/money';
import type { Mandate, Receipt } from '../lib/schemas';
import { shortAddress } from '../lib/strkey';
import { MandatesV1 } from './MandatesV1';

/** Shows the page once a wallet is connected, else asks for one. */
function WithPortfolio({
  what,
  children,
}: {
  what: string;
  children: (portfolio: Portfolio) => ReactNode;
}) {
  const { wallet } = useApp();
  const portfolio = usePortfolio();
  if (wallet === null || portfolio === null) {
    return (
      <div className="stack">
        <ConnectPrompt what={what} />
      </div>
    );
  }
  return <>{children(portfolio)}</>;
}

function CreateLink({ small = false }: { small?: boolean }) {
  return (
    <Link to="/mandates/new" className={small ? 'btn btn-primary btn-small' : 'btn btn-primary'}>
      <Icon name="plus" size={small ? 16 : 18} />
      Create a mandate
    </Link>
  );
}

function NoMandateYet() {
  return (
    <section className="card">
      <Empty text="No mandate can pay yet." action={<CreateLink small />} />
    </section>
  );
}

function PortfolioProblems({ portfolio }: { portfolio: Portfolio }) {
  const broken = (portfolio.data ?? []).filter((b) => b.mandate === null);
  return (
    <>
      {portfolio.error !== null && portfolio.data !== undefined ? (
        <Notice tone="waiting">
          <p>Could not refresh: {portfolio.error} Showing the last known state.</p>
        </Notice>
      ) : null}
      {broken.map((b) => (
        <Notice key={b.summary.id} tone="waiting">
          <p>
            Mandate <span className="mono">{shortAddress(b.summary.id, 6)}</span> could not be read:{' '}
            {b.error}
          </p>
        </Notice>
      ))}
    </>
  );
}

export function MandatesPage() {
  const v1 = useV1('mandates');
  const session = useSession();
  if (v1 !== null && session !== null) {
    return <MandatesV1 key={session.project.id} v1={v1} projectId={session.project.id} />;
  }
  return (
    <WithPortfolio what="your mandates">
      {(portfolio) => (
        <div className="stack">
          <div className="toolbar">
            <CreateLink />
          </div>
          <PortfolioProblems portfolio={portfolio} />
          <section className="card" aria-labelledby="mandates-title">
            <h2 id="mandates-title" className="card-title">
              Your mandates
            </h2>
            <MandateList portfolio={portfolio} />
          </section>
        </div>
      )}
    </WithPortfolio>
  );
}

function RulesAtAGlance({ m }: { m: Mandate }) {
  const rows: [string, ReactNode][] = [
    ['Held now', <Amount key="held" minor={m.state.balance} />],
    ['Left in budget', <Amount key="left" minor={m.state.remaining} />],
    ['Max per payment', formatUsdc(m.rules.perPaymentCap)],
    ['Daily cap per person', formatUsdc(m.rules.dailyCap)],
    ['Approval from', formatUsdc(m.rules.approvalThreshold)],
    ['Held by UJIRA', '0.00 USDC'],
  ];
  return (
    <dl className="rules">
      {rows.map(([k, v]) => (
        <div key={k}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export function PayoutsPage() {
  const chooserId = useId();
  const [chosen, setChosen] = useState<string | null>(null);
  return (
    <WithPortfolio what="your payouts">
      {(portfolio) => {
        const bundles = portfolio.data;
        const options = bundles === undefined ? [] : usable(bundles);
        const m = options.find((x) => x.id === chosen) ?? options[0];
        return (
          <div className="stack">
            <PortfolioProblems portfolio={portfolio} />
            {portfolio.loading ? (
              <Skeleton lines={4} label="Loading your mandates" />
            ) : m === undefined ? (
              bundles === undefined ? (
                <ErrorNotice error={portfolio.error ?? 'Not loaded.'} onRetry={portfolio.reload} />
              ) : (
                <NoMandateYet />
              )
            ) : (
              <div className="grid-2">
                <section className="card" aria-labelledby={`${chooserId}-title`}>
                  <div className="card-head">
                    <h2 id={`${chooserId}-title`} className="card-title">
                      Pay from
                    </h2>
                    <Link to={`/mandates/${m.id}`} className="card-link">
                      Open
                    </Link>
                  </div>
                  {options.length > 1 ? (
                    <div className="field">
                      <label htmlFor={chooserId}>Mandate</label>
                      <select
                        id={chooserId}
                        value={m.id}
                        onChange={(e) => {
                          setChosen(e.target.value);
                        }}
                      >
                        {options.map((o) => (
                          <option key={o.id} value={o.id}>
                            {shortAddress(o.id, 6)}, holds {formatUsdc(o.state.balance)}
                          </option>
                        ))}
                      </select>
                    </div>
                  ) : (
                    <p className="mono">{shortAddress(m.id, 6)}</p>
                  )}
                  <RulesAtAGlance m={m} />
                </section>
                <AgentPanel key={m.id} m={m} onDone={portfolio.reload} />
              </div>
            )}
            <PayoutsTable
              rows={bundles === undefined ? undefined : allPayouts(bundles)}
              loading={portfolio.loading}
              error={portfolio.error}
              onRetry={portfolio.reload}
              empty="No payouts yet."
            />
            <SoonRow
              title="More ways to pay"
              items={['Bank and mobile money', 'Cash pickup', 'Split payouts']}
            />
          </div>
        );
      }}
    </WithPortfolio>
  );
}

export function ApprovalsPage() {
  const [lastPaid, setLastPaid] = useState<{ result: Receipt; label: string } | null>(null);
  return (
    <WithPortfolio what="what waits for your approval">
      {(portfolio) => {
        const bundles = portfolio.data;
        const groups =
          bundles === undefined
            ? []
            : loaded(bundles).filter(({ bundle }) => bundle.payouts.some(isWaiting));
        return (
          <div className="stack">
            <PortfolioProblems portfolio={portfolio} />
            {lastPaid === null ? null : (
              <RequestNotice result={lastPaid.result} label={lastPaid.label} />
            )}
            {portfolio.loading ? (
              <Skeleton lines={3} label="Loading approvals" />
            ) : bundles === undefined ? (
              <ErrorNotice error={portfolio.error ?? 'Not loaded.'} onRetry={portfolio.reload} />
            ) : groups.length === 0 ? (
              <section className="card" aria-labelledby="none-waiting">
                <h2 id="none-waiting" className="card-title">
                  Nothing waiting
                </h2>
                <Empty
                  text={
                    bundles.length === 0
                      ? 'Create a mandate first.'
                      : 'Payouts above your approval amount land here.'
                  }
                  action={bundles.length === 0 ? <CreateLink small /> : undefined}
                />
              </section>
            ) : (
              groups.map(({ mandate, bundle }) => (
                <Approvals
                  key={mandate.id}
                  m={mandate}
                  payouts={bundle.payouts}
                  loading={false}
                  error={null}
                  onRetry={portfolio.reload}
                  onDone={portfolio.reload}
                  onPaid={(result, label) => {
                    setLastPaid({ result, label });
                  }}
                  title={`Mandate ${shortAddress(mandate.id, 6)}`}
                />
              ))
            )}
            <SoonRow
              title="Approve as a team"
              items={['Passkey approvers', 'Two of three', 'Approve on your phone']}
            />
          </div>
        );
      }}
    </WithPortfolio>
  );
}

export function ReceiptsPage() {
  return (
    <WithPortfolio what="your receipts">
      {(portfolio) => (
        <div className="stack">
          <PortfolioProblems portfolio={portfolio} />
          <ReceiptsTable
            title="All receipts"
            rows={portfolio.data === undefined ? undefined : allReceipts(portfolio.data)}
            loading={portfolio.loading}
            error={portfolio.error}
            onRetry={portfolio.reload}
            showMandate
          />
          <SoonRow
            title="Receipts you can hand on"
            items={['Signed receipts', 'Export', 'A page per receipt']}
          />
        </div>
      )}
    </WithPortfolio>
  );
}
