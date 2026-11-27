// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The developers screen on /v1: the open project's API keys, each mandate's
// MCP address, and examples to copy. A new key's whole text lives only in the
// dialog that shows it, and is gone once that dialog closes. A key changes on
// screen only once the server has answered.

import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';

import { useApp } from '../app/context';
import { useAction, useResource, type Resource } from '../app/hooks';
import { McpConnect } from '../components/ConnectClaude';
import { Link } from '../components/Link';
import { DemoServer, Tools } from '../components/McpTools';
import {
  ConfirmDialog,
  CopyButton,
  Empty,
  ErrorNotice,
  Field,
  Icon,
  Notice,
  Skeleton,
  SoonRow,
  SoonTag,
  Spinner,
  StatusPill,
  Tip,
} from '../components/ui';
import {
  DEFAULT_SCOPES,
  EXPIRY_DEFAULT_DAYS,
  KEY_LIMIT,
  SCOPE_AREAS,
  canManageKeys,
  checkExpiryDays,
  checkKeyName,
  expiryDate,
  keyLabel,
  keyMcpConfig,
  keyState,
  mandateMcpUrl,
  payoutCurl,
  readKeys,
  sortKeys,
  type ApiScope,
  type SnippetMandate,
} from '../lib/apiKeys';
import { mandateName, statusOf } from '../lib/mandateV1';
import { formatToken } from '../lib/money';
import type { V1Api } from '../lib/v1';
import type { ApiKey, Page, V1Mandate } from '../lib/v1Schemas';

const MANDATE_LIMIT = 50;

function dateOf(iso: string | Date): string {
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

/** A modal that opens when it mounts. Closing unmounts it, and its state goes with it. */
function Modal({
  title,
  busy,
  onClose,
  children,
}: {
  title: string;
  busy: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const d = ref.current;
    if (d === null) return;
    if (!d.open) {
      if (typeof d.showModal === 'function') d.showModal();
      else d.setAttribute('open', '');
    }
    return () => {
      if (!d.open) return;
      if (typeof d.close === 'function') d.close();
      else d.removeAttribute('open');
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className="dialog dialog-wide"
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onClose();
      }}
    >
      <h2 id={titleId}>{title}</h2>
      {children}
    </dialog>
  );
}

function ScopePicker({
  selected,
  onChange,
  disabled,
  error,
}: {
  selected: ReadonlySet<ApiScope>;
  onChange: (next: ReadonlySet<ApiScope>) => void;
  disabled: boolean;
  error: string | undefined;
}) {
  const id = useId();
  const errorId = `${id}-error`;
  return (
    <fieldset className="scopes" aria-describedby={error === undefined ? undefined : errorId}>
      <legend>Access</legend>
      <div className="scope-list">
        {SCOPE_AREAS.map((a) => (
          <div key={a.area} role="group" aria-labelledby={`${id}-${a.area}`}>
            <span id={`${id}-${a.area}`} className="scope-area">
              {a.area}
              {a.soon === true ? <SoonTag /> : null}
            </span>
            <span className="scope-checks">
              {a.scopes.map((s) => (
                <label key={s.scope} className="scope-check">
                  <input
                    type="checkbox"
                    checked={selected.has(s.scope)}
                    disabled={disabled || a.soon === true}
                    onChange={(e) => {
                      const next = new Set(selected);
                      if (e.target.checked) next.add(s.scope);
                      else next.delete(s.scope);
                      onChange(next);
                    }}
                  />
                  {s.label}
                </label>
              ))}
            </span>
          </div>
        ))}
      </div>
      {error === undefined ? null : (
        <p className="error-text" id={errorId}>
          {error}
        </p>
      )}
    </fieldset>
  );
}

/** The new key, once. Nothing keeps it after this unmounts. */
function Reveal({ secret, onDone }: { secret: string; onDone: () => void }) {
  const inputId = useId();
  return (
    <>
      <div className="dialog-body">
        <p>
          <strong>Copy it now. You won&rsquo;t see it again.</strong>
        </p>
        <div className="copy-row">
          <label className="sr-only" htmlFor={inputId}>
            Your new API key
          </label>
          <input
            id={inputId}
            className="mono"
            readOnly
            value={secret}
            autoComplete="off"
            spellCheck={false}
            onFocus={(e) => {
              e.target.select();
            }}
          />
          <CopyButton text={secret} label="Copy key" />
        </div>
        <p className="muted small">Keep it in a secret store. It acts for this project.</p>
      </div>
      <div className="actions">
        <button type="button" className="btn btn-primary" onClick={onDone}>
          Done
        </button>
      </div>
    </>
  );
}

function CreateKey({
  v1,
  onCreated,
  onClose,
}: {
  v1: V1Api;
  onCreated: (k: ApiKey) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<ReadonlySet<ApiScope>>(new Set(DEFAULT_SCOPES));
  const [days, setDays] = useState(String(EXPIRY_DEFAULT_DAYS));
  const [errors, setErrors] = useState<{ name?: string; scopes?: string; days?: string }>({});
  const [secret, setSecret] = useState<string | null>(null);
  const create = useAction(async (input: { name: string; scopes: string[]; days: number }) => {
    const made = await v1.createApiKey({
      name: input.name,
      scopes: input.scopes,
      expiresInDays: input.days,
    });
    setSecret(made.secret);
    onCreated(made.apiKey);
  });
  const checkedDays = checkExpiryDays(days);

  if (secret !== null) {
    return (
      <Modal title="Your new key" busy={false} onClose={onClose}>
        <Reveal secret={secret} onDone={onClose} />
      </Modal>
    );
  }

  return (
    <Modal title="Create a key" busy={create.busy} onClose={onClose}>
      <form
        className="form dialog-body"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          const n = checkKeyName(name);
          const chosen = SCOPE_AREAS.flatMap((a) => a.scopes)
            .map((s) => s.scope)
            .filter((s) => scopes.has(s));
          const next = {
            ...('error' in n ? { name: n.error } : {}),
            ...(chosen.length === 0 ? { scopes: 'Choose at least one.' } : {}),
            ...('error' in checkedDays ? { days: checkedDays.error } : {}),
          };
          setErrors(next);
          if ('error' in n || chosen.length === 0 || 'error' in checkedDays) return;
          void create.run({ name: n.name, scopes: chosen, days: checkedDays.days });
        }}
      >
        <Field
          label="Name"
          value={name}
          onChange={setName}
          error={errors.name}
          placeholder="Payroll runner"
        />
        <ScopePicker
          selected={scopes}
          onChange={setScopes}
          disabled={create.busy}
          error={errors.scopes}
        />
        <Field
          label="Expires after"
          suffix="days"
          inputMode="numeric"
          value={days}
          onChange={setDays}
          error={errors.days}
          help={'days' in checkedDays ? `Ends ${dateOf(expiryDate(checkedDays.days))}` : '1 to 730'}
        />
        {create.error === null ? null : <ErrorNotice error={create.error} />}
        <div className="actions dialog-actions">
          <button type="button" className="btn" onClick={onClose} disabled={create.busy}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={create.busy}>
            {create.busy ? <Spinner /> : null}
            Create key
          </button>
        </div>
      </form>
    </Modal>
  );
}

function KeyRow({ k, onRevoke }: { k: ApiKey; onRevoke: (k: ApiKey) => void }) {
  const state = keyState(k);
  const label = keyLabel(k);
  return (
    <li className={`key-row${state === 'active' ? '' : ' key-off'}`}>
      <span className="key-icon" aria-hidden="true">
        <Icon name="key" size={18} />
      </span>
      <span className="key-main">
        <span className="key-name">
          <strong>{label}</strong>
          {state === 'active' ? null : (
            <StatusPill tone="neutral">{state === 'revoked' ? 'Revoked' : 'Expired'}</StatusPill>
          )}
        </span>
        <span className="mono muted small key-prefix">{k.prefix}</span>
      </span>
      <ul className="key-scopes" aria-label={`Access of ${label}`}>
        {k.scopes.map((s) => (
          <li key={s} className="mono">
            {s}
          </li>
        ))}
      </ul>
      <span className="key-dates muted small">
        <span>{k.lastUsedAt === null ? 'Never used' : `Used ${dateOf(k.lastUsedAt)}`}</span>
        <span>
          {state === 'revoked'
            ? `Revoked ${dateOf(k.revokedAt ?? '')}`
            : `${state === 'expired' ? 'Ended' : 'Ends'} ${dateOf(k.expiresAt)}`}
        </span>
      </span>
      <span className="key-action">
        {state === 'active' ? (
          <button
            type="button"
            className="btn btn-small btn-danger-ghost"
            onClick={() => {
              onRevoke(k);
            }}
          >
            Revoke<span className="sr-only"> {label}</span>
          </button>
        ) : null}
      </span>
    </li>
  );
}

/** Keys the server has answered with since the list was read: a new key, or one just revoked. */
function mergeKeys(listed: readonly ApiKey[], answered: ReadonlyMap<string, ApiKey>): ApiKey[] {
  const byId = new Map(listed.map((k) => [k.id, k]));
  for (const k of answered.values()) {
    const seen = byId.get(k.id);
    if (seen === undefined || (seen.revokedAt === null && k.revokedAt !== null)) byId.set(k.id, k);
  }
  return sortKeys([...byId.values()]);
}

function ApiKeys({ v1, projectId, role }: { v1: V1Api; projectId: string; role: string }) {
  const { notify } = useApp();
  const allowed = canManageKeys(role);
  const list = useResource(allowed ? `v1:api-keys:${projectId}` : null, () => readKeys(v1));
  const [answered, setAnswered] = useState<ReadonlyMap<string, ApiKey>>(new Map());
  const [creating, setCreating] = useState(false);
  const [revoking, setRevoking] = useState<ApiKey | null>(null);
  const keep = (k: ApiKey) => {
    setAnswered((m) => new Map(m).set(k.id, k));
  };
  const revoke = useAction(async (k: ApiKey) => {
    const done = await v1.revokeApiKey(k.id);
    keep(done);
    setRevoking(null);
    notify(`${keyLabel(done)} is revoked.`);
    list.reload();
  });

  const data = list.data;
  const keys = useMemo(
    () => (data?.kind === 'keys' ? mergeKeys(data.items, answered) : []),
    [data, answered],
  );
  const active = keys.filter((k) => keyState(k) === 'active').length;
  const full = active >= KEY_LIMIT;

  if (!allowed || data?.kind === 'forbidden') {
    return (
      <section className="card" aria-labelledby="keys-title">
        <h2 id="keys-title" className="card-title">
          API keys
        </h2>
        <p className="muted keys-locked">
          <Icon name="lock" size={16} />
          Only owners and admins manage keys.
        </p>
      </section>
    );
  }

  return (
    <section className="card" aria-labelledby="keys-title">
      <div className="card-head">
        <h2 id="keys-title" className="card-title">
          API keys
          {data === undefined ? null : (
            <span className="title-count">
              {active} of {KEY_LIMIT} active
            </span>
          )}
        </h2>
        <button
          type="button"
          className="btn btn-primary btn-small"
          disabled={data === undefined || full}
          onClick={() => {
            setCreating(true);
          }}
        >
          <Icon name="plus" size={16} />
          Create key
        </button>
      </div>
      {list.error !== null && data !== undefined ? (
        <Notice tone="waiting">
          <p>Could not refresh: {list.error} Showing the last known state.</p>
        </Notice>
      ) : null}
      {list.loading ? (
        <Skeleton lines={3} label="Loading API keys" />
      ) : data === undefined ? (
        <ErrorNotice
          error={list.error ?? 'Not loaded.'}
          onRetry={list.reload}
          requestId={list.errorRequestId}
        />
      ) : keys.length === 0 ? (
        <Empty text="No keys yet. A key lets your code pay inside this project's mandates." />
      ) : (
        <ul className="key-list">
          {keys.map((k) => (
            <KeyRow
              key={k.id}
              k={k}
              onRevoke={(x) => {
                revoke.clear();
                setRevoking(x);
              }}
            />
          ))}
        </ul>
      )}
      {data?.kind === 'keys' && data.truncated ? (
        <p className="muted small">Showing the first 1,000 keys.</p>
      ) : null}
      {full ? <p className="muted small">Revoke a key to make another.</p> : null}
      {creating ? (
        <CreateKey
          v1={v1}
          onCreated={(k) => {
            keep(k);
            list.reload();
          }}
          onClose={() => {
            setCreating(false);
          }}
        />
      ) : null}
      <ConfirmDialog
        open={revoking !== null}
        title={`Revoke ${revoking === null ? 'this key' : keyLabel(revoking)}?`}
        confirmLabel="Revoke key"
        danger
        busy={revoke.busy}
        onCancel={() => {
          setRevoking(null);
        }}
        onConfirm={() => {
          if (revoking !== null) void revoke.run(revoking);
        }}
      >
        <p>It stops working at once, everywhere it is used. This cannot be undone.</p>
        {revoke.error === null ? null : <ErrorNotice error={revoke.error} />}
      </ConfirmDialog>
    </section>
  );
}

function Snippet({
  title,
  code,
  copyLabel,
  soon = false,
}: {
  title: string;
  code: string;
  copyLabel: string;
  /** Shown as it will work, tagged, until the route behind it ships. */
  soon?: boolean;
}) {
  const id = useId();
  return (
    <figure className="snippet" aria-labelledby={id}>
      <figcaption className="snippet-head">
        <span id={id} className="snippet-title">
          {title}
          {soon ? <SoonTag /> : null}
        </span>
        <CopyButton text={code} label={copyLabel} icon />
      </figcaption>
      <pre tabIndex={0} aria-labelledby={id}>
        <code>{code}</code>
      </pre>
    </figure>
  );
}

function Examples({ m }: { m: SnippetMandate }) {
  const origin = location.origin;
  return (
    <section className="card" aria-labelledby="examples-title">
      <div className="card-head">
        <h2 id="examples-title" className="card-title">
          With an API key
        </h2>
        <Tip
          label="About these examples"
          text="Send the key as a bearer token. The idempotency key makes a retry safe: the same key and body return the same payout."
        />
      </div>
      <Snippet title="Create a payout" code={payoutCurl(origin, m)} copyLabel="Copy the request" />
      <Snippet
        title="Any MCP client"
        code={keyMcpConfig(origin)}
        copyLabel="Copy the MCP config"
        soon
      />
    </section>
  );
}

function MandateMcp({
  mandates,
  chosen,
  onChoose,
}: {
  mandates: Resource<Page<V1Mandate>>;
  chosen: V1Mandate | undefined;
  onChoose: (id: string) => void;
}) {
  const chooserId = useId();
  const items = (mandates.data?.items ?? []).filter((m) => statusOf(m) !== 'revoked');
  if (mandates.loading) {
    return (
      <section className="card" aria-label="Connect a mandate">
        <Skeleton lines={3} label="Loading your mandates" />
      </section>
    );
  }
  if (mandates.data === undefined) {
    return (
      <section className="card" aria-label="Connect a mandate">
        <ErrorNotice
          error={mandates.error ?? 'Not loaded.'}
          onRetry={mandates.reload}
          requestId={mandates.errorRequestId}
        />
      </section>
    );
  }
  if (chosen === undefined) {
    return (
      <section className="card" aria-label="Connect a mandate">
        <Empty
          text="No mandate yet. Try the public demo below."
          action={
            <Link to="/mandates/new" className="btn btn-small">
              Create a mandate
            </Link>
          }
        />
      </section>
    );
  }
  const threshold = chosen.config.limits.approvalThreshold;
  return (
    <McpConnect
      key={chosen.id}
      url={mandateMcpUrl(location.origin, chosen.contractId)}
      title={`Connect Claude to ${mandateName(chosen)}`}
      approvalFrom={threshold.amount > 0n ? formatToken(threshold) : null}
    >
      {items.length > 1 ? (
        <div className="field chooser">
          <label htmlFor={chooserId}>Mandate</label>
          <select
            id={chooserId}
            value={chosen.id}
            onChange={(e) => {
              onChoose(e.target.value);
            }}
          >
            {items.map((x) => (
              <option key={x.id} value={x.id}>
                {mandateName(x)}
              </option>
            ))}
          </select>
        </div>
      ) : null}
    </McpConnect>
  );
}

/** Keys, MCP addresses and examples for the open project. */
export function DevelopersV1({
  v1,
  projectId,
  role,
}: {
  v1: V1Api;
  projectId: string;
  /** The member's role in the open project's organisation. */
  role: string;
}) {
  const { config } = useApp();
  const mandates = useResource(`v1:dev-mandates:${projectId}`, () =>
    v1.mandates({ limit: MANDATE_LIMIT }),
  );
  const [chosenId, setChosenId] = useState<string | null>(null);
  const usable = (mandates.data?.items ?? []).filter((m) => statusOf(m) !== 'revoked');
  const chosen = usable.find((m) => m.id === chosenId) ?? usable[0];
  const sample: SnippetMandate =
    chosen === undefined
      ? {
          id: 'MANDATE_ID',
          network: `stellar:${config.network}`,
          asset: config.asset.code,
          scale: config.asset.decimals,
        }
      : {
          id: chosen.id,
          network: chosen.network,
          asset: chosen.state.balance.asset,
          scale: chosen.state.balance.scale,
        };

  return (
    <div className="stack">
      <ApiKeys v1={v1} projectId={projectId} role={role} />
      <MandateMcp mandates={mandates} chosen={chosen} onChoose={setChosenId} />
      <Examples m={sample} />
      <div className="grid-2">
        <Tools />
        <DemoServer />
      </div>
      <SoonRow title="Build on UJIRA next" items={['Webhooks', 'TypeScript SDK']} />
    </div>
  );
}
