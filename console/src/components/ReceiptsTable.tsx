// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

import type { Mandate, Receipt } from '../lib/schemas';
import { shortAddress } from '../lib/strkey';
import { reasonText, statusWord } from '../lib/words';
import { Amount, BrandIcon, ErrorNotice, Skeleton, StatusPill, TxLink } from './ui';

const RAILS: Record<string, string> = { usdc: 'USDC direct', sdp: 'SDP' };

function when(iso: string | null | undefined): string {
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

export function ReceiptsTable({
  m,
  receipts,
  loading,
  error,
  onRetry,
}: {
  m: Mandate;
  receipts: readonly Receipt[] | undefined;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
}) {
  return (
    <section className="card" aria-labelledby="receipts-title">
      <div className="card-head">
        <h2 id="receipts-title" className="card-title">
          <BrandIcon name="receipt" />
          Receipts
        </h2>
        {receipts !== undefined && receipts.length > 0 ? (
          <span className="muted small">{receipts.length} so far, newest first</span>
        ) : null}
      </div>
      {loading ? (
        <Skeleton lines={3} label="Loading receipts" />
      ) : error !== null && receipts === undefined ? (
        <ErrorNotice error={error} onRetry={onRetry} />
      ) : receipts === undefined || receipts.length === 0 ? (
        <p className="muted">
          No receipts yet. Every request the agent makes gets one here, paid or blocked.
        </p>
      ) : (
        <div className="table-wrap">
          <table className="receipts">
            <thead>
              <tr>
                <th scope="col">When</th>
                <th scope="col">Task</th>
                <th scope="col">Recipient</th>
                <th scope="col" className="num">
                  Amount
                </th>
                <th scope="col">Method</th>
                <th scope="col">Result</th>
                <th scope="col">Transaction</th>
              </tr>
            </thead>
            <tbody>
              {receipts.map((r) => {
                const word = statusWord(r.outcome);
                return (
                  <tr key={r.task_id}>
                    <td data-label="When">{when(r.updated_at ?? r.created_at)}</td>
                    <td data-label="Task" className="mono">
                      {r.task_id}
                    </td>
                    <td data-label="Recipient">{recipientName(m, r)}</td>
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
