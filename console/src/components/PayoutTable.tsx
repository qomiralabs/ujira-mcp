// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The payouts table: one line per payout, sortable from the headers, drawn a
// screenful at a time so ten thousand rows scroll as easily as ten.

import { memo, useRef, type MouseEvent } from 'react';

import { useVirtualRows } from '../app/virtual';
import { methodOf, type SortDir, type SortKey } from '../lib/payoutsV1';
import type { PayoutDetail } from '../lib/v1Schemas';
import { reasonText, statusWord } from '../lib/words';
import { Link } from './Link';
import { when } from './ReceiptsTable';
import { Amount, CopyButton, Icon, StatusPill, Tip } from './ui';

// A row with a 32px pill and 13px padding top and bottom, plus its border.
const ROW_ESTIMATE = 53;
const COLUMNS = 8;

export function shortId(id: string): string {
  return id.slice(0, 8);
}

function When({ iso }: { iso: string | null }) {
  if (iso === null) return <span className="muted">Not yet</span>;
  const text = when(iso);
  if (text === '') return <span className="muted">Not yet</span>;
  return (
    <time dateTime={iso} title={new Date(iso).toLocaleString()}>
      {text}
    </time>
  );
}

function SortHead({
  label,
  column,
  sort,
  dir,
  onSort,
  className,
}: {
  label: string;
  column: SortKey;
  sort: SortKey;
  dir: SortDir;
  onSort: (key: SortKey) => void;
  className: string;
}) {
  const active = sort === column;
  return (
    <th
      scope="col"
      className={className}
      aria-sort={active ? (dir === 'asc' ? 'ascending' : 'descending') : undefined}
    >
      <button
        type="button"
        className={`th-sort${active ? ` th-sort-on th-sort-${dir}` : ''}`}
        onClick={() => {
          onSort(column);
        }}
      >
        {label}
        <Icon name="chevron" size={14} />
      </button>
    </th>
  );
}

const Row = memo(function Row({
  p,
  index,
  open,
  mandate,
  onOpen,
  measure,
}: {
  p: PayoutDetail;
  index: number;
  open: boolean;
  mandate: string;
  onOpen: (id: string) => void;
  measure: ((row: HTMLElement | null) => void) | undefined;
}) {
  const word = statusWord(p.status);
  const id = shortId(p.id);
  const click = (e: MouseEvent<HTMLTableRowElement>) => {
    // Links and buttons in the row do their own thing.
    if (e.target instanceof Element && e.target.closest('a, button') !== null) return;
    onOpen(p.id);
  };
  return (
    <tr
      ref={measure}
      className={`prow${open ? ' prow-open' : ''}`}
      aria-rowindex={index + 2}
      onClick={click}
    >
      <td className="c-id">
        <span className="id-text">
          <button
            type="button"
            className="row-open mono"
            data-payout={p.id}
            aria-label={`Open payout ${id}`}
            title={p.id}
            onClick={() => {
              onOpen(p.id);
            }}
          >
            {id}
          </button>
          <CopyButton text={p.id} label={`Copy payout ID ${id}`} icon />
        </span>
      </td>
      <td className="c-to">{p.recipient.label}</td>
      <td className="c-amount num">
        <Amount token={p.amount} />
      </td>
      <td className="c-status">
        <span className="status-cell">
          <StatusPill tone={word.tone}>{word.label}</StatusPill>
          {p.blockedBy === null ? null : (
            <Tip text={reasonText(p.blockedBy)} label="Why it was blocked" />
          )}
        </span>
      </td>
      <td className="c-method">{methodOf(p)}</td>
      <td className="c-mandate">
        <Link to={`/mandates/${p.mandate.id}`} className="cut table-link">
          {mandate}
        </Link>
      </td>
      <td className="c-when">
        <When iso={p.createdAt} />
      </td>
      <td className="c-when c-settled">
        <When iso={p.settledAt} />
      </td>
    </tr>
  );
});

function Pad({ height }: { height: number }) {
  if (height <= 0) return null;
  return (
    <tr className="vt-pad" aria-hidden="true" style={{ height }}>
      <td colSpan={COLUMNS} />
    </tr>
  );
}

export const PayoutTable = memo(function PayoutTable({
  rows,
  sort,
  dir,
  openId,
  onSort,
  onOpen,
  mandateLabel,
}: {
  rows: readonly PayoutDetail[];
  sort: SortKey;
  dir: SortDir;
  openId: string | null;
  onSort: (key: SortKey) => void;
  onOpen: (id: string) => void;
  mandateLabel: (p: PayoutDetail) => string;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const win = useVirtualRows(rows.length, scroller, { estimate: ROW_ESTIMATE });
  const shown = rows.slice(win.start, win.end);
  const head = { sort, dir, onSort };
  return (
    <div
      ref={scroller}
      className="table-wrap payout-scroll"
      role="region"
      aria-label="Payouts table"
      tabIndex={0}
    >
      <table className="ledger payout-table" aria-rowcount={rows.length + 1}>
        <thead>
          <tr aria-rowindex={1}>
            <th scope="col" className="c-id">
              Payout
            </th>
            <SortHead label="Recipient" column="recipient" className="c-to" {...head} />
            <SortHead label="Amount" column="amount" className="c-amount num" {...head} />
            <SortHead label="Status" column="status" className="c-status" {...head} />
            <th scope="col" className="c-method">
              Method
            </th>
            <th scope="col" className="c-mandate">
              Mandate
            </th>
            <SortHead label="Created" column="created" className="c-when" {...head} />
            <SortHead label="Settled" column="settled" className="c-when c-settled" {...head} />
          </tr>
        </thead>
        <tbody>
          <Pad height={win.padTop} />
          {shown.map((p, i) => (
            <Row
              key={p.id}
              p={p}
              index={win.start + i}
              open={p.id === openId}
              mandate={mandateLabel(p)}
              onOpen={onOpen}
              measure={i === 0 ? win.measure : undefined}
            />
          ))}
          <Pad height={win.padBottom} />
        </tbody>
      </table>
    </div>
  );
});
