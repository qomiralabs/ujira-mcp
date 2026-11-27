// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// One receipt in a side sheet over the table: the amount and the outcome
// first, then what it proves (the transaction, the chain reference, the task
// and the mandate), and Verify, which checks it against Stellar.

import { useEffect, useId, useRef } from 'react';

import { useResource } from '../app/hooks';
import type { V1Api } from '../lib/v1';
import type { V1Receipt } from '../lib/v1Schemas';
import { reasonText, statusWord } from '../lib/words';
import { Link } from './Link';
import { ReceiptActions } from './ReceiptVerify';
import { Amount, ErrorNotice, Icon, IdText, Skeleton, SoonTag, StatusPill, TxLink } from './ui';

function fullWhen(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString();
}

function Detail({ r, v1, mandate }: { r: V1Receipt; v1: V1Api; mandate: string }) {
  const word = statusWord(r.outcome);
  return (
    <>
      <div className="sheet-hero">
        <p className="sheet-amount">
          <Amount token={r.amount} size="xl" />
        </p>
        <p className="sheet-to">
          to <strong>{r.recipient.label}</strong>
        </p>
        <StatusPill tone={word.tone}>{word.label}</StatusPill>
        {r.blockedBy === null ? null : <p className="sheet-reason">{reasonText(r.blockedBy)}</p>}
      </div>
      <ReceiptActions key={r.id} v1={v1} receipt={r}>
        <span className="soon-inline">
          PDF <SoonTag />
        </span>
      </ReceiptActions>
      <div className="perf" aria-hidden="true" />
      <dl className="rules sheet-facts">
        <div>
          <dt>Issued</dt>
          <dd>{fullWhen(r.issuedAt)}</dd>
        </div>
        <div>
          <dt>Transaction</dt>
          <dd>
            {r.txHash === null ? <span className="muted">None</span> : <TxLink hash={r.txHash} />}
          </dd>
        </div>
        {r.ref === null ? null : (
          <div>
            <dt>Chain reference</dt>
            <dd>
              <IdText value={r.ref} keep={10} copyLabel="Copy the chain reference" />
            </dd>
          </div>
        )}
        <div>
          <dt>Task ID</dt>
          <dd>
            <IdText value={r.taskId} keep={10} copyLabel="Copy the task ID" />
          </dd>
        </div>
        <div>
          <dt>Mandate</dt>
          <dd>
            <Link to={`/mandates/${r.mandate.id}`} className="card-link">
              {mandate}
            </Link>
          </dd>
        </div>
        <div>
          <dt>Payout ID</dt>
          <dd>
            <IdText value={r.payoutId} keep={8} copyLabel="Copy the payout ID" />
          </dd>
        </div>
        <div>
          <dt>Fee</dt>
          <dd>
            <Amount token={r.fee} />
          </dd>
        </div>
      </dl>
    </>
  );
}

/** Mounted while a receipt is open; Escape, the close button or the backdrop closes it. */
export function ReceiptSheet({
  v1,
  projectId,
  id,
  mandateLabel,
  onClose,
}: {
  v1: V1Api;
  projectId: string;
  id: string;
  mandateLabel: (r: V1Receipt) => string;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  // A receipt never changes once issued, so it is read once.
  const receipt = useResource(`v1:receipt:${projectId}:${id}`, () => v1.receipt(id));
  const r = receipt.data;

  useEffect(() => {
    const d = ref.current;
    if (d === null || d.open) return;
    if (typeof d.showModal === 'function') d.showModal();
    else d.setAttribute('open', '');
  }, []);

  return (
    <dialog
      ref={ref}
      className="sheet"
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        // A click on the dialog itself, not its content, is on the backdrop.
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="sheet-inner">
        <div className="sheet-head">
          <h2 id={titleId}>Receipt</h2>
          <IdText value={id} keep={8} copyLabel="Copy the receipt ID" />
          <button type="button" className="btn-icon sheet-close" onClick={onClose}>
            <Icon name="close" size={18} />
            <span className="sr-only">Close</span>
          </button>
        </div>
        {r === undefined ? (
          receipt.error === null ? (
            <Skeleton lines={5} label="Loading the receipt" />
          ) : (
            <ErrorNotice
              error={receipt.error}
              onRetry={receipt.reload}
              requestId={receipt.errorRequestId}
            />
          )
        ) : (
          <Detail r={r} v1={v1} mandate={mandateLabel(r)} />
        )}
      </div>
    </dialog>
  );
}
