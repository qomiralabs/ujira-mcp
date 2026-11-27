// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// One payout in a side sheet over the table: the amount first, who it is
// for, the path it took from left to right, its legs with their Stellar
// transactions, and its receipt. The table stays where it was underneath.

import { useEffect, useId, useRef } from 'react';

import { useResource } from '../app/hooks';
import { methodLabel, timelineOf, type Step, type StepState } from '../lib/payoutsV1';
import type { V1Api } from '../lib/v1';
import type { PayoutDetail, PayoutLeg } from '../lib/v1Schemas';
import { reasonText, statusWord } from '../lib/words';
import { Link } from './Link';
import { when } from './ReceiptsTable';
import {
  Amount,
  ErrorNotice,
  Icon,
  IdText,
  Notice,
  Skeleton,
  SoonTag,
  StatusPill,
  TxLink,
} from './ui';

const POLL_MS = 10_000;

// Statuses that ended because of a rule or a person, with a reason worth a line.
const WITH_REASON = new Set(['blocked', 'rejected', 'cancelled', 'failed', 'needs_attention']);

const STEP_WORDS: Record<StepState, string> = {
  done: 'done',
  now: 'in progress',
  stopped: 'stopped here',
  later: 'not yet',
};

const STEP_MARKS: Record<StepState, string> = {
  done: 'M4.5 10.5 8 14l7.5-8',
  now: 'M10 6.5V10l2.5 1.8',
  stopped: 'M6.5 6.5l7 7M13.5 6.5l-7 7',
  later: 'M7 10h6',
};

function fullWhen(iso: string | null): string {
  if (iso === null) return 'Not yet';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? 'Not yet' : d.toLocaleString();
}

function Timeline({ steps }: { steps: readonly Step[] }) {
  return (
    <ol className="timeline" aria-label="Progress">
      {steps.map((s) => (
        <li
          key={s.key}
          className={`tl tl-${s.state}`}
          aria-current={s.state === 'now' ? 'step' : undefined}
        >
          <span className="tl-mark" aria-hidden="true">
            <svg width="14" height="14" viewBox="0 0 20 20" focusable="false">
              <path d={STEP_MARKS[s.state]} />
            </svg>
          </span>
          <span className="tl-label">
            {s.label}
            <span className="sr-only">, {STEP_WORDS[s.state]}</span>
          </span>
          {s.at === null || when(s.at) === '' ? null : (
            <time className="tl-at" dateTime={s.at}>
              {when(s.at)}
            </time>
          )}
        </li>
      ))}
    </ol>
  );
}

function Leg({ leg, count }: { leg: PayoutLeg; count: number }) {
  const word = statusWord(leg.status);
  return (
    <li className="leg">
      {count > 1 ? <span className="leg-n">{leg.index + 1}</span> : null}
      <span className="leg-main">
        <span>{methodLabel(leg.method)}</span>
        <span className="mono muted">{leg.destination === '' ? 'No wallet' : leg.destination}</span>
      </span>
      <Amount token={leg.amount} />
      <StatusPill tone={word.tone}>{word.label}</StatusPill>
      <span className="leg-tx">
        {leg.txHash === null ? (
          <span className="muted small">Not sent</span>
        ) : (
          <TxLink hash={leg.txHash} />
        )}
      </span>
    </li>
  );
}

function Receipt({ v1, projectId, id }: { v1: V1Api; projectId: string; id: string }) {
  const receipt = useResource(`v1:receipt:${projectId}:${id}`, () => v1.receipt(id));
  const r = receipt.data;
  if (r === undefined) {
    return receipt.error === null ? (
      <Skeleton lines={2} label="Loading the receipt" />
    ) : (
      <ErrorNotice
        error={receipt.error}
        onRetry={receipt.reload}
        requestId={receipt.errorRequestId}
      />
    );
  }
  const word = statusWord(r.outcome);
  return (
    <div className="stack-sm">
      <dl className="rules sheet-facts">
        <div>
          <dt>Outcome</dt>
          <dd>
            <StatusPill tone={word.tone}>{word.label}</StatusPill>
          </dd>
        </div>
        <div>
          <dt>Issued</dt>
          <dd>{fullWhen(r.issuedAt)}</dd>
        </div>
        <div>
          <dt>Receipt ID</dt>
          <dd>
            <IdText value={r.id} keep={8} copyLabel="Copy the receipt ID" />
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
      </dl>
      <div className="actions">
        <Link to="/receipts" className="card-link">
          All receipts
        </Link>
        <span className="soon-inline">
          Verify <SoonTag />
        </span>
        <span className="soon-inline">
          PDF <SoonTag />
        </span>
      </div>
    </div>
  );
}

function Detail({
  p,
  v1,
  projectId,
  mandate,
}: {
  p: PayoutDetail;
  v1: V1Api;
  projectId: string;
  mandate: string;
}) {
  const word = statusWord(p.status);
  const legsId = useId();
  const receiptId = useId();
  return (
    <>
      <div className="sheet-hero">
        <p className="sheet-amount">
          <Amount token={p.amount} size="xl" />
        </p>
        <p className="sheet-to">
          to <strong>{p.recipient.label}</strong>
        </p>
        <StatusPill tone={word.tone}>{word.label}</StatusPill>
        {WITH_REASON.has(p.status) && p.blockedBy !== null ? (
          <p className="sheet-reason">{reasonText(p.blockedBy)}</p>
        ) : null}
      </div>
      <Timeline steps={timelineOf(p)} />
      {p.status === 'pending_approval' ? (
        <Link to="/approvals" className="btn btn-primary btn-small sheet-cta">
          Open approvals
          <Icon name="arrow" size={16} />
        </Link>
      ) : null}
      <div className="perf" aria-hidden="true" />
      <dl className="rules sheet-facts">
        <div>
          <dt>Task ID</dt>
          <dd>
            <IdText value={p.taskId} keep={10} copyLabel="Copy the task ID" />
          </dd>
        </div>
        <div>
          <dt>Mandate</dt>
          <dd>
            <Link to={`/mandates/${p.mandate.id}`} className="card-link">
              {mandate}
            </Link>
          </dd>
        </div>
        <div>
          <dt>Created</dt>
          <dd>{fullWhen(p.createdAt)}</dd>
        </div>
        <div>
          <dt>Settled</dt>
          <dd>{fullWhen(p.settledAt)}</dd>
        </div>
        <div>
          <dt>Fee</dt>
          <dd>
            <Amount token={p.fee} />
          </dd>
        </div>
        <div>
          <dt>Request</dt>
          <dd>
            {p.requestTxHash === null ? (
              <span className="muted">Not sent</span>
            ) : (
              <TxLink hash={p.requestTxHash} />
            )}
          </dd>
        </div>
        {p.onChainPayoutId === null ? null : (
          <div>
            <dt>On chain ID</dt>
            <dd>
              <IdText value={p.onChainPayoutId} keep={6} copyLabel="Copy the on chain payout ID" />
            </dd>
          </div>
        )}
      </dl>
      <section className="stack-sm" aria-labelledby={legsId}>
        <h3 id={legsId} className="sub-title">
          {p.legs.length === 1 ? 'Leg' : `Legs (${String(p.legs.length)})`}
        </h3>
        <ol className="legs">
          {p.legs.map((leg) => (
            <Leg key={leg.index} leg={leg} count={p.legs.length} />
          ))}
        </ol>
      </section>
      <section className="stack-sm" aria-labelledby={receiptId}>
        <h3 id={receiptId} className="sub-title">
          Receipt
        </h3>
        {p.receiptId === null ? (
          <p className="muted small">Issued once the payout ends.</p>
        ) : (
          <Receipt v1={v1} projectId={projectId} id={p.receiptId} />
        )}
      </section>
    </>
  );
}

/** Mounted while a payout is open; Escape, the close button or the backdrop closes it. */
export function PayoutSheet({
  v1,
  projectId,
  id,
  mandateLabel,
  onClose,
}: {
  v1: V1Api;
  projectId: string;
  id: string;
  mandateLabel: (p: PayoutDetail) => string;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const payout = useResource(`v1:payout:${projectId}:${id}`, () => v1.payout(id), POLL_MS);
  const p = payout.data;

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
          <h2 id={titleId}>Payout</h2>
          <IdText value={id} keep={8} copyLabel="Copy the payout ID" />
          <button type="button" className="btn-icon sheet-close" onClick={onClose}>
            <Icon name="close" size={18} />
            <span className="sr-only">Close</span>
          </button>
        </div>
        {p === undefined ? (
          payout.error === null ? (
            <Skeleton lines={5} label="Loading the payout" />
          ) : (
            <ErrorNotice
              error={payout.error}
              onRetry={payout.reload}
              requestId={payout.errorRequestId}
            />
          )
        ) : (
          <>
            {payout.error === null ? null : (
              <Notice tone="waiting">
                <p>Could not refresh: {payout.error} Showing the last known state.</p>
              </Notice>
            )}
            <Detail p={p} v1={v1} projectId={projectId} mandate={mandateLabel(p)} />
          </>
        )}
      </div>
    </dialog>
  );
}
