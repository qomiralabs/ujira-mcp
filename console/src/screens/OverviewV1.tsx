// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The overview on /v1, the page an owner opens first: what the project's
// mandates hold, what the period paid, how its payouts stand and which rules
// blocked them, what waits for approval, and the latest payouts. Every figure
// is the server's own, from one overview answer, and appears only once the
// server has said it: nothing is guessed, carried forward or counted up.

import { useCallback, useMemo, type ReactNode } from 'react';

import { useApp } from '../app/context';
import { replaceSearch, useResource, useSearch, type Resource } from '../app/hooks';
import { Link } from '../components/Link';
import { PayoutSheet } from '../components/PayoutSheet';
import { when } from '../components/ReceiptsTable';
import {
  Amount,
  BrandIcon,
  Empty,
  ErrorNotice,
  Icon,
  Notice,
  Skeleton,
  SoonRow,
  SoonTag,
  StatusPill,
} from '../components/ui';
import { ApiError } from '../lib/api';
import { openOf, withOpen } from '../lib/approvalsV1';
import { mandateName, v1Network } from '../lib/mandateV1';
import {
  emptyHolding,
  firstSteps,
  holdings,
  isActiveKey,
  payoutCount,
  periodText,
  ruleRows,
  statusRows,
  type CountRow,
  type FirstSteps,
  type StepState,
  unreadCount,
} from '../lib/overviewV1';
import type { V1Api } from '../lib/v1';
import type { Overview, OverviewMandate, PayoutDetail } from '../lib/v1Schemas';
import { reasonText, statusWord, type Tone } from '../lib/words';

const POLL_MS = 15_000;
const RECENT = 6;
const SHOWN_MANDATES = 4;
const KEY_PAGE = 100;
const KEY_PAGES = 10;

function countText(n: number): string {
  return n.toLocaleString('en-US');
}

/**
 * Whether the project has a key the agent can use. Null when the member's
 * role cannot list keys, which makes that step someone else's.
 */
async function keyState(v1: V1Api): Promise<boolean | null> {
  try {
    let cursor: string | undefined;
    for (let page = 0; page < KEY_PAGES; page += 1) {
      const keys = await v1.apiKeys({ cursor, limit: KEY_PAGE });
      const now = Date.now();
      if (keys.items.some((k) => isActiveKey(k, now))) return true;
      if (keys.nextCursor === null) return false;
      cursor = keys.nextCursor;
    }
    return false;
  } catch (error) {
    if (error instanceof ApiError && error.code === 'FORBIDDEN') return null;
    throw error;
  }
}

function Checking() {
  return (
    <>
      <span className="skeleton-line figure-skeleton" aria-hidden="true" />
      <span className="sr-only">Checking</span>
    </>
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

/** What the project's mandates hold, all of them together, as the chain last said. */
function Balance({
  overview,
  primary,
}: {
  overview: Resource<Overview>;
  /** Whether creating a mandate is the one thing to do here; null hides the button. */
  primary: boolean | null;
}) {
  const { config } = useApp();
  const o = overview.data;
  const all = o === undefined ? undefined : holdings(o.mandates);
  const unread = o === undefined ? 0 : unreadCount(o.mandates);
  // Mandates exist but the chain answered for none: their money is unknown, not zero.
  const unknown = all !== undefined && all.length === 0 && unread > 0;
  const main =
    all === undefined || unknown
      ? undefined
      : (all[0] ??
        emptyHolding({
          asset: config.asset.code,
          network: v1Network(config.network),
          scale: config.asset.decimals,
        }));
  const failed = o === undefined && overview.error !== null;
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
      {failed ? (
        <ErrorNotice
          error={overview.error}
          onRetry={overview.reload}
          requestId={overview.errorRequestId}
        />
      ) : (
        <>
          <p className="balance-value">
            {unknown ? (
              <span className="balance-unknown">Not read</span>
            ) : main === undefined ? (
              <>
                <span className="skeleton-line balance-skeleton" aria-hidden="true" />
                <span className="sr-only">Checking</span>
              </>
            ) : (
              <Amount token={main.balance} size="xl" />
            )}
          </p>
          {all !== undefined && all.length > 1 ? (
            <ul className="balance-more" aria-label="Also held">
              {all.slice(1).map((h) => (
                <li key={`${h.balance.network} ${h.balance.asset} ${String(h.balance.scale)}`}>
                  <Amount token={h.balance} size="lg" />
                </li>
              ))}
            </ul>
          ) : null}
          <dl className="balance-split">
            <Figure label="Free to pay">
              {unknown ? (
                'Not read'
              ) : main === undefined ? (
                <Checking />
              ) : (
                <Amount token={main.free} />
              )}
            </Figure>
            <Figure label="Set aside for approval">
              {unknown ? (
                'Not read'
              ) : main === undefined ? (
                <Checking />
              ) : (
                <Amount token={main.committed} />
              )}
            </Figure>
          </dl>
          {unread === 0 ? null : (
            <p className="small balance-warn" role="status">
              {unread === 1
                ? 'Stellar did not answer for 1 mandate, so its money is not in these totals.'
                : `Stellar did not answer for ${countText(unread)} mandates, so their money is not in these totals.`}
            </p>
          )}
          {o?.moreMandates === true ? (
            <p className="muted small">
              The totals cover the first {countText(o.mandates.length)} mandates.
            </p>
          ) : null}
        </>
      )}
      {primary === null ? null : (
        <div className="balance-actions">
          <Link to="/mandates/new" className={primary ? 'btn btn-primary' : 'btn'}>
            <Icon name="plus" size={18} />
            Create a mandate
          </Link>
        </div>
      )}
    </section>
  );
}

function MandateLine({ m }: { m: OverviewMandate }) {
  return (
    <li>
      <Link to={`/mandates/${m.id}`} className="mandate-link">
        <span className="mandate-icon">
          <BrandIcon name="mandate" />
        </span>
        <span className="mandate-main">
          <strong className="mandate-name">{mandateName(m)}</strong>
          {m.state === null ? (
            <span className="muted small">Stellar did not answer</span>
          ) : (
            <span className="muted small">
              <Amount token={m.state.free} /> free
            </span>
          )}
        </span>
        <span className="mandate-money">
          {m.state === null ? (
            <span className="muted small">Not read</span>
          ) : (
            <>
              <Amount token={m.state.balance} />
              <span className="muted small">held</span>
            </>
          )}
        </span>
        <Icon name="arrow" size={18} />
      </Link>
    </li>
  );
}

/** Each mandate's balance, newest first, as many as fit beside the total. */
function MandateBalances({ overview }: { overview: Resource<Overview> }) {
  const o = overview.data;
  return (
    <section className="card" aria-labelledby="ov-mandates-title">
      <div className="card-head">
        <h2 id="ov-mandates-title" className="card-title">
          Your mandates
        </h2>
        <Link to="/mandates" className="card-link">
          See all
        </Link>
      </div>
      {o !== undefined ? (
        <ul className="mandate-list">
          {o.mandates.slice(0, SHOWN_MANDATES).map((m) => (
            <MandateLine key={m.id} m={m} />
          ))}
        </ul>
      ) : overview.error === null ? (
        <Skeleton lines={3} label="Loading your mandates" />
      ) : (
        <ErrorNotice
          error={overview.error}
          onRetry={overview.reload}
          requestId={overview.errorRequestId}
        />
      )}
    </section>
  );
}

function Step({
  n,
  state,
  title,
  text,
  action,
}: {
  n: number;
  state: StepState;
  title: string;
  text: string;
  /** Where the step is taken; null while an earlier step is missing. */
  action: { to: string; label: string } | null;
}) {
  return (
    <li className={`setup-step setup-${state}`}>
      <span className="setup-n" aria-hidden="true">
        {state === 'done' ? <Icon name="check" size={16} /> : n}
      </span>
      <div className="setup-body">
        <h3>
          {title}
          <span className="sr-only">{state === 'done' ? ' (done)' : ' (to do)'}</span>
        </h3>
        <p className="muted small">{text}</p>
      </div>
      {state === 'done' || action === null ? null : (
        <Link
          to={action.to}
          className={state === 'next' ? 'btn btn-primary btn-small' : 'btn btn-small'}
        >
          {action.label}
        </Link>
      )}
    </li>
  );
}

/** A new project's three steps, each done only once the server shows it. */
function FirstStepsCard({ steps }: { steps: FirstSteps }) {
  return (
    <section className="card" aria-labelledby="first-title">
      <h2 id="first-title" className="card-title">
        First steps
      </h2>
      <ol className="setup">
        <Step
          n={1}
          state={steps.mandate}
          title="Create a mandate"
          text="Set the budget and the rules."
          action={{ to: '/mandates/new', label: 'Create a mandate' }}
        />
        <Step
          n={2}
          state={steps.fund}
          title="Fund it"
          text="Send USDC from your wallet."
          action={
            steps.fundTarget === null
              ? null
              : { to: `/mandates/${steps.fundTarget}`, label: 'Add funds' }
          }
        />
        {steps.key === null ? null : (
          <Step
            n={3}
            state={steps.key}
            title="Create a key"
            text="Your agent uses it to ask for payouts."
            action={{ to: '/developers', label: 'Create a key' }}
          />
        )}
      </ol>
    </section>
  );
}

function WaitingStrip({ n }: { n: number }) {
  if (n === 0) return null;
  return (
    <Link to="/approvals" className="strip">
      <span className="strip-dot" aria-hidden="true" />
      <strong>{n === 1 ? '1 payout waiting' : `${countText(n)} payouts waiting`}</strong>
      <span className="muted">for approval</span>
      <Icon name="arrow" size={18} />
    </Link>
  );
}

function Bars({
  rows,
  label,
  tone,
}: {
  rows: readonly CountRow[];
  label: (code: string) => ReactNode;
  tone: (code: string) => Tone;
}) {
  const max = rows.reduce((m, r) => Math.max(m, r.count), 0);
  return (
    <ul className="bars">
      {rows.map((r) => (
        <li key={r.code}>
          <span className="bars-label">{label(r.code)}</span>
          <span className="bars-track" aria-hidden="true">
            <span
              className={`bars-fill bars-${tone(r.code)}`}
              style={{ width: `${String(Math.max(2, Math.round((r.count * 100) / max)))}%` }}
            />
          </span>
          <span className="bars-count num">{countText(r.count)}</span>
        </li>
      ))}
    </ul>
  );
}

function ruleLabel(code: string): string {
  return reasonText(code).replace(/\.$/, '');
}

function Kpi({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="card kpi">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/** The period in numbers: what was paid, how many payouts, and why some were blocked. */
function Period({ o }: { o: Overview }) {
  const statuses = statusRows(o.byStatus);
  const rules = ruleRows(o.blockedByRule);
  const blocked = o.byStatus['blocked'] ?? 0;
  return (
    <>
      <dl className="kpis">
        <Kpi label="Paid">
          {o.paid.length === 0 ? (
            <span className="kpi-none">Nothing yet</span>
          ) : (
            o.paid.map((t) => (
              <Amount key={`${t.network} ${t.asset} ${String(t.scale)}`} token={t} size="lg" />
            ))
          )}
        </Kpi>
        <Kpi label="Payouts">
          <span className="kpi-num">{countText(payoutCount(o.byStatus))}</span>
        </Kpi>
        <Kpi label="Blocked by rule">
          <span className="kpi-num">{countText(blocked)}</span>
        </Kpi>
        <Kpi
          label={
            <>
              Time to paid <SoonTag />
            </>
          }
        >
          <span className="kpi-none">Not measured yet</span>
        </Kpi>
      </dl>
      <div className="grid-2">
        <section className="card" aria-labelledby="by-status-title">
          <h2 id="by-status-title" className="card-title">
            By status
          </h2>
          {statuses.length === 0 ? (
            <Empty text="No payouts in this period." />
          ) : (
            <Bars
              rows={statuses}
              label={(code) => {
                const w = statusWord(code);
                return <StatusPill tone={w.tone}>{w.label}</StatusPill>;
              }}
              tone={(code) => statusWord(code).tone}
            />
          )}
        </section>
        <section className="card" aria-labelledby="by-rule-title">
          <h2 id="by-rule-title" className="card-title">
            Blocked by rule
          </h2>
          {rules.length === 0 ? (
            <Empty text="Nothing blocked." />
          ) : (
            <Bars rows={rules} label={ruleLabel} tone={() => 'blocked'} />
          )}
        </section>
      </div>
    </>
  );
}

function focusPayout(id: string): void {
  const el = document.querySelector(`[data-payout-row="${id}"]`);
  if (el instanceof HTMLElement) el.focus();
}

function RecentLine({ p, onOpen }: { p: PayoutDetail; onOpen: (id: string) => void }) {
  const w = statusWord(p.status);
  return (
    <li>
      <button
        type="button"
        className="mandate-link row-button"
        data-payout-row={p.id}
        onClick={() => {
          onOpen(p.id);
        }}
      >
        <span className="mandate-icon">
          <BrandIcon name="payout" />
        </span>
        <span className="mandate-main">
          <strong className="mandate-name">{p.recipient.label}</strong>
          <span className="muted small">{when(p.createdAt)}</span>
        </span>
        <span className="mandate-money">
          <Amount token={p.amount} />
          <StatusPill tone={w.tone}>{w.label}</StatusPill>
        </span>
        <Icon name="arrow" size={18} />
      </button>
    </li>
  );
}

/** The project's overview, read from /v1 and keyed by project. */
export function OverviewV1({ v1, projectId }: { v1: V1Api; projectId: string }) {
  const search = useSearch();
  const open = openOf(search);
  const overview = useResource(`v1:overview:${projectId}`, () => v1.overview(), POLL_MS);
  const recent = useResource(
    `v1:overview-payouts:${projectId}`,
    () => v1.payouts({ limit: RECENT }),
    POLL_MS,
  );
  const keys = useResource(`v1:overview-keys:${projectId}`, () => keyState(v1));

  const o = overview.data;
  const empty = o !== undefined && o.mandates.length === 0 && !o.moreMandates;
  // A failed key read leaves the key step out rather than calling it done or not.
  const hasKey = keys.data !== undefined ? keys.data : keys.error === null ? undefined : null;
  const steps = o === undefined || hasKey === undefined ? undefined : firstSteps(o, hasKey);
  const byId = useMemo(() => new Map((o?.mandates ?? []).map((m) => [m.id, m])), [o]);

  const onOpen = useCallback((id: string) => {
    replaceSearch(withOpen(location.search, id));
  }, []);
  const onClose = useCallback(() => {
    const id = openOf(location.search);
    replaceSearch(withOpen(location.search, null));
    setTimeout(() => {
      if (id !== null) focusPayout(id);
    }, 0);
  }, []);

  const rows = recent.data?.items;

  return (
    <div className="stack">
      {overview.error !== null && o !== undefined ? (
        <Notice tone="waiting">
          <p>Could not refresh: {overview.error} Showing the last known figures.</p>
        </Notice>
      ) : null}
      <div className="grid-main">
        <Balance overview={overview} primary={empty ? null : steps?.allDone === true} />
        {empty ? (
          steps === undefined ? (
            <section className="card" aria-label="First steps">
              <Skeleton lines={3} label="Checking your first steps" />
            </section>
          ) : (
            <FirstStepsCard steps={steps} />
          )
        ) : (
          <MandateBalances overview={overview} />
        )}
      </div>
      {o === undefined ? null : <WaitingStrip n={o.approvalsWaiting} />}
      {!empty && steps !== undefined && !steps.allDone ? <FirstStepsCard steps={steps} /> : null}
      {empty ? null : (
        <>
          <section className="period" aria-labelledby="period-title">
            <div className="section-head">
              <h2 id="period-title" className="card-title">
                This period
              </h2>
              {o === undefined ? null : <p className="muted small">{periodText(o.period)}</p>}
            </div>
            {o !== undefined ? (
              <Period o={o} />
            ) : overview.error === null ? (
              <Skeleton lines={3} label="Loading this period" />
            ) : (
              <ErrorNotice
                error={overview.error}
                onRetry={overview.reload}
                requestId={overview.errorRequestId}
              />
            )}
          </section>
          <section className="card" aria-labelledby="recent-title">
            <div className="card-head">
              <h2 id="recent-title" className="card-title">
                Recent payouts
              </h2>
              <Link to="/payouts" className="card-link">
                See all
              </Link>
            </div>
            {rows !== undefined ? (
              rows.length === 0 ? (
                <Empty text="No payouts yet." />
              ) : (
                <ul className="mandate-list">
                  {rows.map((p) => (
                    <RecentLine key={p.id} p={p} onOpen={onOpen} />
                  ))}
                </ul>
              )
            ) : recent.error === null ? (
              <Skeleton lines={3} label="Loading recent payouts" />
            ) : (
              <ErrorNotice
                error={recent.error}
                onRetry={recent.reload}
                requestId={recent.errorRequestId}
              />
            )}
          </section>
        </>
      )}
      <SoonRow title="Coming next" items={['Volume over time', 'Corridors', 'Bank funding']} />
      {open === null ? null : (
        <PayoutSheet
          key={open}
          v1={v1}
          projectId={projectId}
          id={open}
          mandateLabel={(p) =>
            mandateName(byId.get(p.mandate.id) ?? { name: null, contractId: p.mandate.contractId })
          }
          onClose={onClose}
        />
      )}
    </div>
  );
}
