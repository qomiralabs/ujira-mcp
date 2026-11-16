// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

import { useId, type ReactNode } from 'react';

import type { PayoutRow, ReceiptRow } from '../app/portfolio';
import type { Mandate, Payout, Receipt } from '../lib/schemas';
import { shortAddress } from '../lib/strkey';
import { reasonText, statusWord } from '../lib/words';
import { Link } from './Link';
import { Amount, BrandIcon, ErrorNotice, Skeleton, StatusPill, TxLink } from './ui';

const RAILS: Record<string, string> = { usdc: 'USDC direct', sdp: 'SDP' };

export function when(iso: string | null | undefined): string {
  if (iso === null || iso === undefined) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
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
    <td data-label="Mandate">
      <Link to={`/mandates/${m.id}`} className="mono-link">
        {shortAddress(m.id)}
        <span className="sr-only"> (open the mandate)</span>
      </Link>
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
  readonly empty?: ReactNode;
}

export function ReceiptsTable({
  rows,
  loading,
  error,
  onRetry,
  showMandate = false,
  title = 'Receipts',
  empty,
}: TableProps<ReceiptRow>) {
  const id = useId();
  return (
    <section className="card" aria-labelledby={id}>
      <div className="card-head">
        <h2 id={id} className="card-title">
          <BrandIcon name="receipt" />
          {title}
        </h2>
        {rows !== undefined && rows.length > 0 ? (
          <span className="muted small">{rows.length} so far, newest first</span>
        ) : null}
      </div>
      {loading ? (
        <Skeleton lines={3} label="Loading receipts" />
      ) : error !== null && rows === undefined ? (
        <ErrorNotice error={error} onRetry={onRetry} />
      ) : rows === undefined || rows.length === 0 ? (
        <p className="muted">
          {empty ??
            'No receipts yet. Every request the agent makes gets one here, paid or blocked.'}
        </p>
      ) : (
        <div className="table-wrap">
          <table className="ledger">
            <thead>
              <tr>
                <th scope="col">When</th>
                <th scope="col">Task</th>
                <th scope="col">Recipient</th>
                {showMandate ? <th scope="col">Mandate</th> : null}
                <th scope="col" className="num">
                  Amount
                </th>
                <th scope="col">Method</th>
                <th scope="col">Result</th>
                <th scope="col">Transaction</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ mandate: m, receipt: r }) => {
                const word = statusWord(r.outcome);
                return (
                  <tr key={`${m.id}:${r.task_id}`}>
                    <td data-label="When">{when(r.updated_at ?? r.created_at)}</td>
                    <td data-label="Task" className="mono">
                      {r.task_id}
                    </td>
                    <td data-label="Recipient">{recipientName(m, r)}</td>
                    {showMandate ? <MandateCell m={m} /> : null}
                    <td data-label="Amount" className="num">
                      <Amount minor={r.amount} />
                    </td>
                    <td data-label="Method">{RAILS[r.rail ?? 'usdc'] ?? r.rail}</td>
                    <td data-label="Result">
                      <StatusPill tone={word.tone}>{word.label}</StatusPill>
                      {r.outcome === 'blocked' ? (
                        <span className="reason">{reasonText(r.reason)}</span>
                      ) : null}
                    </td>
                    <td data-label="Transaction">
                      {typeof r.tx_hash === 'string' ? (
                        <TxLink hash={r.tx_hash} />
                      ) : typeof r.request_tx_hash === 'string' ? (
                        <span>
                          Request <TxLink hash={r.request_tx_hash} />
                        </span>
                      ) : (
                        <span className="muted">None, nothing moved</span>
                      )}
                      {typeof r.sdp_tx_hash === 'string' ? (
                        <span className="block small">
                          SDP <TxLink hash={r.sdp_tx_hash} />
                        </span>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export function PayoutsTable({
  rows,
  loading,
  error,
  onRetry,
  showMandate = true,
  title = 'Every payout',
  empty,
}: TableProps<PayoutRow>) {
  const id = useId();
  return (
    <section className="card" aria-labelledby={id}>
      <div className="card-head">
        <h2 id={id} className="card-title">
          <BrandIcon name="payout" />
          {title}
        </h2>
        {rows !== undefined && rows.length > 0 ? (
          <span className="muted small">{rows.length} so far, newest first</span>
        ) : null}
      </div>
      {loading ? (
        <Skeleton lines={3} label="Loading payouts" />
      ) : error !== null && rows === undefined ? (
        <ErrorNotice error={error} onRetry={onRetry} />
      ) : rows === undefined || rows.length === 0 ? (
        <p className="muted">{empty ?? 'No payouts yet.'}</p>
      ) : (
        <div className="table-wrap">
          <table className="ledger">
            <thead>
              <tr>
                <th scope="col">When</th>
                <th scope="col">Task</th>
                <th scope="col">To</th>
                {showMandate ? <th scope="col">Mandate</th> : null}
                <th scope="col" className="num">
                  Amount
                </th>
                <th scope="col">Method</th>
                <th scope="col">Status</th>
                <th scope="col">Transaction</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ mandate: m, payout: p }) => {
                const word = statusWord(p.status);
                return (
                  <tr key={`${m.id}:${p.taskId}`}>
                    <td data-label="When">{when(p.at)}</td>
                    <td data-label="Task" className="mono">
                      {p.taskId}
                    </td>
                    <td data-label="To">{payoutLabel(m, p)}</td>
                    {showMandate ? <MandateCell m={m} /> : null}
                    <td data-label="Amount" className="num">
                      <Amount minor={p.amount} />
                    </td>
                    <td data-label="Method">{RAILS[p.rail] ?? p.rail}</td>
                    <td data-label="Status">
                      <StatusPill tone={word.tone}>{word.label}</StatusPill>
                      {p.status === 'blocked' ? (
                        <span className="reason">{reasonText(p.reason)}</span>
                      ) : null}
                    </td>
                    <td data-label="Transaction">
                      {typeof p.paidTx === 'string' ? (
                        <TxLink hash={p.paidTx} />
                      ) : typeof p.requestTx === 'string' ? (
                        <span>
                          Request <TxLink hash={p.requestTx} />
                        </span>
                      ) : (
                        <span className="muted">None, nothing moved</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
