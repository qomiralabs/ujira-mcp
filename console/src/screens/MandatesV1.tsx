// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The mandate list and the mandate page on /v1. Everything shown is what the
// server read from the chain; an action changes the page only once the
// server shows the change.

import { useState } from 'react';

import { explorerContract, useApp } from '../app/context';
import { useAction, useResource } from '../app/hooks';
import { Link } from '../components/Link';
import { MandateMeter } from '../components/MandateMeter';
import { RecipientPicker } from '../components/RecipientPicker';
import { SignPanel, readUntil, signLabel, useV1Signing } from '../components/V1Sign';
import {
  Amount,
  BrandIcon,
  ConfirmDialog,
  Empty,
  ErrorNotice,
  Field,
  Icon,
  IdText,
  Notice,
  Skeleton,
  SoonRow,
  SoonTag,
  StatusPill,
  Tip,
} from '../components/ui';
import { mandateName, nameMatches, showsAction, statusOf } from '../lib/mandateV1';
import { formatToken, parseAmount } from '../lib/money';
import { shortAddress } from '../lib/strkey';
import type { MandateActionInput, V1Api } from '../lib/v1';
import type { V1Mandate } from '../lib/v1Schemas';
import { WALLET_NAMES } from '../lib/wallet';
import { MANDATE_STATUS } from '../lib/words';

const POLL_MS = 15_000;
const PAGE = 20;

function dateOf(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

function hoursOf(seconds: number): string {
  const h = Math.round(seconds / 3600);
  return h === 1 ? '1 hour' : `${String(h)} hours`;
}

function CreateLink({ small = false }: { small?: boolean }) {
  return (
    <Link to="/mandates/new" className={small ? 'btn btn-primary btn-small' : 'btn btn-primary'}>
      <Icon name="plus" size={small ? 16 : 18} />
      Create a mandate
    </Link>
  );
}

function MandateRow({ m }: { m: V1Mandate }) {
  const status = MANDATE_STATUS[statusOf(m)];
  const date = dateOf(m.createdAt);
  return (
    <li>
      <Link to={`/mandates/${m.id}`} className="mandate-link mandate-link-full">
        <span className="mandate-icon">
          <BrandIcon name="mandate" />
        </span>
        <span className="mandate-main">
          <span className="mandate-id">
            <strong className="mandate-name">{mandateName(m)}</strong>
            <StatusPill tone={status.tone}>{status.label}</StatusPill>
          </span>
          {date === '' ? null : <span className="muted small">{date}</span>}
        </span>
        <MandateMeter m={m} compact />
        <span className="mandate-money">
          <Amount token={m.state.balance} />
          <span className="muted small">held</span>
        </span>
        <Icon name="arrow" size={18} />
      </Link>
    </li>
  );
}

/** Every mandate in the open project, newest first. */
export function MandatesV1({ v1, projectId }: { v1: V1Api; projectId: string }) {
  const first = useResource(
    `v1:mandates:${projectId}`,
    () => v1.mandates({ limit: PAGE }),
    POLL_MS,
  );
  const [more, setMore] = useState<{ items: V1Mandate[]; cursor: string | null } | null>(null);
  const cursor = more === null ? (first.data?.nextCursor ?? null) : more.cursor;
  const loadMore = useAction(async () => {
    if (cursor === null) return;
    const page = await v1.mandates({ cursor, limit: PAGE });
    setMore((m) => ({ items: [...(m?.items ?? []), ...page.items], cursor: page.nextCursor }));
  });
  const seen = new Set<string>();
  const items = [...(first.data?.items ?? []), ...(more?.items ?? [])].filter((m) => {
    if (seen.has(m.id)) return false;
    seen.add(m.id);
    return true;
  });

  return (
    <div className="stack">
      <div className="toolbar">
        <CreateLink />
      </div>
      {first.error !== null && first.data !== undefined ? (
        <Notice tone="waiting">
          <p>Could not refresh: {first.error} Showing the last known state.</p>
        </Notice>
      ) : null}
      <section className="card" aria-labelledby="mandates-title">
        <h2 id="mandates-title" className="card-title">
          Your mandates
        </h2>
        {first.loading ? (
          <Skeleton lines={3} label="Loading your mandates" />
        ) : first.data === undefined ? (
          <ErrorNotice
            error={first.error ?? 'Not loaded.'}
            onRetry={first.reload}
            requestId={first.errorRequestId}
          />
        ) : items.length === 0 ? (
          <Empty text="No mandates yet." action={<CreateLink small />} />
        ) : (
          <ul className="mandate-list">
            {items.map((m) => (
              <MandateRow key={m.id} m={m} />
            ))}
          </ul>
        )}
        {cursor === null || first.data === undefined ? null : (
          <div className="actions">
            <button
              type="button"
              className="btn btn-small"
              disabled={loadMore.busy}
              onClick={() => void loadMore.run()}
            >
              Show more
            </button>
          </div>
        )}
        {loadMore.error === null ? null : <ErrorNotice error={loadMore.error} />}
      </section>
      <SoonRow title="Mandates next" items={['Import a mandate', 'Approve as a team']} />
    </div>
  );
}

function Rules({ m }: { m: V1Mandate }) {
  const l = m.config.limits;
  const rows: [string, string][] = [
    ['Total budget', formatToken(l.totalBudget)],
    ['Max per payment', formatToken(l.perPaymentCap)],
    ['Daily cap per person', formatToken(l.perRecipientDailyCap)],
    ['Approval from', formatToken(l.approvalThreshold)],
    ['Approval waits up to', hoursOf(l.payoutTtlSeconds)],
    ['Ends', dateOf(l.expiresAt) === '' ? 'Not set' : dateOf(l.expiresAt)],
  ];
  return (
    <section className="card" aria-labelledby="rules-title">
      <div className="card-head">
        <h2 id="rules-title" className="card-title">
          The rules
        </h2>
        <span className="soon-inline">
          Edit <SoonTag />
        </span>
      </div>
      <dl className="rules">
        {rows.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
        <div>
          <dt>Deposit address</dt>
          <dd>
            <IdText value={m.depositAddress} copyLabel="Copy the deposit address" />
          </dd>
        </div>
      </dl>
    </section>
  );
}

type Active = 'pause' | 'resume' | 'revoke' | 'fund' | 'withdraw' | 'allow';

function amountProblem(input: string, scale: number): { minor?: bigint; error?: string } {
  const p = parseAmount(input, scale);
  if (!p.ok) return { error: p.error };
  if (p.minor === '0') return { error: 'Enter more than zero.' };
  return { minor: BigInt(p.minor) };
}

function OwnerControls({
  m,
  v1,
  projectId,
  onChanged,
}: {
  m: V1Mandate;
  v1: V1Api;
  projectId: string;
  onChanged: () => void;
}) {
  const { wallet, notify } = useApp();
  const signing = useV1Signing(v1);
  const [active, setActive] = useState<Active | null>(null);
  const [done, setDone] = useState('Done.');
  const [revokeOpen, setRevokeOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const [fund, setFund] = useState('10');
  const [fundError, setFundError] = useState<string | undefined>(undefined);
  const [withdraw, setWithdraw] = useState('');
  const [withdrawError, setWithdrawError] = useState<string | undefined>(undefined);
  const [allow, setAllow] = useState<ReadonlySet<string>>(new Set());
  const status = statusOf(m);
  const name = mandateName(m);
  const owner = wallet !== null && wallet.address === m.config.principal;
  const walletName = wallet === null ? 'your wallet' : WALLET_NAMES[wallet.kind];
  const scale = m.state.balance.scale;

  const run = (kind: Active, action: MandateActionInput, doneText: string, after?: () => void) => {
    setActive(kind);
    setDone(doneText);
    signing.start({
      prepare: () => v1.mandateAction(m.id, action),
      confirm: () =>
        readUntil(
          () => v1.mandate(m.id),
          (x) => showsAction(action.kind, x),
        ),
      onDone: () => {
        notify(doneText);
        after?.();
        onChanged();
      },
    });
  };

  if (!owner) {
    return (
      <section className="card" aria-labelledby="owner-title">
        <h2 id="owner-title" className="card-title">
          Owner controls
        </h2>
        <p className="muted small">
          Only the owner wallet ({shortAddress(m.config.principal)}) can change this mandate.
          {wallet === null ? ' Connect it to act.' : ' You are connected with another wallet.'}
        </p>
      </section>
    );
  }

  const busy = signing.busy;
  const free = m.state.free;
  const closed = status === 'revoked' || status === 'expired';

  const withdrawForm =
    free.amount > 0n ? (
      <form
        className="inline-form"
        onSubmit={(e) => {
          e.preventDefault();
          const a = amountProblem(withdraw, scale);
          if (a.minor === undefined) {
            setWithdrawError(a.error);
            return;
          }
          if (a.minor > free.amount) {
            setWithdrawError(`The most you can take back now is ${formatToken(free)}.`);
            return;
          }
          setWithdrawError(undefined);
          const back = { ...free, amount: a.minor };
          run(
            'withdraw',
            { kind: 'withdraw', amount: a.minor },
            `${formatToken(back)} is back in your wallet.`,
            () => {
              setWithdraw('');
            },
          );
        }}
      >
        <Field
          label="Take back"
          suffix={free.asset}
          inputMode="decimal"
          value={withdraw}
          onChange={setWithdraw}
          error={withdrawError}
          help={`${formatToken(free)} free`}
        />
        <button type="submit" className="btn" disabled={busy}>
          Return to wallet
        </button>
      </form>
    ) : null;

  return (
    <section className="card" aria-labelledby="owner-title">
      <div className="card-head">
        <h2 id="owner-title" className="card-title">
          Owner controls
        </h2>
        <span className="assure">
          <Icon name="lock" size={15} />
          Your wallet signs
        </span>
      </div>
      {closed ? (
        <>
          <p className="small">{MANDATE_STATUS[status].help}</p>
          {withdrawForm}
        </>
      ) : (
        <>
          <div className="actions">
            {status === 'paused' ? (
              <button
                type="button"
                className="btn"
                disabled={busy}
                onClick={() => {
                  run('resume', { kind: 'resume' }, 'The mandate is active again.');
                }}
              >
                <BrandIcon name="pause" size={18} />
                Resume payouts
              </button>
            ) : (
              <button
                type="button"
                className="btn"
                disabled={busy}
                onClick={() => {
                  run('pause', { kind: 'pause' }, 'The mandate is paused.');
                }}
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
                signing.reset();
                setTyped('');
                setActive('revoke');
                setRevokeOpen(true);
              }}
            >
              Revoke
            </button>
            <Tip
              label="Pause and revoke"
              text="Pause blocks every payout until you resume. Revoke closes the mandate for good."
            />
          </div>
          <form
            className="inline-form"
            onSubmit={(e) => {
              e.preventDefault();
              const a = amountProblem(fund, scale);
              if (a.minor === undefined) {
                setFundError(a.error);
                return;
              }
              setFundError(undefined);
              const added = { ...m.state.balance, amount: a.minor };
              run(
                'fund',
                { kind: 'fund', amount: a.minor },
                `Added ${formatToken(added)} to the mandate.`,
              );
            }}
          >
            <Field
              label="Add funds"
              suffix={m.state.balance.asset}
              inputMode="decimal"
              value={fund}
              onChange={setFund}
              error={fundError}
            />
            <button type="submit" className="btn" disabled={busy}>
              Add funds
            </button>
          </form>
          {withdrawForm}
          <form
            className="stack-sm"
            onSubmit={(e) => {
              e.preventDefault();
              const ids = [...allow];
              if (ids.length === 0) return;
              run(
                'allow',
                { kind: 'allow_recipients', recipientIds: ids },
                ids.length === 1
                  ? 'One more recipient can be paid.'
                  : 'More recipients can be paid.',
                () => {
                  setAllow(new Set());
                },
              );
            }}
          >
            <RecipientPicker
              v1={v1}
              projectId={projectId}
              mandateId={m.id}
              legend="Allow recipients"
              selected={allow}
              onChange={setAllow}
              disabled={busy}
            />
            {allow.size === 0 ? null : (
              <div className="actions">
                <button type="submit" className="btn" disabled={busy}>
                  {allow.size === 1
                    ? 'Allow 1 recipient'
                    : `Allow ${String(allow.size)} recipients`}
                </button>
              </div>
            )}
          </form>
        </>
      )}
      {active === 'revoke' ? null : <SignPanel signing={signing} done={done} />}
      <ConfirmDialog
        open={revokeOpen}
        title={`Revoke ${name}?`}
        confirmLabel={signLabel(signing, 'Revoke for good', walletName)}
        danger
        busy={signing.busy && signing.phase.kind !== 'ready'}
        confirmDisabled={!nameMatches(typed, name)}
        onCancel={() => {
          setRevokeOpen(false);
          signing.reset();
          setActive(null);
        }}
        onConfirm={() => {
          if (signing.phase.kind === 'ready') {
            signing.sign();
            return;
          }
          setDone('The mandate is revoked.');
          signing.start({
            prepare: () => v1.mandateAction(m.id, { kind: 'revoke' }),
            confirm: () =>
              readUntil(
                () => v1.mandate(m.id),
                (x) => showsAction('revoke', x),
              ),
            onDone: () => {
              setRevokeOpen(false);
              setActive(null);
              notify('The mandate is revoked.');
              onChanged();
            },
          });
        }}
      >
        <p>It stops for good and can never pay again. This cannot be undone.</p>
        <Field
          label={`Type ${name} to confirm`}
          value={typed}
          onChange={setTyped}
          autoComplete="off"
        />
        {active === 'revoke' ? (
          <SignPanel signing={signing} done="The mandate is revoked." showSignButton={false} />
        ) : null}
      </ConfirmDialog>
    </section>
  );
}

function BackLink() {
  return (
    <Link to="/mandates" className="back">
      <Icon name="back" size={16} />
      Mandates
    </Link>
  );
}

/** One mandate: its money, its rules and what its owner can do. */
export function MandateV1({ v1, projectId, id }: { v1: V1Api; projectId: string; id: string }) {
  const { config } = useApp();
  const mandate = useResource(`v1:mandate:${projectId}:${id}`, () => v1.mandate(id), POLL_MS);
  const m = mandate.data;
  if (m === undefined) {
    return (
      <div className="stack">
        <BackLink />
        {mandate.error === null ? (
          <Skeleton lines={5} label="Loading the mandate" />
        ) : (
          <ErrorNotice
            error={mandate.error}
            onRetry={mandate.reload}
            requestId={mandate.errorRequestId}
          />
        )}
      </div>
    );
  }
  const word = MANDATE_STATUS[statusOf(m)];
  return (
    <div className="stack">
      <div className="page-head">
        <BackLink />
        <div className="title-row">
          <h2 className="title-name">{mandateName(m)}</h2>
          <StatusPill tone={word.tone}>{word.label}</StatusPill>
          <IdText value={m.contractId} copyLabel="Copy the contract address" />
          <a
            className="card-link"
            href={explorerContract(config, m.contractId)}
            target="_blank"
            rel="noreferrer"
          >
            Stellar Expert
            <Icon name="external" size={15} />
            <span className="sr-only"> (opens the contract in a new tab)</span>
          </a>
        </div>
      </div>
      {mandate.error === null ? null : (
        <Notice tone="waiting">
          <p>Could not refresh: {mandate.error} Showing the last known state.</p>
        </Notice>
      )}
      <div className="mandate-grid">
        <div className="mandate-col">
          <div className="slot slot-held">
            <section className="card balance balance-card" aria-labelledby="money-title">
              <h2 id="money-title" className="sr-only">
                Money
              </h2>
              <p className="balance-label">Held now</p>
              <p className="balance-value">
                <Amount token={m.state.balance} size="xl" />
              </p>
              <MandateMeter m={m} />
            </section>
          </div>
          <div className="slot slot-owner">
            <OwnerControls m={m} v1={v1} projectId={projectId} onChanged={mandate.reload} />
          </div>
        </div>
        <div className="mandate-col">
          <div className="slot slot-rules">
            <Rules m={m} />
          </div>
        </div>
      </div>
      <SoonRow title="On this page next" items={['Agent', 'Approvals', 'Receipts']} />
    </div>
  );
}
