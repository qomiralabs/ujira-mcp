// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

import { useId, useState } from 'react';

import { useApp } from '../app/context';
import { useAction } from '../app/hooks';
import type { AgentCall, Rail } from '../lib/api';
import { TASK_ID, newTaskId } from '../lib/mandateForm';
import { formatUsdc, parseAmount } from '../lib/money';
import type { Mandate, QuoteResult, Receipt } from '../lib/schemas';
import { accountAddressProblem, shortAddress } from '../lib/strkey';
import { reasonText } from '../lib/words';
import { BrandIcon, ErrorNotice, Field, Notice, Spinner, TxLink } from './ui';

const OTHER = 'other';

type Outcome =
  | { kind: 'quote'; call: AgentCall; result: QuoteResult }
  | { kind: 'request'; call: AgentCall; result: Receipt };

export function QuoteNotice({ result }: { result: QuoteResult }) {
  const left = result.headroom?.['budgetLeft'];
  const daily = result.headroom?.['dailyLeft'];
  const room =
    left === undefined || daily === undefined
      ? null
      : `Left in the budget: ${formatUsdc(left)}. Left today for this recipient: ${formatUsdc(daily)}.`;
  if (result.decision === 'allowed') {
    return (
      <Notice tone="paid" title="Allowed: this would be paid right away">
        {room === null ? null : <p className="small">{room}</p>}
      </Notice>
    );
  }
  if (result.decision === 'approval_required') {
    return (
      <Notice tone="waiting" title="Allowed after your approval">
        <p>It is at or above the approval amount, so a request would wait in the inbox.</p>
        {room === null ? null : <p className="small">{room}</p>}
      </Notice>
    );
  }
  return (
    <Notice tone="blocked" title="Blocked by the mandate">
      <p>{reasonText(result.reason)}</p>
    </Notice>
  );
}

export function RequestNotice({ result, label }: { result: Receipt; label: string }) {
  const amount = formatUsdc(result.amount);
  switch (result.outcome) {
    case 'paid':
    case 'approved_then_paid':
      return (
        <Notice tone="paid" title={`Paid ${amount} to ${label}`}>
          <p className="small">
            Task <span className="mono">{result.task_id}</span>.{' '}
            {typeof result.tx_hash === 'string' ? (
              <>
                Payment: <TxLink hash={result.tx_hash} />
              </>
            ) : null}
          </p>
        </Notice>
      );
    case 'approval_required':
      return (
        <Notice tone="waiting" title="Waiting for your approval">
          <p>
            {amount} to {label} is at or above the approval amount. Approve it in the inbox, then
            press Pay now.
          </p>
          {typeof result.request_tx_hash === 'string' ? (
            <p className="small">
              Request recorded on chain: <TxLink hash={result.request_tx_hash} />
            </p>
          ) : null}
        </Notice>
      );
    case 'settling':
      return (
        <Notice tone="waiting" title="Paying">
          <p>
            The mandate paid out and the payout rail is finishing. Check the receipts in a moment.
          </p>
        </Notice>
      );
    default:
      return (
        <Notice tone="blocked" title="Blocked. Nothing was paid.">
          <p>{reasonText(result.reason)}</p>
          <p className="small">
            The attempt is kept as a receipt, so blocked requests are visible too.
          </p>
        </Notice>
      );
  }
}

export function AgentPanel({ m, onDone }: { m: Mandate; onDone: () => void }) {
  const { api, config, notify } = useApp();
  const railName = useId();
  const [choice, setChoice] = useState<string>(m.recipients[0]?.address ?? OTHER);
  const [other, setOther] = useState('');
  const [amount, setAmount] = useState('1');
  const [rail, setRail] = useState<Rail>('usdc');
  const [taskId, setTaskId] = useState(() => newTaskId());
  const [errors, setErrors] = useState<{ amount?: string; other?: string; taskId?: string }>({});
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const sdp = m.sdpAvailable ?? config.sdpAvailable;

  const recipient = choice === OTHER ? other.trim() : choice;
  const labelOf = (address: string) =>
    m.recipients.find((r) => r.address === address || r.label === address)?.label ??
    shortAddress(address);

  const read = (): AgentCall | null => {
    const next: typeof errors = {};
    const parsed = parseAmount(amount);
    if (!parsed.ok) next.amount = parsed.error;
    else if (parsed.minor === '0') next.amount = 'The amount must be more than zero.';
    if (choice === OTHER) {
      const problem = accountAddressProblem(other);
      if (problem !== null) next.other = problem;
    }
    if (!TASK_ID.test(taskId)) {
      next.taskId = 'Use letters, digits and . _ : / @ # - only, up to 128 characters.';
    }
    setErrors(next);
    if (Object.keys(next).length > 0 || !parsed.ok) return null;
    return { recipient, amount: parsed.minor, rail, taskId };
  };

  const quote = useAction(async () => {
    const call = read();
    if (call === null) return;
    const result = await api.quote(m.id, call);
    setOutcome({ kind: 'quote', call, result });
  });
  const request = useAction(async () => {
    const call = read();
    if (call === null) return;
    const result = await api.request(m.id, call);
    setOutcome({ kind: 'request', call, result });
    notify(`Request for task ${call.taskId} finished.`);
    // A task ID pays once; the next request gets a fresh one.
    setTaskId(newTaskId());
    onDone();
  });
  const busy = quote.busy || request.busy;
  const error = quote.error ?? request.error;

  return (
    <section className="card agent" aria-labelledby="agent-title">
      <div className="card-head">
        <h2 id="agent-title" className="card-title">
          <BrandIcon name="agent" />
          Act as the AI agent
        </h2>
      </div>
      <p className="muted">
        These buttons do exactly what an agent does over MCP: the server&apos;s agent key asks this
        mandate to pay. You do not sign anything here; the contract decides.
      </p>
      <form
        className="form"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void request.run();
        }}
      >
        <div className="field">
          <label htmlFor="agent-recipient">Pay</label>
          <select
            id="agent-recipient"
            value={choice}
            onChange={(e) => {
              setChoice(e.target.value);
            }}
          >
            {m.recipients.map((r) => (
              <option key={r.address} value={r.address}>
                {r.label} ({shortAddress(r.address)})
              </option>
            ))}
            <option value={OTHER}>Someone not on the list</option>
          </select>
          {choice === OTHER ? (
            <p className="help">Try it: the mandate blocks any wallet that is not on its list.</p>
          ) : null}
        </div>
        {choice === OTHER ? (
          <Field
            label="Their Stellar address"
            mono
            placeholder="G..."
            value={other}
            onChange={setOther}
            error={errors.other}
          />
        ) : null}
        <Field
          label="Amount"
          suffix="USDC"
          inputMode="decimal"
          value={amount}
          onChange={setAmount}
          error={errors.amount}
          help={`Max per payment ${formatUsdc(m.rules.perPaymentCap)}. Needs approval from ${formatUsdc(m.rules.approvalThreshold)}.`}
        />
        <fieldset className="rails">
          <legend>Pay through</legend>
          <label className="rail-option">
            <input
              type="radio"
              name={railName}
              value="usdc"
              checked={rail === 'usdc'}
              onChange={() => {
                setRail('usdc');
              }}
            />
            <span>
              <strong>USDC, direct</strong>
              <span className="muted small">
                Paid straight to the recipient&apos;s Stellar wallet.
              </span>
            </span>
          </label>
          <label className={`rail-option${sdp ? '' : ' rail-disabled'}`}>
            <input
              type="radio"
              name={railName}
              value="sdp"
              checked={rail === 'sdp'}
              disabled={!sdp}
              onChange={() => {
                setRail('sdp');
              }}
            />
            <span>
              <strong>Stellar Disbursement Platform</strong>
              <span className="muted small">
                {sdp ? (
                  'Paid out through SDP, the platform organisations use for bulk payouts.'
                ) : (
                  <>
                    Live in our operator demo.{' '}
                    {config.sdpProofUrl === undefined ? null : (
                      <a href={config.sdpProofUrl} target="_blank" rel="noreferrer">
                        See it working<span className="sr-only"> (opens in a new tab)</span>
                      </a>
                    )}
                  </>
                )}
              </span>
            </span>
          </label>
        </fieldset>
        <div className="task-row">
          <Field
            label="Task ID"
            mono
            value={taskId}
            onChange={setTaskId}
            error={errors.taskId}
            help="The work this payout is for. One task is paid at most once."
          />
          <button
            type="button"
            className="btn btn-ghost btn-small"
            onClick={() => {
              setTaskId(newTaskId());
            }}
          >
            New ID
          </button>
        </div>
        <div className="actions">
          <button type="button" className="btn" disabled={busy} onClick={() => void quote.run()}>
            {quote.busy ? <Spinner /> : null}
            Quote
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {request.busy ? <Spinner /> : null}
            {request.busy ? 'Asking the mandate' : 'Request payout'}
          </button>
        </div>
        <p className="muted small">
          Quote only asks what would happen. Request payout really asks the mandate to pay.
        </p>
      </form>
      <div aria-live="polite">
        {error === null ? null : <ErrorNotice error={error} />}
        {outcome === null ? null : outcome.kind === 'quote' ? (
          <QuoteNotice result={outcome.result} />
        ) : (
          <RequestNotice result={outcome.result} label={labelOf(outcome.call.recipient)} />
        )}
      </div>
    </section>
  );
}
