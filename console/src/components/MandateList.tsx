// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

import { isWaiting, type MandateBundle, type Portfolio } from '../app/portfolio';
import { formatUsdc, percentOf } from '../lib/money';
import { shortAddress } from '../lib/strkey';
import { MANDATE_STATUS, mandateStatus } from '../lib/words';
import { Link } from './Link';
import { Amount, BrandIcon, ErrorNotice, Skeleton, StatusPill } from './ui';

function created(iso: string | null | undefined): string {
  if (iso === null || iso === undefined) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `Created ${d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}`;
}

function MandateRow({ b, compact }: { b: MandateBundle; compact: boolean }) {
  const m = b.mandate;
  const to = `/mandates/${b.summary.id}`;
  if (m === null) {
    return (
      <li>
        <Link to={to} className="mandate-link">
          <BrandIcon name="mandate" />
          <span className="mono">{shortAddress(b.summary.id, 6)}</span>
          <span className="muted small">Could not load it just now. {b.error}</span>
          <span aria-hidden="true">&rarr;</span>
        </Link>
      </li>
    );
  }
  const status = MANDATE_STATUS[mandateStatus(m.state)];
  const used = percentOf(m.state.spent, m.rules.budget);
  const waiting = b.payouts.filter(isWaiting).length;
  return (
    <li>
      <Link to={to} className={`mandate-link${compact ? '' : ' mandate-link-full'}`}>
        <BrandIcon name="mandate" />
        <span className="mandate-main">
          <span className="mandate-id">
            <span className="mono">{shortAddress(m.id, 6)}</span>
            <StatusPill tone={status.tone}>{status.label}</StatusPill>
            {waiting > 0 ? <span className="count">{waiting} waiting</span> : null}
          </span>
          <span className="muted small">
            {[
              created(b.summary.createdAt),
              compact
                ? ''
                : `${String(m.recipients.length)} ${m.recipients.length === 1 ? 'recipient' : 'recipients'}`,
            ]
              .filter((x) => x !== '')
              .join('. ')}
          </span>
        </span>
        <span className="mandate-money">
          <Amount minor={m.state.balance} />
          <span className="muted small">held</span>
        </span>
        {compact ? null : (
          <span className="mandate-meter">
            <span
              className="meter"
              role="img"
              aria-label={`${formatUsdc(m.state.spent)} of the ${formatUsdc(m.rules.budget)} budget paid`}
            >
              <span className="meter-used" style={{ width: `${String(used)}%` }} />
            </span>
            <span className="muted small">
              {formatUsdc(m.state.spent)} of {formatUsdc(m.rules.budget)} paid
            </span>
          </span>
        )}
        <span aria-hidden="true">&rarr;</span>
      </Link>
    </li>
  );
}

/** The wallet's mandates, newest first, each one a link to its page. */
export function MandateList({
  portfolio,
  limit,
  compact = false,
}: {
  portfolio: Portfolio | null;
  limit?: number;
  compact?: boolean;
}) {
  if (portfolio === null) return null;
  if (portfolio.loading) return <Skeleton lines={2} label="Loading your mandates" />;
  if (portfolio.data === undefined) {
    return <ErrorNotice error={portfolio.error ?? 'Not loaded.'} onRetry={portfolio.reload} />;
  }
  if (portfolio.data.length === 0) {
    return (
      <p className="muted">
        None yet. A mandate is where your rules and your test USDC live; create one to watch an
        agent pay inside it.
      </p>
    );
  }
  const shown = limit === undefined ? portfolio.data : portfolio.data.slice(0, limit);
  return (
    <ul className="mandate-list">
      {shown.map((b) => (
        <MandateRow key={b.summary.id} b={b} compact={compact} />
      ))}
    </ul>
  );
}
