// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

import { isWaiting, type MandateBundle, type Portfolio } from '../app/portfolio';
import { formatUsdc, percentOf } from '../lib/money';
import { shortAddress } from '../lib/strkey';
import { MANDATE_STATUS, mandateStatus } from '../lib/words';
import { Link } from './Link';
import { Amount, BrandIcon, Empty, ErrorNotice, Icon, Skeleton, StatusPill } from './ui';

function created(iso: string | null | undefined): string {
  if (iso === null || iso === undefined) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

function MandateRow({ b, compact }: { b: MandateBundle; compact: boolean }) {
  const m = b.mandate;
  const to = `/mandates/${b.summary.id}`;
  if (m === null) {
    return (
      <li>
        <Link to={to} className="mandate-link">
          <span className="mandate-icon">
            <BrandIcon name="mandate" />
          </span>
          <span className="mandate-main">
            <span className="mono">{shortAddress(b.summary.id, 6)}</span>
            <span className="muted small">Could not load. {b.error}</span>
          </span>
          <Icon name="arrow" size={18} />
        </Link>
      </li>
    );
  }
  const status = MANDATE_STATUS[mandateStatus(m.state)];
  const used = percentOf(m.state.spent, m.rules.budget);
  const waiting = b.payouts.filter(isWaiting).length;
  const date = created(b.summary.createdAt);
  return (
    <li>
      <Link to={to} className={`mandate-link${compact ? '' : ' mandate-link-full'}`}>
        <span className="mandate-icon">
          <BrandIcon name="mandate" />
        </span>
        <span className="mandate-main">
          <span className="mandate-id">
            <span className="mono">{shortAddress(m.id, 6)}</span>
            <StatusPill tone={status.tone}>{status.label}</StatusPill>
            {waiting > 0 ? <span className="count">{waiting} waiting</span> : null}
          </span>
          {date === '' ? null : <span className="muted small">{date}</span>}
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
              {used}% of {formatUsdc(m.rules.budget)}
            </span>
          </span>
        )}
        <span className="mandate-money">
          <Amount minor={m.state.balance} />
          <span className="muted small">held</span>
        </span>
        <Icon name="arrow" size={18} />
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
    return <Empty text="No mandates yet." />;
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
