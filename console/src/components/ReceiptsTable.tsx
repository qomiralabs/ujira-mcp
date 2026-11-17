// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

import { useId, type ReactNode } from 'react';

import type { PayoutRow, ReceiptRow } from '../app/portfolio';
import type { Mandate, Payout, Receipt } from '../lib/schemas';
import { shortAddress } from '../lib/strkey';
import { reasonText, statusWord } from '../lib/words';
import { Link } from './Link';
import { Amount, CopyButton, Empty, ErrorNotice, Skeleton, StatusPill, Tip, TxLink } from './ui';

const RAILS: Record<string, string> = { usdc: 'USDC', sdp: 'SDP' };

/** A date and time short enough for one table line: "Nov 16, 2:27 PM". */
export function when(iso: string | null | undefined): string {
  if (iso === null || iso === undefined) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function When({ iso }: { iso: string | null | undefined }) {
  if (iso === null || iso === undefined || when(iso) === '') return null;
  return (
    <time dateTime={iso} title={new Date(iso).toLocaleString()}>
      {when(iso)}
    </time>
  );
}

function recipientName(m: Mandate, r: Receipt): string {
  const byLabel = m.recipients.find((x) => x.label === r.recipient);
  if (byLabel !== undefined) return byLabel.label;
  const address = typeof r.destination === 'string' ? r.destination : r.recipient;
  return m.recipients.find((x) => x.address === address)?.label ?? shortAddress(address);
}

export function payoutLabel(m: Mandate, p: Payout): string {
  if (typeof p.recipientLabel === 'string' && p.recipientLabel !== '') return p.recipientLabel;
  return m.recipients.find((r) => r.address === p.recipient)?.label ?? shortAddress(p.recipient);
}

function MandateCell({ m }: { m: Mandate }) {
  return (
    <td className="c-mandate">
      <Link to={`/mandates/${m.id}`} className="mono-link">
        {shortAddress(m.id)}
        <span className="sr-only"> (open the mandate)</span>
      </Link>
    </td>
  );
}

function TaskCell({ id }: { id: string }) {
  return (
    <td className="c-task">
      <span className="id-text">
        <span className="cut" title={id}>
          {id}
        </span>
        <CopyButton text={id} label={`Copy task ID ${id}`} icon />
      </span>
    </td>
  );
}

function StatusCell({ code, reason }: { code: string; reason?: string | null | undefined }) {
  const word = statusWord(code);
  return (
    <td className="c-status">
      <span className="status-cell">
        <StatusPill tone={word.tone}>{word.label}</StatusPill>
        {code === 'blocked' ? <Tip text={reasonText(reason)} label="Why it was blocked" /> : null}
      </span>
    </td>
  );
}

function TxCell({
  paid,
  request,
  sdp,
}: {
  paid?: string | null | undefined;
  request?: string | null | undefined;
  sdp?: string | null | undefined;
}) {
  return (
    <td className="c-tx">
      {typeof paid === 'string' ? (
        <TxLink hash={paid} />
      ) : typeof request === 'string' ? (
        <span className="tx-pair">
          <span className="muted">Request</span> <TxLink hash={request} />
        </span>
      ) : (
        <span className="muted">None</span>
      )}
      {typeof sdp === 'string' ? (
        <span className="tx-pair">
          {' '}
          <span className="muted">SDP</span> <TxLink hash={sdp} />
        </span>
      ) : null}
    </td>
  );
}

interface TableProps<Row> {
  readonly rows: readonly Row[] | undefined;
  readonly loading: boolean;
  readonly error: string | null;
  readonly onRetry: () => void;
  /** Adds a column naming the mandate, for lists that span several. */
  readonly showMandate?: boolean;
  readonly title?: string;
  readonly empty?: string;
  /** A link at the right of the heading, such as "See all". */
  readonly more?: ReactNode;
}

function TableCard({
  title,
  more,
  children,
}: {
  title: string;
  more?: ReactNode;
  children: (id: string) => ReactNode;
}) {
  const id = useId();
  return (
    <section className="card card-flush" aria-labelledby={id}>
      <div className="card-head">
        <h2 id={id} className="card-title">
          {title}
        </h2>
        {more ?? null}
      </div>
      {children(id)}
    </section>
  );
}

function Head({ showMandate, status }: { showMandate: boolean; status: string }) {
  return (
    <thead>
      <tr>
        <th scope="col" className="c-when">
          Date
        </th>
        <th scope="col" className="c-to">
          To
        </th>
        <th scope="col" className="c-task">
          Task
        </th>
        {showMandate ? (
          <th scope="col" className="c-mandate">
            Mandate
          </th>
        ) : null}
        <th scope="col" className="c-method">
          Method
        </th>
        <th scope="col" className="c-status">
          {status}
        </th>
        <th scope="col" className="c-amount num">
          Amount
        </th>
        <th scope="col" className="c-tx">
          Transaction
        </th>
      </tr>
    </thead>
  );
}

export function ReceiptsTable({
  rows,
  loading,
  error,
  onRetry,
  showMandate = false,
  title = 'Receipts',
  empty = 'No receipts yet.',
  more,
}: TableProps<ReceiptRow>) {
  return (
    <TableCard title={title} more={more}>
      {() =>
        loading ? (
          <Skeleton lines={3} label="Loading receipts" />
        ) : error !== null && rows === undefined ? (
          <ErrorNotice error={error} onRetry={onRetry} />
        ) : rows === undefined || rows.length === 0 ? (
          <Empty text={empty} />
        ) : (
          <div className="table-wrap">
            <table className="ledger">
              <Head showMandate={showMandate} status="Result" />
              <tbody>
                {rows.map(({ mandate: m, receipt: r }) => (
                  <tr key={`${m.id}:${r.task_id}`}>
                    <td className="c-when">
                      <When iso={r.updated_at ?? r.created_at} />
                    </td>
                    <td className="c-to">{recipientName(m, r)}</td>
                    <TaskCell id={r.task_id} />
                    {showMandate ? <MandateCell m={m} /> : null}
                    <td className="c-method">{RAILS[r.rail ?? 'usdc'] ?? r.rail}</td>
                    <StatusCell code={r.outcome} reason={r.reason} />
                    <td className="c-amount num">
                      <Amount minor={r.amount} />
                    </td>
                    <TxCell paid={r.tx_hash} request={r.request_tx_hash} sdp={r.sdp_tx_hash} />
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      }
    </TableCard>
  );
}

export function PayoutsTable({
  rows,
  loading,
  error,
  onRetry,
  showMandate = true,
  title = 'Every payout',
  empty = 'No payouts yet.',
  more,
}: TableProps<PayoutRow>) {
  return (
    <TableCard title={title} more={more}>
      {() =>
        loading ? (
          <Skeleton lines={3} label="Loading payouts" />
        ) : error !== null && rows === undefined ? (
          <ErrorNotice error={error} onRetry={onRetry} />
        ) : rows === undefined || rows.length === 0 ? (
          <Empty text={empty} />
        ) : (
          <div className="table-wrap">
            <table className="ledger">
              <Head showMandate={showMandate} status="Status" />
              <tbody>
                {rows.map(({ mandate: m, payout: p }) => (
                  <tr key={`${m.id}:${p.taskId}`}>
                    <td className="c-when">
                      <When iso={p.at} />
                    </td>
                    <td className="c-to">{payoutLabel(m, p)}</td>
                    <TaskCell id={p.taskId} />
                    {showMandate ? <MandateCell m={m} /> : null}
                    <td className="c-method">{RAILS[p.rail] ?? p.rail}</td>
                    <StatusCell code={p.status} reason={p.reason} />
                    <td className="c-amount num">
                      <Amount minor={p.amount} />
                    </td>
                    <TxCell paid={p.paidTx} request={p.requestTx} sdp={p.sdpTx} />
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      }
    </TableCard>
  );
}
