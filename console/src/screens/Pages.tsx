// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The pages that look across every mandate the connected wallet owns.

import { useId, useState, type ReactNode } from 'react';

import { useApp } from '../app/context';
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
import { Amount, ComingSoon, ErrorNotice, Notice, Skeleton } from '../components/ui';
import { formatUsdc } from '../lib/money';
import type { Mandate, Receipt } from '../lib/schemas';
import { shortAddress } from '../lib/strkey';

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

function NoMandateYet() {
  return (
    <Notice tone="info" title="No mandate that can pay yet">
      <p>
        Payouts come from a mandate. <Link to="/mandates/new">Create a mandate</Link> with your
        rules and some test USDC, then come back here.
      </p>
    </Notice>
  );
}

function PortfolioProblems({ portfolio }: { portfolio: Portfolio }) {
  const broken = (portfolio.data ?? []).filter((b) => b.mandate === null);
  return (
    <>
      {portfolio.error !== null && portfolio.data !== undefined ? (
        <Notice tone="waiting">
          <p>Could not refresh just now: {portfolio.error} Showing the last known state.</p>
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
  return (
    <WithPortfolio what="your mandates">
      {(portfolio) => (
        <div className="stack">
          <div className="page-intro">
            <p className="lead">
              A mandate holds your test USDC and the rules an agent must follow to pay from it. Open
              one to act as the agent, approve, pause or revoke.
            </p>
            <Link to="/mandates/new" className="btn btn-primary">
              Create a mandate
            </Link>
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
    ['Left in the budget', <Amount key="left" minor={m.state.remaining} />],
    ['Max per payment', formatUsdc(m.rules.perPaymentCap)],
    ['Max per recipient per day', formatUsdc(m.rules.dailyCap)],
    ['Needs your approval from', formatUsdc(m.rules.approvalThreshold)],
    [
      'Held by UJIRA',
      <span key="held-by" className="plain">
        Nothing. The money stays in your mandate.
      </span>,
    ],
  ];
  return (
    <dl className="rules rules-compact">
      {rows.map(([k, v]) => (
        <div key={k}>
          <dt>{k}</dt>
          <dd className="mono">{v}</dd>
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
            <p className="lead">
              An agent asks for each payout and the mandate on Stellar checks it against your rules.
              Act as the agent here, or connect Claude to do it from a chat.
            </p>
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
                  <h2 id={`${chooserId}-title`} className="card-title">
                    Pay from
                  </h2>
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
                    <p>
                      Mandate <span className="mono">{shortAddress(m.id, 6)}</span>
                    </p>
                  )}
                  <RulesAtAGlance m={m} />
                  <Link to={`/mandates/${m.id}`} className="btn btn-ghost btn-small">
                    Open this mandate
                  </Link>
                </section>
                <AgentPanel key={m.id} m={m} onDone={portfolio.reload} />
              </div>
            )}
            <PayoutsTable
              rows={bundles === undefined ? undefined : allPayouts(bundles)}
              loading={portfolio.loading}
              error={portfolio.error}
              onRetry={portfolio.reload}
              empty="No payouts yet. Ask for one above and it shows here, paid, waiting or blocked."
            />
            <ComingSoon
              title="More ways to pay"
              lede="Today a payout is USDC to the recipient's Stellar wallet, or through the Stellar Disbursement Platform. Local money is next."
              items={[
                {
                  title: 'Bank and mobile money',
                  text: 'Paid out in local currency through Stellar anchors.',
                },
                { title: 'Cash pickup', text: 'Collected at an agent near the recipient.' },
                {
                  title: 'Split one payout',
                  text: 'Part to a wallet, part to a bank, as the recipient chooses.',
                },
              ]}
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
            <p className="lead">
              Payouts at or above a mandate&apos;s approval amount wait here. Approve or reject each
              one in your wallet; once approved, press Pay now and the mandate pays.
            </p>
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
                <p className="muted">
                  {bundles.length === 0
                    ? 'Create a mandate first. Payouts at or above its approval amount show up here.'
                    : 'Every payout so far was below the approval amount, or is already decided. New ones show up here.'}
                </p>
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
            <ComingSoon
              title="Approve as a team"
              lede="Any two of three people approve a big payout, each with a passkey. One is never enough."
              items={[
                {
                  title: 'Passkey approvers',
                  text: 'Approve with a fingerprint. No seed phrases.',
                },
                { title: 'Two of three', text: 'Set how many people must say yes.' },
                { title: 'Approve on your phone', text: 'A link that opens the payout to decide.' },
              ]}
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
          <p className="lead">
            Every request an agent makes leaves a receipt, paid or blocked: the task, who, how much,
            and the Stellar transaction when money moved.
          </p>
          <PortfolioProblems portfolio={portfolio} />
          <ReceiptsTable
            title="All receipts"
            rows={portfolio.data === undefined ? undefined : allReceipts(portfolio.data)}
            loading={portfolio.loading}
            error={portfolio.error}
            onRetry={portfolio.reload}
            showMandate
          />
          <ComingSoon
            title="Receipts you can hand on"
            lede="A receipt that you and the recipient can check without trusting UJIRA."
            items={[
              { title: 'Signed receipts', text: 'Verifiable offline against the Stellar ledger.' },
              { title: 'Export', text: 'A file for your accountants, by month or by mandate.' },
              { title: 'A page per receipt', text: 'A link to send the person who was paid.' },
            ]}
          />
        </div>
      )}
    </WithPortfolio>
  );
}
