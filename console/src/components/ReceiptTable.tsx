// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The receipts table on /v1: one line per receipt, newest first, drawn a
// screenful at a time so a long history scrolls as easily as a short one.

import { memo, useRef, type MouseEvent } from 'react';

import { useVirtualRows } from '../app/virtual';
import type { V1Receipt } from '../lib/v1Schemas';
import { reasonText, statusWord } from '../lib/words';
import { Link } from './Link';
import { shortId } from './PayoutTable';
import { when } from './ReceiptsTable';
import { Amount, CopyButton, StatusPill, Tip, TxLink } from './ui';

// The same one line row as the payouts table.
const ROW_ESTIMATE = 53;
const COLUMNS = 7;

const Row = memo(function Row({
  r,
  index,
  open,
  mandate,
  onOpen,
  measure,
}: {
  r: V1Receipt;
  index: number;
  open: boolean;
  mandate: string;
  onOpen: (id: string) => void;
  measure: ((row: HTMLElement | null) => void) | undefined;
}) {
  const word = statusWord(r.outcome);
  const id = shortId(r.id);
  const click = (e: MouseEvent<HTMLTableRowElement>) => {
    // Links and buttons in the row do their own thing.
    if (e.target instanceof Element && e.target.closest('a, button') !== null) return;
    onOpen(r.id);
  };
  const issued = when(r.issuedAt);
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
            data-receipt={r.id}
            aria-label={`Open receipt ${id}`}
            title={r.id}
            onClick={() => {
              onOpen(r.id);
            }}
          >
            {id}
          </button>
          <CopyButton text={r.id} label={`Copy receipt ID ${id}`} icon />
        </span>
      </td>
      <td className="c-to">{r.recipient.label}</td>
      <td className="c-amount num">
        <Amount token={r.amount} />
      </td>
      <td className="c-status">
        <span className="status-cell">
          <StatusPill tone={word.tone}>{word.label}</StatusPill>
          {r.blockedBy === null ? null : (
            <Tip text={reasonText(r.blockedBy)} label="Why it was blocked" />
          )}
        </span>
      </td>
      <td className="c-mandate">
        <Link to={`/mandates/${r.mandate.id}`} className="cut table-link">
          {mandate}
        </Link>
      </td>
      <td className="c-when">
        {issued === '' ? null : (
          <time dateTime={r.issuedAt} title={new Date(r.issuedAt).toLocaleString()}>
            {issued}
          </time>
        )}
      </td>
      <td className="c-tx">
        {r.txHash === null ? <span className="muted">None</span> : <TxLink hash={r.txHash} />}
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

export const ReceiptTable = memo(function ReceiptTable({
  rows,
  openId,
  onOpen,
  mandateLabel,
}: {
  rows: readonly V1Receipt[];
  openId: string | null;
  onOpen: (id: string) => void;
  mandateLabel: (r: V1Receipt) => string;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const win = useVirtualRows(rows.length, scroller, { estimate: ROW_ESTIMATE });
  const shown = rows.slice(win.start, win.end);
  return (
    <div
      ref={scroller}
      className="table-wrap payout-scroll"
      role="region"
      aria-label="Receipts table"
      tabIndex={0}
    >
      <table className="ledger payout-table receipt-table" aria-rowcount={rows.length + 1}>
        <thead>
          <tr aria-rowindex={1}>
            <th scope="col" className="c-id">
              Receipt
            </th>
            <th scope="col" className="c-to">
              Recipient
            </th>
            <th scope="col" className="c-amount num">
              Amount
            </th>
            <th scope="col" className="c-status">
              Outcome
            </th>
            <th scope="col" className="c-mandate">
              Mandate
            </th>
            <th scope="col" className="c-when">
              Issued
            </th>
            <th scope="col" className="c-tx">
              Transaction
            </th>
          </tr>
        </thead>
        <tbody>
          <Pad height={win.padTop} />
          {shown.map((r, i) => (
            <Row
              key={r.id}
              r={r}
              index={win.start + i}
              open={r.id === openId}
              mandate={mandateLabel(r)}
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
