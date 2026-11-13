// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

import { useState } from 'react';

import { useApp } from '../app/context';
import { useAction } from '../app/hooks';
import { formatUsdc } from '../lib/money';
import type { Mandate, Payout, Receipt } from '../lib/schemas';
import { buildSignSubmit } from '../lib/sign';
import { shortAddress } from '../lib/strkey';
import { statusWord } from '../lib/words';
import { RequestNotice } from './AgentPanel';
import {
  Amount,
  BrandIcon,
  ConfirmDialog,
  ErrorNotice,
  Skeleton,
  Spinner,
  StatusPill,
  TxLink,
} from './ui';

function labelFor(m: Mandate, p: Payout): string {
  if (typeof p.recipientLabel === 'string' && p.recipientLabel !== '') return p.recipientLabel;
  return m.recipients.find((r) => r.address === p.recipient)?.label ?? shortAddress(p.recipient);
}

function ApprovalItem({
  m,
  p,
  onDone,
  onPaid,
}: {
  m: Mandate;
  p: Payout;
  onDone: () => void;
  onPaid: (result: Receipt, label: string) => void;
}) {
  const { api, config, wallet, notify } = useApp();
  const [confirmReject, setConfirmReject] = useState(false);
  const [signed, setSigned] = useState<string | null>(null);
  const owner = wallet !== null && wallet.address === m.principal;
  const label = labelFor(m, p);
  const amount = formatUsdc(p.amount);

  const decide = useAction(async (action: 'approve' | 'reject') => {
    if (wallet === null) return;
    if (typeof p.payoutId !== 'string')
      throw new Error('This payout has no ID yet. Refresh and try again.');
    const res = await buildSignSubmit(api, config, wallet, action, {
      mandate: m.id,
      payoutId: p.payoutId,
    });
    setSigned(res.hash);
    setConfirmReject(false);
    notify(
      action === 'approve' ? `Approved ${amount} to ${label}.` : `Rejected ${amount} to ${label}.`,
    );
    onDone();
  });
  const payNow = useAction(async () => {
    const result = await api.request(m.id, {
      recipient: p.recipient,
      amount: p.amount,
      rail: p.rail === 'sdp' ? 'sdp' : 'usdc',
      taskId: p.taskId,
    });
    onPaid(result, label);
    notify(`Task ${p.taskId} finished.`);
    onDone();
  });
  const word = statusWord(p.status);
  const error = decide.error ?? payNow.error;

  return (
    <li className="approval">
      <div className="approval-head">
        <Amount minor={p.amount} size="lg" />
        <StatusPill tone={word.tone}>{word.label}</StatusPill>
      </div>
      <p>
        To <strong>{label}</strong> for task <span className="mono">{p.taskId}</span>
      </p>
      <p className="muted small">
        Needs approval because it is {formatUsdc(m.rules.approvalThreshold)} or more. Left in the
        budget: {formatUsdc(m.state.remaining)}.
      </p>
      {p.status === 'pending_approval' ? (
        <div className="actions">
          <button
            type="button"
            className="btn"
            disabled={!owner || decide.busy}
            onClick={() => void decide.run('approve')}
          >
            {decide.busy ? <Spinner /> : null}
            Approve
          </button>
          <button
            type="button"
            className="btn btn-danger-ghost"
            disabled={!owner || decide.busy}
            onClick={() => {
              setConfirmReject(true);
            }}
          >
            Reject
          </button>
        </div>
      ) : (
        <div className="actions">
          <button
            type="button"
            className="btn btn-primary"
            disabled={payNow.busy}
            onClick={() => void payNow.run()}
          >
            {payNow.busy ? <Spinner /> : null}
            {payNow.busy ? 'Paying' : 'Pay now'}
          </button>
          <span className="muted small">
            Approved. The agent asks again with the same task ID, and the mandate pays.
          </span>
        </div>
      )}
      {!owner && p.status === 'pending_approval' ? (
        <p className="muted small">Only the owner wallet can approve or reject.</p>
      ) : null}
      {signed === null ? null : (
        <p className="small">
          Signed and settled: <TxLink hash={signed} />
        </p>
      )}
      {error === null ? null : <ErrorNotice error={error} />}
      <ConfirmDialog
        open={confirmReject}
        title={`Reject ${amount} to ${label}?`}
        confirmLabel="Reject payout"
        danger
        busy={decide.busy}
        onCancel={() => {
          setConfirmReject(false);
        }}
        onConfirm={() => void decide.run('reject')}
      >
        <p>
          The payout for task <span className="mono">{p.taskId}</span> will never be paid. The agent
          can ask again only with a new task ID.
        </p>
        {decide.error === null ? null : <ErrorNotice error={decide.error} />}
      </ConfirmDialog>
    </li>
  );
}

export function Approvals({
  m,
  payouts,
  loading,
  error,
  onRetry,
  onDone,
}: {
  m: Mandate;
  payouts: readonly Payout[] | undefined;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  onDone: () => void;
}) {
  const [lastPaid, setLastPaid] = useState<{ result: Receipt; label: string } | null>(null);
  const waiting = (payouts ?? []).filter(
    (p) => p.status === 'pending_approval' || p.status === 'approved',
  );
  return (
    <section className="card" aria-labelledby="approvals-title">
      <div className="card-head">
        <h2 id="approvals-title" className="card-title">
          <BrandIcon name="approval" />
          Approvals
        </h2>
        {waiting.length > 0 ? <span className="count">{waiting.length} waiting</span> : null}
      </div>
      {loading ? (
        <Skeleton lines={2} label="Loading approvals" />
      ) : error !== null && payouts === undefined ? (
        <ErrorNotice error={error} onRetry={onRetry} />
      ) : waiting.length === 0 ? (
        <p className="muted">
          Nothing waiting. Payouts of {formatUsdc(m.rules.approvalThreshold)} or more show up here
          for you to approve or reject.
        </p>
      ) : (
        <ul className="approval-list">
          {waiting.map((p) => (
            <ApprovalItem
              key={p.taskId}
              m={m}
              p={p}
              onDone={onDone}
              onPaid={(result, label) => {
                setLastPaid({ result, label });
              }}
            />
          ))}
        </ul>
      )}
      {lastPaid === null ? null : <RequestNotice result={lastPaid.result} label={lastPaid.label} />}
    </section>
  );
}
