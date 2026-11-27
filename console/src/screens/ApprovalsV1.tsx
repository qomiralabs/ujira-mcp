// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The approvals queue on /v1: every payout in the open project that waits
// for a person, oldest first, one line each. Approve and reject say the
// amount and the recipient once more, then the server builds the request for
// the approver's wallet. Nothing leaves the queue until the server shows the
// decision; until then the row says it is waiting for Stellar.

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { useApp } from '../app/context';
import { replaceSearch, useAllPages, useSearch } from '../app/hooks';
import { useSession } from '../app/session';
import { Link } from '../components/Link';
import { PayoutSheet } from '../components/PayoutSheet';
import { SignPanel, readUntil, signLabel, useV1Signing } from '../components/V1Sign';
import {
  Amount,
  ConfirmDialog,
  CopyButton,
  Empty,
  ErrorNotice,
  Notice,
  Skeleton,
  SoonRow,
  Spinner,
  StatusPill,
  Tip,
  TxLink,
} from '../components/ui';
import {
  budgetLeft,
  oldestFirst,
  openOf,
  ruleText,
  shortcutOf,
  signRight,
  stepId,
  withOpen,
  type Decision,
  type SignRight,
} from '../lib/approvalsV1';
import { mandateName } from '../lib/mandateV1';
import { formatToken } from '../lib/money';
import type { V1Api } from '../lib/v1';
import type { PayoutDetail, V1Mandate } from '../lib/v1Schemas';
import { WALLET_NAMES } from '../lib/wallet';
import { statusWord } from '../lib/words';

const PAGE_LIMIT = 200;
const CAP = 1_000;
const POLL_MS = 10_000;
const COLUMNS = 7;

const VERB: Record<Decision, string> = { approve: 'Approve', reject: 'Reject' };
const DONE: Record<Decision, string> = { approve: 'Approved', reject: 'Rejected' };

function plural(n: number): string {
  return n === 1 ? '1 payout' : `${n.toLocaleString('en-US')} payouts`;
}

function focusRow(id: string): void {
  const el = document.querySelector(`[data-approval="${id}"]`);
  if (el instanceof HTMLElement) el.focus();
}

/** How long the screen reads a payout back after signing before it says the chain is ahead. */
export interface ReadBack {
  readonly tries: number;
  readonly intervalMs: number;
}

const READ_BACK: ReadBack = { tries: 10, intervalMs: 2000 };

function ApprovalRow({
  p,
  m,
  checking,
  right,
  v1,
  selected,
  asked,
  readBack,
  onAsk,
  onSelect,
  onOpen,
  onSettled,
}: {
  p: PayoutDetail;
  m: V1Mandate | undefined;
  /** True while the mandates are still loading, so the right to sign is not known yet. */
  checking: boolean;
  right: SignRight;
  v1: V1Api;
  selected: boolean;
  asked: Decision | null;
  readBack: ReadBack;
  onAsk: (id: string, kind: Decision | null) => void;
  onSelect: (id: string) => void;
  onOpen: (id: string) => void;
  onSettled: () => void;
}) {
  const { wallet, notify } = useApp();
  const signing = useV1Signing(v1);
  const [kind, setKind] = useState<Decision>('approve');
  const walletName = wallet === null ? 'your wallet' : WALLET_NAMES[wallet.kind];
  const amount = formatToken(p.amount);
  const to = p.recipient.label;
  const phase = signing.phase.kind;
  // Once the wallet has signed, or the decision is in, there is nothing left to confirm.
  const sent = phase === 'confirming' || phase === 'done';
  const canAsk = right.ok && !checking && !sent;
  const shown = asked ?? kind;

  // A or R, a button in the sheet, or a click: the confirm opens, or the reason is said.
  const latest = useRef({ canAsk, right, notify, onAsk, reset: signing.reset });
  useEffect(() => {
    latest.current = { canAsk, right, notify, onAsk, reset: signing.reset };
  });
  useEffect(() => {
    if (asked === null) return;
    const now = latest.current;
    if (now.canAsk) {
      now.reset();
      return;
    }
    now.onAsk(p.id, null);
    if (!now.right.ok) now.notify(now.right.reason);
  }, [asked, p.id]);
  useEffect(() => {
    if (sent && asked !== null) onAsk(p.id, null);
  }, [sent, asked, onAsk, p.id]);

  const confirm = () => {
    if (signing.phase.kind === 'ready') {
      signing.sign();
      return;
    }
    const decision = shown;
    setKind(decision);
    signing.start({
      prepare: () => v1.mandateAction(p.mandate.id, { kind: decision, payoutId: p.id }),
      confirm: () =>
        readUntil(
          () => v1.payout(p.id),
          (x) => x.status !== 'pending_approval',
          readBack,
        ),
      onDone: (_submitted, caughtUp) => {
        notify(
          caughtUp
            ? `${DONE[decision]} ${amount} to ${to}.`
            : 'Stellar has it. The queue catches up in a moment.',
        );
        onSettled();
      },
    });
  };

  const word = statusWord(p.status);
  const short = p.id.slice(0, 8);

  let pill = <StatusPill tone={word.tone}>{word.label}</StatusPill>;
  if (phase === 'confirming') pill = <StatusPill tone="waiting">Waiting for Stellar</StatusPill>;
  else if (phase === 'done') pill = <StatusPill tone="waiting">Signed</StatusPill>;

  let act: ReactNode;
  if (signing.phase.kind === 'done') {
    act = <TxLink hash={signing.phase.txHash} />;
  } else if (phase === 'confirming') {
    act = (
      <span className="muted small">
        <Spinner /> {DONE[kind]}
      </span>
    );
  } else if (checking && m === undefined) {
    act = (
      <span className="muted small">
        <Spinner /> Checking
      </span>
    );
  } else if (!right.ok) {
    act = (
      <span className="status-cell muted small">
        {right.short}
        <Tip text={right.reason} label="Why you cannot sign" />
      </span>
    );
  } else {
    act = (
      <span className="row-actions">
        <button
          type="button"
          className="btn btn-primary btn-small"
          aria-keyshortcuts="A"
          aria-label={`Approve ${amount} to ${to}`}
          disabled={signing.busy}
          onClick={() => {
            onSelect(p.id);
            onAsk(p.id, 'approve');
          }}
        >
          Approve
        </button>
        <button
          type="button"
          className="btn btn-danger-ghost btn-small"
          aria-keyshortcuts="R"
          aria-label={`Reject ${amount} to ${to}`}
          disabled={signing.busy}
          onClick={() => {
            onSelect(p.id);
            onAsk(p.id, 'reject');
          }}
        >
          Reject
        </button>
      </span>
    );
  }

  return (
    <>
      <tr
        className={`prow arow${selected ? ' arow-on' : ''}`}
        onClick={(e) => {
          // Links, buttons and the confirm dialog in the row do their own thing.
          if (e.target instanceof Element && e.target.closest('a, button, dialog') !== null) return;
          onSelect(p.id);
          onOpen(p.id);
        }}
      >
        <td className="c-id">
          <span className="id-text">
            <button
              type="button"
              className="row-open mono"
              data-approval={p.id}
              aria-label={`Open payout ${short}`}
              title={p.id}
              onFocus={() => {
                onSelect(p.id);
              }}
              onClick={() => {
                onOpen(p.id);
              }}
            >
              {short}
            </button>
            <CopyButton text={p.id} label={`Copy payout ID ${short}`} icon />
          </span>
        </td>
        <td className="c-amount num">
          <Amount token={p.amount} />
        </td>
        <td className="c-to">{to}</td>
        <td className="c-rule">{m === undefined ? null : ruleText(m)}</td>
        <td className="c-left num">{m === undefined ? null : <Amount token={budgetLeft(m)} />}</td>
        <td className="c-status">{pill}</td>
        <td className="c-act">
          {act}
          {/* A table body cannot hold a dialog, so it sits in the row's last cell. */}
          <ConfirmDialog
            open={asked !== null && canAsk}
            title={`${VERB[shown]} ${amount} to ${to}?`}
            confirmLabel={signLabel(signing, VERB[shown], walletName)}
            danger={shown === 'reject'}
            busy={signing.busy && signing.phase.kind !== 'ready'}
            onCancel={() => {
              signing.reset();
              onAsk(p.id, null);
            }}
            onConfirm={confirm}
          >
            <p>
              {shown === 'approve'
                ? `${mandateName(m ?? { name: null, contractId: p.mandate.contractId })} pays it once Stellar confirms.`
                : 'It will never be paid. The agent can ask again only with a new task ID.'}
            </p>
            <p className="muted small">
              Task <span className="mono">{p.taskId}</span>
            </p>
            <SignPanel signing={signing} done={`${DONE[shown]}.`} showSignButton={false} />
          </ConfirmDialog>
        </td>
      </tr>
      {/* A failure after the dialog closed shows under its row. */}
      {asked === null && signing.phase.kind === 'error' ? (
        <tr className="arow-error">
          <td colSpan={COLUMNS}>
            <ErrorNotice
              error={signing.phase.error}
              onRetry={signing.retry}
              requestId={signing.phase.requestId}
            />
          </td>
        </tr>
      ) : null}
    </>
  );
}

function SheetActions({ right, onAsk }: { right: SignRight; onAsk: (kind: Decision) => void }) {
  if (!right.ok) return <p className="muted small sheet-cta">{right.reason}</p>;
  return (
    <div className="actions sheet-cta">
      <button
        type="button"
        className="btn btn-primary btn-small"
        onClick={() => {
          onAsk('approve');
        }}
      >
        Approve
      </button>
      <button
        type="button"
        className="btn btn-danger-ghost btn-small"
        onClick={() => {
          onAsk('reject');
        }}
      >
        Reject
      </button>
    </div>
  );
}

/** Every payout in the open project that waits for a person, oldest first. */
export function ApprovalsV1({
  v1,
  projectId,
  readBack = READ_BACK,
}: {
  v1: V1Api;
  projectId: string;
  /** How long a decision is read back; shorter in tests. */
  readBack?: ReadBack;
}) {
  const session = useSession();
  const member = session?.member.address ?? null;
  const search = useSearch();
  const open = openOf(search);

  const list = useAllPages(
    `v1:approvals:${projectId}`,
    (cursor) => v1.approvals({ cursor, limit: PAGE_LIMIT }),
    { cap: CAP, pollMs: POLL_MS },
  );
  const mandates = useAllPages(
    `v1:approval-mandates:${projectId}`,
    (cursor) => v1.mandates({ cursor, limit: PAGE_LIMIT }),
    { cap: CAP, pollMs: POLL_MS },
  );
  const byId = useMemo(() => {
    const map = new Map<string, V1Mandate>();
    for (const m of mandates.items ?? []) map.set(m.id, m);
    return map;
  }, [mandates.items]);
  const rows = useMemo(() => oldestFirst(list.items ?? []), [list.items]);
  const ids = useMemo(() => rows.map((p) => p.id), [rows]);

  const [selected, setSelected] = useState<string | null>(null);
  const [asked, setAsked] = useState<{ id: string; kind: Decision } | null>(null);
  // The key handler is added once and reads the queue through these.
  const selectedRef = useRef(selected);
  const idsRef = useRef(ids);
  useEffect(() => {
    selectedRef.current = selected;
    idsRef.current = ids;
  });

  const onAsk = useCallback((id: string, kind: Decision | null) => {
    setAsked((now) => (kind === null ? (now?.id === id ? null : now) : { id, kind }));
  }, []);
  const onOpen = useCallback((id: string) => {
    replaceSearch(withOpen(location.search, id));
  }, []);
  const onClose = useCallback(() => {
    const id = openOf(location.search);
    replaceSearch(withOpen(location.search, null));
    setTimeout(() => {
      if (id !== null) focusRow(id);
    }, 0);
  }, []);
  const { reload: reloadList } = list;
  const { reload: reloadMandates } = mandates;
  const onSettled = useCallback(() => {
    reloadList();
    reloadMandates();
  }, [reloadList, reloadMandates]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const move = shortcutOf(e);
      if (move === null) return;
      // A dialog or the sheet has the keyboard while it is open.
      if (document.querySelector('dialog[open]') !== null) return;
      if (move === 'next' || move === 'previous') {
        const id = stepId(idsRef.current, selectedRef.current, move === 'next' ? 1 : -1);
        if (id === null) return;
        e.preventDefault();
        selectedRef.current = id;
        setSelected(id);
        focusRow(id);
        return;
      }
      const id = selectedRef.current;
      if (id === null || !idsRef.current.includes(id)) return;
      e.preventDefault();
      setAsked({ id, kind: move });
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
    };
  }, []);

  const rightOf = (p: PayoutDetail) => signRight(byId.get(p.mandate.id), member);
  const checking = mandates.loading || (!mandates.complete && mandates.error === null);
  const items = list.items;
  const mandateLabel = (p: PayoutDetail) =>
    mandateName(byId.get(p.mandate.id) ?? { name: null, contractId: p.mandate.contractId });

  return (
    <div className="stack">
      {list.error !== null && items !== undefined ? (
        <Notice tone="waiting">
          <p>Could not refresh: {list.error} Showing the last known state.</p>
        </Notice>
      ) : null}
      {mandates.error !== null && items !== undefined && items.length > 0 ? (
        <ErrorNotice
          error={`Could not read the mandates. ${mandates.error}`}
          onRetry={mandates.reload}
          requestId={mandates.errorRequestId}
        />
      ) : null}
      <section className="card card-flush" aria-labelledby="approvals-title">
        <div className="card-head">
          <h2 id="approvals-title" className="card-title">
            Waiting
            {items === undefined ? null : (
              <span className="title-count" aria-live="polite">
                {plural(rows.length)}
              </span>
            )}
          </h2>
          {rows.length === 0 ? null : (
            <p className="kbd-hint">
              <kbd>J</kbd>
              <kbd>K</kbd> move <kbd>A</kbd> approve <kbd>R</kbd> reject
            </p>
          )}
        </div>
        {list.loading ? (
          <Skeleton lines={3} label="Loading approvals" />
        ) : items === undefined ? (
          <ErrorNotice
            error={list.error ?? 'Not loaded.'}
            onRetry={list.reload}
            requestId={list.errorRequestId}
          />
        ) : rows.length === 0 ? (
          <Empty
            text="Nothing waiting for approval."
            action={
              <Link to="/payouts" className="btn btn-small">
                See payouts
              </Link>
            }
          />
        ) : (
          <div
            className="table-wrap approvals-scroll"
            role="region"
            aria-label="Approvals queue"
            tabIndex={0}
          >
            <table className="ledger approvals-table">
              <thead>
                <tr>
                  <th scope="col" className="c-id">
                    Payout
                  </th>
                  <th scope="col" className="c-amount num">
                    Amount
                  </th>
                  <th scope="col" className="c-to">
                    To
                  </th>
                  <th scope="col" className="c-rule">
                    Rule
                  </th>
                  <th scope="col" className="c-left num">
                    Budget left
                  </th>
                  <th scope="col" className="c-status">
                    Status
                  </th>
                  <th scope="col" className="c-act">
                    <span className="sr-only">Decide</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((p) => (
                  <ApprovalRow
                    key={p.id}
                    p={p}
                    m={byId.get(p.mandate.id)}
                    checking={checking}
                    right={rightOf(p)}
                    v1={v1}
                    selected={p.id === selected}
                    asked={asked?.id === p.id ? asked.kind : null}
                    readBack={readBack}
                    onAsk={onAsk}
                    onSelect={setSelected}
                    onOpen={onOpen}
                    onSettled={onSettled}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <SoonRow
        title="Approve as a team"
        items={['Passkey approvers', 'Two of three', 'Approve on your phone']}
      />
      {open === null ? null : (
        <PayoutSheet
          key={open}
          v1={v1}
          projectId={projectId}
          id={open}
          mandateLabel={mandateLabel}
          onClose={onClose}
          waitingAction={(p) =>
            ids.includes(p.id) ? (
              <SheetActions
                right={rightOf(p)}
                onAsk={(kind) => {
                  setSelected(p.id);
                  setAsked({ id: p.id, kind });
                }}
              />
            ) : null
          }
        />
      )}
    </div>
  );
}
