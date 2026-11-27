// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

import { useId } from 'react';

import { useResource } from '../app/hooks';
import type { V1Api } from '../lib/v1';
import { Link } from './Link';
import { Empty, ErrorNotice, Skeleton } from './ui';

/**
 * Ticks for the recipients that have a wallet, the only ones a mandate can
 * pay: the project's, or with `mandateId` only that mandate's.
 */
export function RecipientPicker({
  v1,
  projectId,
  mandateId,
  legend,
  selected,
  onChange,
  disabled = false,
}: {
  v1: V1Api;
  projectId: string;
  mandateId?: string;
  legend: string;
  selected: ReadonlySet<string>;
  onChange: (next: ReadonlySet<string>) => void;
  disabled?: boolean;
}) {
  const id = useId();
  const recipients = useResource(`v1:picker:${projectId}:${mandateId ?? ''}`, () =>
    v1.recipients({ limit: 100, mandateId }),
  );
  const withWallet = (recipients.data?.items ?? []).filter((r) => r.address !== null);
  const toggle = (rid: string, on: boolean) => {
    const next = new Set(selected);
    if (on) next.add(rid);
    else next.delete(rid);
    onChange(next);
  };
  return (
    <fieldset className="pick">
      <legend>{legend}</legend>
      {recipients.loading ? (
        <Skeleton lines={2} label="Loading recipients" />
      ) : recipients.data === undefined ? (
        <ErrorNotice
          error={recipients.error ?? 'Not loaded.'}
          onRetry={recipients.reload}
          requestId={recipients.errorRequestId}
        />
      ) : withWallet.length === 0 ? (
        <Empty
          text="No recipients with a wallet yet."
          action={
            <Link to="/recipients" className="btn btn-small">
              Add a recipient
            </Link>
          }
        />
      ) : (
        <ul className="pick-list">
          {withWallet.map((r) => (
            <li key={r.id}>
              <input
                type="checkbox"
                id={`${id}-${r.id}`}
                checked={selected.has(r.id)}
                disabled={disabled}
                onChange={(e) => {
                  toggle(r.id, e.target.checked);
                }}
              />
              <label htmlFor={`${id}-${r.id}`}>
                <span className="avatar" aria-hidden="true">
                  {r.label.slice(0, 1).toUpperCase()}
                </span>
                <strong>{r.label}</strong>
                <span className="mono muted small">{r.address}</span>
              </label>
            </li>
          ))}
        </ul>
      )}
    </fieldset>
  );
}
