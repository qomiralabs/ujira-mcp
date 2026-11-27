// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The recipients of the open project on /v1: one line each, a side sheet with
// why a recipient cannot be paid and what fixes it, and invite links that open
// the embed widget, where the person adds and proves their own wallet. Every
// change shows once the server has it; nothing on screen runs ahead of it.

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';

import { useApp } from '../app/context';
import { replaceSearch, useAction, useAllPages, useResource, useSearch } from '../app/hooks';
import { Link } from '../components/Link';
import { SignPanel, readUntil, useV1Signing, type Signing } from '../components/V1Sign';
import {
  CopyButton,
  Empty,
  ErrorNotice,
  Field,
  Icon,
  IdText,
  Notice,
  Skeleton,
  SoonRow,
  SoonTag,
  Spinner,
  StatusPill,
  Tip,
} from '../components/ui';
import { ApiError, errorMessage, errorRequestId } from '../lib/api';
import { mandateName, showsAction, statusOf } from '../lib/mandateV1';
import {
  DEFAULT_INVITE_SECONDS,
  INVITE_LIFETIMES,
  inviteLink,
  inviteState,
  recipientLabelProblem,
  recipientWord,
  whenText,
} from '../lib/recipientsV1';
import { accountAddressProblem } from '../lib/strkey';
import type { V1Api } from '../lib/v1';
import type { EmbedSession, Page, SigningRequest, V1Mandate, V1Recipient } from '../lib/v1Schemas';

const PAGE_LIMIT = 100;
const RECIPIENT_CAP = 5_000;
const POLL_MS = 15_000;
const INVITE_PAGE = 20;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The open recipient from the URL, so a reload or a shared link opens it again. */
function openFrom(search: string): string | null {
  const id = new URLSearchParams(search).get('open');
  return id !== null && UUID.test(id) ? id : null;
}

function setOpen(id: string | null): void {
  const params = new URLSearchParams(location.search);
  if (id === null) params.delete('open');
  else params.set('open', id);
  const qs = params.toString();
  replaceSearch(qs === '' ? '' : `?${qs}`);
}

function count(n: number): string {
  return n.toLocaleString('en-US');
}

function plural(n: number): string {
  return n === 1 ? '1 recipient' : `${count(n)} recipients`;
}

function initial(label: string): string {
  return label.trim().slice(0, 1).toUpperCase();
}

function dateOf(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

/** A mandate that can still take new recipients. */
function canAdd(m: V1Mandate): boolean {
  const s = statusOf(m);
  return s === 'active' || s === 'paused';
}

function CreateMandateLink() {
  return (
    <Link to="/mandates/new" className="btn btn-primary btn-small">
      <Icon name="plus" size={16} />
      Create a mandate
    </Link>
  );
}

function RecipientRow({
  r,
  mandate,
  onOpen,
}: {
  r: V1Recipient;
  mandate: string;
  onOpen: (id: string) => void;
}) {
  const word = recipientWord(r);
  return (
    <li>
      <button
        type="button"
        className="rrow"
        data-recipient={r.id}
        aria-label={`Open ${r.label}, ${word.label}`}
        onClick={() => {
          onOpen(r.id);
        }}
      >
        <span className="avatar" aria-hidden="true">
          {initial(r.label)}
        </span>
        <strong className="rrow-name">{r.label}</strong>
        <span className={r.address === null ? 'rrow-address muted' : 'rrow-address mono'}>
          {r.address ?? 'No wallet'}
        </span>
        <span className="rrow-mandate muted">{mandate}</span>
        <StatusPill tone={word.tone}>{word.label}</StatusPill>
        <Icon name="arrow" size={18} />
      </button>
    </li>
  );
}

type Added =
  | { readonly kind: 'form' }
  | {
      readonly kind: 'added';
      readonly recipient: V1Recipient;
      readonly mandateId: string;
      readonly request: SigningRequest | null;
    };

/** Asks the wallet to let the mandate pay this recipient. A fresh request after the first. */
function startAllow(
  signing: Signing,
  v1: V1Api,
  mandateId: string,
  recipientId: string,
  first: SigningRequest | null,
  onDone: () => void,
): void {
  let given = first;
  signing.start({
    prepare: () => {
      const r = given;
      given = null;
      return r === null
        ? v1.mandateAction(mandateId, { kind: 'allow_recipients', recipientIds: [recipientId] })
        : Promise.resolve(r);
    },
    confirm: () =>
      readUntil(
        () => v1.mandate(mandateId),
        (m) => showsAction('allow_recipients', m),
      ),
    onDone,
  });
}

function AddRecipient({
  v1,
  mandates,
  onAdded,
  onOpen,
  onClose,
}: {
  v1: V1Api;
  mandates: readonly V1Mandate[];
  onAdded: () => void;
  onOpen: (id: string) => void;
  onClose: () => void;
}) {
  const { notify } = useApp();
  const id = useId();
  const open = mandates.filter(canAdd);
  const [mandateId, setMandateId] = useState(() => open[0]?.id ?? '');
  const [label, setLabel] = useState('');
  const [address, setAddress] = useState('');
  const [errors, setErrors] = useState<{ label?: string; address?: string }>({});
  const [failure, setFailure] = useState<{ error: string; requestId: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [added, setAdded] = useState<Added>({ kind: 'form' });
  const signing = useV1Signing(v1);
  const chosen = open.find((m) => m.id === mandateId) ?? open[0];

  if (chosen === undefined) {
    return (
      <section className="card" aria-labelledby={`${id}-title`}>
        <h2 id={`${id}-title`} className="card-title">
          Add a recipient
        </h2>
        <Empty
          text="A recipient belongs to a mandate. Create one first."
          action={<CreateMandateLink />}
        />
      </section>
    );
  }

  const submit = async () => {
    const next: typeof errors = {};
    const lp = recipientLabelProblem(label);
    if (lp !== null) next.label = lp;
    const wallet = address.trim();
    const ap = wallet === '' ? null : accountAddressProblem(wallet);
    if (ap !== null) next.address = ap;
    setErrors(next);
    setFailure(null);
    if (Object.keys(next).length > 0) return;
    setBusy(true);
    try {
      const made = await v1.createRecipient({
        mandateId: chosen.id,
        label: label.trim(),
        ...(wallet === '' ? {} : { address: wallet }),
      });
      setAdded({
        kind: 'added',
        recipient: made.recipient,
        mandateId: chosen.id,
        request: made.signingRequest,
      });
      onAdded();
      if (made.signingRequest !== null) {
        startAllow(signing, v1, chosen.id, made.recipient.id, made.signingRequest, () => {
          notify(`${made.recipient.label} can be paid from ${mandateName(chosen)}.`);
          onAdded();
        });
      }
    } catch (e) {
      if (e instanceof ApiError && e.code === 'RECIPIENT_LABEL_TAKEN') {
        setErrors({ label: e.message });
      } else {
        setFailure({ error: errorMessage(e), requestId: errorRequestId(e) });
      }
    } finally {
      setBusy(false);
    }
  };

  const reset = () => {
    signing.reset();
    setAdded({ kind: 'form' });
    setLabel('');
    setAddress('');
    setErrors({});
  };

  return (
    <section className="card" aria-labelledby={`${id}-title`}>
      <div className="card-head">
        <h2 id={`${id}-title`} className="card-title">
          Add a recipient
        </h2>
        <button type="button" className="btn-icon" onClick={onClose} disabled={signing.busy}>
          <Icon name="close" size={18} />
          <span className="sr-only">Close</span>
        </button>
      </div>
      {added.kind === 'form' ? (
        <form
          className="stack-sm"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <div className="add-grid">
            {open.length > 1 ? (
              <div className="field">
                <div className="field-top">
                  <label htmlFor={`${id}-mandate`}>Mandate</label>
                </div>
                <select
                  id={`${id}-mandate`}
                  value={chosen.id}
                  onChange={(e) => {
                    setMandateId(e.target.value);
                  }}
                >
                  {open.map((m) => (
                    <option key={m.id} value={m.id}>
                      {mandateName(m)}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}
            <Field label="Name" value={label} onChange={setLabel} error={errors.label} />
            <Field
              label="Stellar address"
              mono
              placeholder="G... (optional)"
              value={address}
              onChange={(v) => {
                setAddress(v.trim());
              }}
              error={errors.address}
              tip="Leave it empty and send them an invite link. They add and prove their own wallet."
            />
          </div>
          <div className="actions">
            <button type="submit" className="btn btn-primary" disabled={busy}>
              {busy ? <Spinner /> : null}
              {busy ? 'Adding' : 'Add recipient'}
            </button>
            {open.length === 1 ? (
              <span className="muted small">To {mandateName(chosen)}</span>
            ) : null}
          </div>
          {failure === null ? null : (
            <ErrorNotice error={failure.error} requestId={failure.requestId} />
          )}
        </form>
      ) : (
        <div className="stack-sm">
          <p className="small" role="status">
            <strong>{added.recipient.label}</strong> is added.{' '}
            {added.request === null
              ? 'Send them an invite link to add their wallet.'
              : 'Sign once so the mandate may pay them.'}
          </p>
          {added.request === null ? null : (
            <SignPanel signing={signing} done="Signed. The mandate may pay them." />
          )}
          <div className="actions">
            <button
              type="button"
              className={added.request === null ? 'btn btn-primary btn-small' : 'btn btn-small'}
              disabled={signing.busy}
              onClick={() => {
                onOpen(added.recipient.id);
              }}
            >
              {added.request === null ? 'Make an invite link' : 'Open'}
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-small"
              disabled={signing.busy}
              onClick={reset}
            >
              Add another
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

function InviteRow({
  s,
  busy,
  onRevoke,
}: {
  s: EmbedSession;
  busy: boolean;
  onRevoke: (id: string) => void;
}) {
  const state = inviteState(s);
  return (
    <li>
      <span className="muted small">Made {whenText(s.createdAt)}</span>
      {state === 'live' ? (
        <StatusPill tone="paid">Works until {whenText(s.expiresAt)}</StatusPill>
      ) : state === 'revoked' ? (
        <StatusPill tone="neutral">Revoked</StatusPill>
      ) : (
        <StatusPill tone="neutral">Expired</StatusPill>
      )}
      {state === 'live' ? (
        <button
          type="button"
          className="btn btn-danger-ghost btn-small"
          disabled={busy}
          onClick={() => {
            onRevoke(s.id);
          }}
        >
          Revoke
        </button>
      ) : null}
    </li>
  );
}

/** Invite links for one recipient: make one, copy it once, revoke any that still work. */
function Invites({ v1, projectId, r }: { v1: V1Api; projectId: string; r: V1Recipient }) {
  const { notify } = useApp();
  const id = useId();
  const listed = useResource(`v1:invites:${projectId}:${r.id}`, () =>
    v1.embedSessions({ recipientId: r.id, limit: INVITE_PAGE }),
  );
  // The list as the server last showed it after a change made here.
  const [latest, setLatest] = useState<Page<EmbedSession> | null>(null);
  const [lifetime, setLifetime] = useState(DEFAULT_INVITE_SECONDS);
  const [link, setLink] = useState<{ url: string; until: string } | null>(null);
  const refetch = async () => {
    setLatest(await v1.embedSessions({ recipientId: r.id, limit: INVITE_PAGE }));
  };
  const make = useAction(async () => {
    const made = await v1.createEmbedSession({ recipientId: r.id, expiresInSeconds: lifetime });
    // The token is shown now or never, so the list catches up on its own.
    setLink({ url: inviteLink(location.origin, made.token), until: made.session.expiresAt });
    setLatest(null);
    listed.reload();
  });
  const revoke = useAction(async (sid: string) => {
    await v1.revokeEmbedSession(sid);
    await refetch();
    setLink(null);
    notify('Link revoked. It no longer opens.');
  });
  const page = latest ?? listed.data;
  const held = r.status === 'suspended';

  return (
    <section className="stack-sm" aria-labelledby={`${id}-title`}>
      <div className="card-head">
        <h3 id={`${id}-title`} className="sub-title">
          Invite link
        </h3>
        <span className="soon-inline">
          Send by email <SoonTag />
        </span>
      </div>
      {held ? (
        <p className="muted small">Not while payouts to them are on hold.</p>
      ) : (
        <div className="inline-form invite-form">
          <div className="field">
            <div className="field-top">
              <label htmlFor={`${id}-life`}>Works for</label>
            </div>
            <select
              id={`${id}-life`}
              value={lifetime}
              onChange={(e) => {
                setLifetime(Number.parseInt(e.target.value, 10));
              }}
            >
              {INVITE_LIFETIMES.map((l) => (
                <option key={l.seconds} value={l.seconds}>
                  {l.label}
                </option>
              ))}
            </select>
          </div>
          <button
            type="button"
            className="btn btn-primary"
            disabled={make.busy}
            onClick={() => void make.run()}
          >
            {make.busy ? <Spinner /> : null}
            {make.busy ? 'Making the link' : 'Make a link'}
          </button>
        </div>
      )}
      {make.error === null ? null : <ErrorNotice error={make.error} />}
      {link === null ? null : (
        <div className="invite-out">
          <label htmlFor={`${id}-link`} className="sr-only">
            Invite link for {r.label}
          </label>
          <input
            id={`${id}-link`}
            className="mono"
            readOnly
            value={link.url}
            onFocus={(e) => {
              e.target.select();
            }}
          />
          <CopyButton text={link.url} label="Copy link" />
          <p className="muted small">Shown once. Works until {whenText(link.until)}.</p>
        </div>
      )}
      {page === undefined ? (
        listed.error === null ? (
          <Skeleton lines={1} label="Loading invite links" />
        ) : (
          <ErrorNotice
            error={listed.error}
            onRetry={listed.reload}
            requestId={listed.errorRequestId}
          />
        )
      ) : page.items.length === 0 ? null : (
        <ul className="invite-list" aria-label="Invite links">
          {page.items.map((s) => (
            <InviteRow
              key={s.id}
              s={s}
              busy={revoke.busy}
              onRevoke={(sid) => void revoke.run(sid)}
            />
          ))}
        </ul>
      )}
      {revoke.error === null ? null : <ErrorNotice error={revoke.error} />}
    </section>
  );
}

function AllowOnMandate({ v1, r, mandate }: { v1: V1Api; r: V1Recipient; mandate: string }) {
  const { notify } = useApp();
  const signing = useV1Signing(v1);
  return (
    <section className="stack-sm" aria-label="Allow on the mandate">
      <div className="actions">
        <button
          type="button"
          className="btn btn-small"
          disabled={signing.busy}
          onClick={() => {
            startAllow(signing, v1, r.mandateId, r.id, null, () => {
              notify(`${r.label} can be paid from ${mandate}.`);
            });
          }}
        >
          Allow on {mandate}
        </button>
        <Tip
          label="When to allow"
          text="Sign once after they add a wallet, so the mandate may pay it."
        />
      </div>
      <SignPanel signing={signing} done="Signed. The mandate may pay them." />
    </section>
  );
}

function SheetBody({
  v1,
  projectId,
  r,
  mandate,
  checking,
  onCheck,
}: {
  v1: V1Api;
  projectId: string;
  r: V1Recipient;
  mandate: string;
  checking: boolean;
  onCheck: () => void;
}) {
  const word = recipientWord(r);
  return (
    <>
      <div className="sheet-hero">
        <div className="recipient-hero">
          <span className="avatar avatar-lg" aria-hidden="true">
            {initial(r.label)}
          </span>
          <strong>{r.label}</strong>
        </div>
        <StatusPill tone={word.tone}>{word.label}</StatusPill>
      </div>
      {word.why === null ? null : (
        <Notice tone={word.tone === 'blocked' ? 'blocked' : 'waiting'} title={word.why}>
          {word.todo === null ? null : <p>{word.todo}</p>}
          {word.recheck ? (
            <button type="button" className="btn btn-small" disabled={checking} onClick={onCheck}>
              {checking ? <Spinner /> : null}
              {checking ? 'Checking' : 'Check again'}
            </button>
          ) : null}
        </Notice>
      )}
      <dl className="rules sheet-facts">
        <div>
          <dt>Wallet</dt>
          <dd className={r.address === null ? 'muted' : 'mono'}>{r.address ?? 'None yet'}</dd>
        </div>
        <div>
          <dt>Mandate</dt>
          <dd>
            <Link to={`/mandates/${r.mandateId}`} className="card-link">
              {mandate}
            </Link>
          </dd>
        </div>
        {r.email === undefined || r.email === null ? null : (
          <div>
            <dt>Email</dt>
            <dd>{r.email}</dd>
          </div>
        )}
        <div>
          <dt>Added</dt>
          <dd>{dateOf(r.createdAt)}</dd>
        </div>
      </dl>
      {r.address === null || r.status === 'suspended' ? null : (
        <AllowOnMandate v1={v1} r={r} mandate={mandate} />
      )}
      <Invites v1={v1} projectId={projectId} r={r} />
    </>
  );
}

function RecipientSheet({
  v1,
  projectId,
  id,
  mandateLabel,
  onClose,
  onChanged,
}: {
  v1: V1Api;
  projectId: string;
  id: string;
  mandateLabel: (mandateId: string) => string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { notify } = useApp();
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const recipient = useResource(`v1:recipient:${projectId}:${id}`, () => v1.recipient(id));
  const [fresh, setFresh] = useState<V1Recipient | null>(null);
  const check = useAction(async () => {
    const again = await v1.recipient(id);
    setFresh(again);
    notify(again.payable ? `${again.label} can be paid now.` : 'Checked. Nothing has changed yet.');
    if (again.payable) onChanged();
  });
  const r = fresh ?? recipient.data;

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
          <h2 id={titleId}>Recipient</h2>
          <IdText value={id} keep={8} copyLabel="Copy the recipient ID" />
          <button type="button" className="btn-icon sheet-close" onClick={onClose}>
            <Icon name="close" size={18} />
            <span className="sr-only">Close</span>
          </button>
        </div>
        {r === undefined ? (
          recipient.error === null ? (
            <Skeleton lines={5} label="Loading the recipient" />
          ) : (
            <ErrorNotice
              error={recipient.error}
              onRetry={recipient.reload}
              requestId={recipient.errorRequestId}
            />
          )
        ) : (
          <>
            {check.error === null ? null : <ErrorNotice error={check.error} />}
            <SheetBody
              v1={v1}
              projectId={projectId}
              r={r}
              mandate={mandateLabel(r.mandateId)}
              checking={check.busy}
              onCheck={() => void check.run()}
            />
          </>
        )}
      </div>
    </dialog>
  );
}

/** Every recipient in the open project, with the open one in the URL. */
export function RecipientsV1({ v1, projectId }: { v1: V1Api; projectId: string }) {
  const search = useSearch();
  const open = openFrom(search);
  const [adding, setAdding] = useState(false);
  const list = useAllPages(
    `v1:recipients:${projectId}`,
    (cursor) => v1.recipients({ cursor, limit: PAGE_LIMIT }),
    { cap: RECIPIENT_CAP, pollMs: POLL_MS, pollUpTo: 500 },
  );
  const mandates = useResource(`v1:recipient-mandates:${projectId}`, () =>
    v1.mandates({ limit: PAGE_LIMIT }),
  );

  const names = useMemo(() => {
    const byId = new Map<string, string>();
    for (const m of mandates.data?.items ?? []) byId.set(m.id, mandateName(m));
    return byId;
  }, [mandates.data]);
  const mandateLabel = useCallback((mid: string) => names.get(mid) ?? 'A mandate', [names]);

  const onOpen = useCallback((id: string) => {
    setOpen(id);
  }, []);
  const onClose = useCallback(() => {
    const id = openFrom(location.search);
    setOpen(null);
    // Back to the row that opened it, when it is still drawn.
    setTimeout(() => {
      const opener = id === null ? null : document.querySelector(`[data-recipient="${id}"]`);
      if (opener instanceof HTMLElement) opener.focus();
    }, 0);
  }, []);

  const items = list.items;
  const waiting = (items ?? []).filter((r) => !r.payable).length;

  return (
    <div className="stack">
      <div className="toolbar">
        <button
          type="button"
          className="btn btn-primary"
          aria-expanded={adding}
          onClick={() => {
            setAdding((a) => !a);
          }}
        >
          <Icon name="plus" size={18} />
          Add a recipient
        </button>
      </div>
      {adding ? (
        mandates.data === undefined ? (
          mandates.error === null ? (
            <Skeleton lines={3} label="Loading your mandates" />
          ) : (
            <ErrorNotice
              error={mandates.error}
              onRetry={mandates.reload}
              requestId={mandates.errorRequestId}
            />
          )
        ) : (
          <AddRecipient
            v1={v1}
            mandates={mandates.data.items}
            onAdded={list.reload}
            onOpen={onOpen}
            onClose={() => {
              setAdding(false);
            }}
          />
        )
      ) : null}
      {list.error !== null && items !== undefined ? (
        <Notice tone="waiting">
          <p>Could not refresh: {list.error} Showing the last known state.</p>
        </Notice>
      ) : null}
      <section className="card" aria-labelledby="recipients-title">
        <div className="card-head">
          <h2 id="recipients-title" className="card-title">
            Recipients
            {items === undefined ? null : (
              <span className="title-count" aria-live="polite">
                {list.complete ? plural(items.length) : `${count(items.length)} so far`}
              </span>
            )}
          </h2>
          {waiting === 0 || items === undefined ? null : (
            <span className="muted small">{count(waiting)} cannot be paid yet</span>
          )}
        </div>
        {list.truncated ? (
          <Notice tone="info">
            <p>Showing the first {count(RECIPIENT_CAP)}.</p>
          </Notice>
        ) : null}
        {list.loading ? (
          <Skeleton lines={4} label="Loading recipients" />
        ) : items === undefined ? (
          <ErrorNotice
            error={list.error ?? 'Not loaded.'}
            onRetry={list.reload}
            requestId={list.errorRequestId}
          />
        ) : items.length === 0 ? (
          <Empty
            text="No recipients yet."
            action={
              <button
                type="button"
                className="btn btn-small"
                onClick={() => {
                  setAdding(true);
                }}
              >
                Add a recipient
              </button>
            }
          />
        ) : (
          <ul className="rlist">
            {items.map((r) => (
              <RecipientRow key={r.id} r={r} mandate={mandateLabel(r.mandateId)} onOpen={onOpen} />
            ))}
          </ul>
        )}
      </section>
      <SoonRow
        title="Recipients next"
        items={['Email the invite', 'Edit and remove', 'Import a list']}
      />
      {open === null ? null : (
        <RecipientSheet
          key={open}
          v1={v1}
          projectId={projectId}
          id={open}
          mandateLabel={mandateLabel}
          onClose={onClose}
          onChanged={list.reload}
        />
      )}
    </div>
  );
}
