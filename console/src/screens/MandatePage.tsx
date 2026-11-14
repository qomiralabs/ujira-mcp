// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

import { useCallback, useEffect, useRef, useState } from 'react';

import { explorerAccount, explorerContract, useApp } from '../app/context';
import { useAction, useResource } from '../app/hooks';
import { AgentPanel } from '../components/AgentPanel';
import { Approvals } from '../components/Approvals';
import { ReceiptsTable } from '../components/ReceiptsTable';
import { TopUpPanel } from '../components/TopUp';
import {
  Amount,
  BrandIcon,
  ConfirmDialog,
  CopyButton,
  ErrorNotice,
  Field,
  Notice,
  Skeleton,
  Spinner,
  StatusPill,
  TxLink,
} from '../components/ui';
import type { TxAction } from '../lib/api';
import { compareMinor, formatUsdc, parseAmount, percentOf } from '../lib/money';
import type { Mandate } from '../lib/schemas';
import { buildSignSubmit } from '../lib/sign';
import { shortAddress } from '../lib/strkey';
import { MANDATE_STATUS, mandateStatus } from '../lib/words';

const POLL_MS = 15_000;

function dateOf(seconds: number | string): string {
  const n = Number(seconds);
  if (!Number.isFinite(n) || n <= 0) return 'not set';
  return new Date(n * 1000).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

function BudgetMeter({ m }: { m: Mandate }) {
  const used = percentOf(m.state.spent, m.rules.budget);
  return (
    <div className="meter-block">
      <div className="meter-figures">
        <div>
          <p className="label">Held now</p>
          <Amount minor={m.state.balance} size="xl" />
        </div>
        <div className="meter-side">
          <p className="small">
            <span className="muted">Paid so far</span> <Amount minor={m.state.spent} />
          </p>
          <p className="small">
            <span className="muted">Left in the budget</span> <Amount minor={m.state.remaining} />
          </p>
        </div>
      </div>
      <div
        className="meter"
        role="img"
        aria-label={`${formatUsdc(m.state.spent)} of the ${formatUsdc(m.rules.budget)} budget paid, ${String(used)} percent`}
      >
        <span className="meter-used" style={{ width: `${String(used)}%` }} />
      </div>
      <p className="muted small">
        {used} percent of the {formatUsdc(m.rules.budget)} budget used.
      </p>
    </div>
  );
}

function Rules({ m }: { m: Mandate }) {
  const { config } = useApp();
  const rows: [string, string, string][] = [
    ['Total budget', formatUsdc(m.rules.budget), 'The most it can ever pay, all payouts together.'],
    ['Max per payment', formatUsdc(m.rules.perPaymentCap), 'Bigger payouts are blocked.'],
    ['Max per recipient per day', formatUsdc(m.rules.dailyCap), 'Per person, reset each day.'],
    [
      'Needs approval from',
      formatUsdc(m.rules.approvalThreshold),
      'These wait for the owner to approve.',
    ],
    ['Ends', dateOf(m.rules.expiresAt), 'After this it pays nothing.'],
  ];
  return (
    <section className="card" aria-labelledby="rules-title">
      <h2 id="rules-title" className="card-title">
        The rules
      </h2>
      <dl className="rules">
        {rows.map(([k, v, help]) => (
          <div key={k}>
            <dt>
              {k}
              <span className="muted small">{help}</span>
            </dt>
            <dd className="mono">{v}</dd>
          </div>
        ))}
      </dl>
      <h3 className="sub-title">Who can be paid</h3>
      {m.recipients.length === 0 ? (
        <p className="muted">Nobody yet, so every payout is blocked.</p>
      ) : (
        <ul className="recipient-list">
          {m.recipients.map((r) => (
            <li key={r.address}>
              <BrandIcon name="recipient" />
              <strong>{r.label}</strong>
              <a
                className="mono-link"
                href={explorerAccount(config, r.address)}
                target="_blank"
                rel="noreferrer"
                title={r.address}
              >
                {shortAddress(r.address)}
                <span className="sr-only"> (opens Stellar Expert)</span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

type RevokeStep = 'idle' | 'revoke' | 'sweep' | 'done';

function OwnerControls({ m, onChanged }: { m: Mandate; onChanged: () => void }) {
  const { api, config, wallet, notify } = useApp();
  const [lastTx, setLastTx] = useState<{ what: string; hash: string } | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const [revokeStep, setRevokeStep] = useState<RevokeStep>('idle');
  const [fund, setFund] = useState('10');
  const [fundError, setFundError] = useState<string | undefined>(undefined);
  const status = mandateStatus(m.state);
  const owner = wallet !== null && wallet.address === m.principal;
  const held = compareMinor(m.state.balance, '0') > 0;

  const act = useAction(async (action: TxAction, what: string, params: Record<string, unknown>) => {
    if (wallet === null) return;
    const res = await buildSignSubmit(api, config, wallet, action, params);
    setLastTx({ what, hash: res.hash });
    notify(what);
    onChanged();
  });

  // Revoking takes two signatures: the first stops the mandate for good, the
  // second moves what it still holds back to the owner's wallet.
  const revoke = useAction(async () => {
    if (wallet === null) return;
    if (status !== 'revoked') {
      setRevokeStep('revoke');
      const res = await buildSignSubmit(api, config, wallet, 'revoke', { mandate: m.id });
      setLastTx({ what: 'Step 1 of 2: the mandate is revoked.', hash: res.hash });
      onChanged();
    }
    if (held) {
      setRevokeStep('sweep');
      const res = await buildSignSubmit(api, config, wallet, 'sweep', { mandate: m.id });
      setLastTx({ what: 'Step 2 of 2: the funds are back in your wallet.', hash: res.hash });
    }
    setRevokeStep('done');
    setConfirmRevoke(false);
    notify('The mandate is revoked and its funds are back in your wallet.');
    onChanged();
  });

  if (!owner) {
    return (
      <section className="card" aria-labelledby="owner-title">
        <h2 id="owner-title" className="card-title">
          Owner controls
        </h2>
        <p className="muted">
          Only the owner wallet ({shortAddress(m.principal)}) can pause, resume, revoke or approve.
          {wallet === null ? ' Connect it to act.' : ' You are connected with a different wallet.'}
        </p>
      </section>
    );
  }

  const busy = act.busy || revoke.busy;
  const error = act.error ?? (confirmRevoke ? null : revoke.error);

  return (
    <section className="card" aria-labelledby="owner-title">
      <h2 id="owner-title" className="card-title">
        Owner controls
      </h2>
      <p className="muted">Each change is a transaction you sign in your wallet.</p>
      {status === 'revoked' || status === 'expired' ? (
        <>
          <p>{MANDATE_STATUS[status].help}</p>
          {held ? (
            <div className="stack-sm">
              <p className="small">
                It still holds {formatUsdc(m.state.balance)}. Sign once to move it back to your
                wallet.
              </p>
              <div className="actions">
                <button
                  type="button"
                  className="btn"
                  disabled={busy}
                  onClick={() =>
                    void act.run('sweep', 'The funds are back in your wallet.', { mandate: m.id })
                  }
                >
                  Return the funds
                </button>
              </div>
            </div>
          ) : null}
        </>
      ) : (
        <>
          <div className="actions">
            {status === 'paused' ? (
              <button
                type="button"
                className="btn"
                disabled={busy}
                onClick={() =>
                  void act.run('resume', 'The mandate is active again.', { mandate: m.id })
                }
              >
                <BrandIcon name="pause" size={18} />
                Resume payouts
              </button>
            ) : (
              <button
                type="button"
                className="btn"
                disabled={busy}
                onClick={() => void act.run('pause', 'The mandate is paused.', { mandate: m.id })}
              >
                <BrandIcon name="pause" size={18} />
                Pause payouts
              </button>
            )}
            <button
              type="button"
              className="btn btn-danger-ghost"
              disabled={busy}
              onClick={() => {
                revoke.clear();
                setRevokeStep('idle');
                setConfirmRevoke(true);
              }}
            >
              Revoke
            </button>
          </div>
          <p className="muted small">
            Pause blocks every payout until you resume. Revoke closes the mandate for good and
            returns what it holds to your wallet.
          </p>
          <form
            className="inline-form"
            onSubmit={(e) => {
              e.preventDefault();
              const p = parseAmount(fund);
              if (!p.ok) {
                setFundError(p.error);
                return;
              }
              if (p.minor === '0') {
                setFundError('Add more than zero.');
                return;
              }
              setFundError(undefined);
              void act.run('fund_mandate', `Added ${formatUsdc(p.minor)} to the mandate.`, {
                mandate: m.id,
                amount: p.minor,
              });
            }}
          >
            <Field
              label="Add test USDC"
              suffix="USDC"
              inputMode="decimal"
              value={fund}
              onChange={setFund}
              error={fundError}
            />
            <button type="submit" className="btn" disabled={busy}>
              Add funds
            </button>
          </form>
        </>
      )}
      <TopUpPanel
        wallet={wallet}
        intro={
          status === 'revoked' || status === 'expired'
            ? 'Want to try again with a new mandate? The faucet tops your wallet up with test USDC.'
            : 'Wallet running low? The faucet tops it up with test USDC, then add funds above.'
        }
      />
      {act.busy ? (
        <p className="muted small" role="status">
          <Spinner /> Waiting for your wallet, then for Stellar.
        </p>
      ) : null}
      {error === null ? null : <ErrorNotice error={error} />}
      {lastTx === null ? null : (
        <p className="small">
          {lastTx.what} <TxLink hash={lastTx.hash} />
        </p>
      )}
      <ConfirmDialog
        open={confirmRevoke}
        title="Revoke this mandate?"
        confirmLabel={revoke.error === null ? 'Revoke and return funds' : 'Try again'}
        danger
        busy={revoke.busy}
        onCancel={() => {
          setConfirmRevoke(false);
        }}
        onConfirm={() => void revoke.run()}
      >
        <p>
          It stops for good and payouts waiting for approval are cancelled. This cannot be undone.
          Your wallet asks you to sign twice:
        </p>
        <ol className="numbered">
          <li>
            <strong>Revoke.</strong> Stops the mandate.
            {revokeStep === 'sweep' || revokeStep === 'done' ? ' Done.' : null}
          </li>
          <li>
            <strong>Return the funds.</strong> Moves the {formatUsdc(m.state.balance)} it holds back
            to your wallet.
            {revokeStep === 'done' ? ' Done.' : null}
          </li>
        </ol>
        {revoke.busy ? (
          <p className="muted small" role="status">
            <Spinner />{' '}
            {revokeStep === 'sweep'
              ? 'Step 2 of 2: sign in your wallet to return the funds.'
              : 'Step 1 of 2: sign in your wallet to revoke.'}
          </p>
        ) : null}
        {revoke.error === null ? null : <ErrorNotice error={revoke.error} />}
      </ConfirmDialog>
    </section>
  );
}

function ConnectClaude({ m }: { m: Mandate }) {
  const first = m.recipients[0]?.label ?? 'a recipient';
  return (
    <section className="card" aria-labelledby="claude-title">
      <h2 id="claude-title" className="card-title">
        Connect Claude
      </h2>
      <p className="muted">
        Let Claude act as the agent for this mandate. It can quote, request payouts, check their
        status and list receipts, and nothing more.
      </p>
      <div className="copy-row">
        <label className="sr-only" htmlFor="mcp-url">
          MCP address for this mandate
        </label>
        <input
          id="mcp-url"
          className="mono"
          readOnly
          value={m.mcpUrl}
          onFocus={(e) => {
            e.target.select();
          }}
        />
        <CopyButton text={m.mcpUrl} label="Copy address" />
      </div>
      <ol className="numbered">
        <li>In Claude, open Settings, then Connectors.</li>
        <li>
          Choose Add custom connector, paste the address above and save. No sign in is needed.
        </li>
        <li>
          Ask in a chat, for example: &ldquo;Quote 2 USDC to {first} for task demo-1, then pay
          it.&rdquo; Payouts at or above {formatUsdc(m.rules.approvalThreshold)} wait for your
          approval here.
        </li>
      </ol>
    </section>
  );
}

export function MandatePage({ id }: { id: string }) {
  const { api, config } = useApp();
  const mandate = useResource(`mandate:${id}`, () => api.mandate(id), POLL_MS);
  const payouts = useResource(`payouts:${id}`, () => api.payouts(id), POLL_MS);
  const receipts = useResource(`receipts:${id}`, () => api.receipts(id), POLL_MS);
  const followUp = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reloadMandate = mandate.reload;
  const reloadPayouts = payouts.reload;
  const reloadReceipts = receipts.reload;

  const refresh = useCallback(() => {
    reloadMandate();
    reloadPayouts();
    reloadReceipts();
    // Chain state can trail a finished request by a ledger; look once more.
    if (followUp.current !== null) clearTimeout(followUp.current);
    followUp.current = setTimeout(() => {
      reloadMandate();
      reloadPayouts();
      reloadReceipts();
    }, 4000);
  }, [reloadMandate, reloadPayouts, reloadReceipts]);

  useEffect(
    () => () => {
      if (followUp.current !== null) clearTimeout(followUp.current);
    },
    [],
  );

  const m = mandate.data;
  if (m === undefined) {
    return (
      <div className="stack">
        <a href="#/" className="back">
          &larr; Your mandates
        </a>
        <h1>Mandate</h1>
        {mandate.error === null ? (
          <Skeleton lines={5} label="Loading the mandate" />
        ) : (
          <ErrorNotice error={mandate.error} onRetry={mandate.reload} />
        )}
      </div>
    );
  }

  const status = mandateStatus(m.state);
  const word = MANDATE_STATUS[status];
  const lowBalance =
    compareMinor(m.state.balance, m.rules.perPaymentCap) < 0 && status === 'active';

  return (
    <div className="stack">
      <div className="page-head">
        <a href="#/" className="back">
          &larr; Your mandates
        </a>
        <div className="title-row">
          <h1>
            Mandate <span className="mono title-id">{shortAddress(m.id, 6)}</span>
          </h1>
          <StatusPill tone={word.tone}>{word.label}</StatusPill>
        </div>
        <p className="muted">
          {word.help}{' '}
          <a
            href={m.explorerContractUrl ?? explorerContract(config, m.id)}
            target="_blank"
            rel="noreferrer"
          >
            See the contract on Stellar Expert<span className="sr-only"> (opens in a new tab)</span>
          </a>
          <span className="id-copy">
            <CopyButton text={m.id} label="Copy mandate ID" />
          </span>
        </p>
      </div>
      {mandate.error === null ? null : (
        <Notice tone="waiting">
          <p>Could not refresh just now: {mandate.error} Showing the last known state.</p>
        </Notice>
      )}
      <div className="grid-2">
        <section className="card" aria-labelledby="money-title">
          <h2 id="money-title" className="card-title">
            Money
          </h2>
          <BudgetMeter m={m} />
          {lowBalance ? (
            <p className="small warn-text">
              It holds less than one max payment. Add funds below, or larger payouts will be blocked
              for lack of funds.
            </p>
          ) : null}
        </section>
        <Rules m={m} />
      </div>
      <div className="grid-2">
        <AgentPanel m={m} onDone={refresh} />
        <Approvals
          m={m}
          payouts={payouts.data}
          loading={payouts.loading}
          error={payouts.error}
          onRetry={payouts.reload}
          onDone={refresh}
        />
      </div>
      <ReceiptsTable
        m={m}
        receipts={receipts.data}
        loading={receipts.loading}
        error={receipts.error}
        onRetry={receipts.reload}
      />
      <div className="grid-2">
        <OwnerControls m={m} onChanged={refresh} />
        <ConnectClaude m={m} />
      </div>
    </div>
  );
}
