// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

import { useEffect, useId, useRef, useState, type ReactNode } from 'react';

import { explorerTx, useApp } from '../app/context';
import { formatAmount } from '../lib/money';
import { shortAddress } from '../lib/strkey';
import type { Tone } from '../lib/words';

export type BrandIconName =
  | 'mandate'
  | 'payout'
  | 'recipient'
  | 'approval'
  | 'receipt'
  | 'rail'
  | 'local-currency'
  | 'agent'
  | 'pause';

/** One of the nine brand icons, drawn in the current text colour. */
export function BrandIcon({ name, size = 20 }: { name: BrandIconName; size?: number }) {
  return (
    <svg className="icon" width={size} height={size} aria-hidden="true" focusable="false">
      <use href={`/icons.svg#ujira-${name}`} />
    </svg>
  );
}

const TONE_PATHS: Record<Tone, string> = {
  paid: 'M4 8.5 6.8 11.3 12 5.5',
  waiting: 'M8 4.5V8l2.2 1.6',
  blocked: 'M5 5l6 6M11 5l-6 6',
  neutral: 'M5 8h6',
};

/** A status always carries a word and a mark, never colour alone. */
export function StatusPill({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span className={`pill pill-${tone}`}>
      <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        {tone === 'waiting' ? <circle cx="8" cy="8" r="5.5" /> : null}
        <path d={TONE_PATHS[tone]} />
      </svg>
      {children}
    </span>
  );
}

export function Amount({ minor, size = 'md' }: { minor: string; size?: 'md' | 'lg' | 'xl' }) {
  return (
    <span className={`amount amount-${size}`}>
      {formatAmount(minor)}
      <span className="amount-code"> USDC</span>
    </span>
  );
}

export function TxLink({ hash, label }: { hash: string; label?: string }) {
  const { config } = useApp();
  return (
    <a className="mono-link" href={explorerTx(config, hash)} target="_blank" rel="noreferrer">
      {label ?? shortAddress(hash, 6)}
      <span className="sr-only"> (opens Stellar Expert in a new tab)</span>
    </a>
  );
}

export function Spinner() {
  return <span className="spinner" aria-hidden="true" />;
}

export function Notice({
  tone,
  title,
  children,
}: {
  tone: 'info' | 'paid' | 'waiting' | 'blocked';
  title?: string;
  children?: ReactNode;
}) {
  return (
    <div className={`notice notice-${tone}`} role={tone === 'blocked' ? 'alert' : 'status'}>
      {title === undefined ? null : <p className="notice-title">{title}</p>}
      {children}
    </div>
  );
}

export function ErrorNotice({ error, onRetry }: { error: string; onRetry?: () => void }) {
  return (
    <Notice tone="blocked" title="That did not work">
      <p>{error}</p>
      {onRetry === undefined ? null : (
        <button type="button" className="btn btn-small" onClick={onRetry}>
          Try again
        </button>
      )}
    </Notice>
  );
}

export function Skeleton({ lines = 3, label }: { lines?: number; label: string }) {
  return (
    <div className="skeleton" role="status" aria-label={label}>
      {Array.from({ length: lines }, (_, i) => (
        <span key={i} className="skeleton-line" />
      ))}
    </div>
  );
}

export interface FieldProps {
  readonly label: string;
  readonly help?: ReactNode;
  readonly error?: string | undefined;
  readonly suffix?: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly inputMode?: 'decimal' | 'numeric' | 'text';
  readonly mono?: boolean;
  readonly placeholder?: string;
  readonly autoComplete?: string;
}

export function Field(props: FieldProps) {
  const id = useId();
  const helpId = `${id}-help`;
  const errorId = `${id}-error`;
  const describedBy = [
    props.help === undefined ? null : helpId,
    props.error === undefined ? null : errorId,
  ]
    .filter((x) => x !== null)
    .join(' ');
  return (
    <div className={`field${props.error === undefined ? '' : ' field-invalid'}`}>
      <label htmlFor={id}>{props.label}</label>
      <div className="input-wrap">
        <input
          id={id}
          value={props.value}
          onChange={(e) => {
            props.onChange(e.target.value);
          }}
          inputMode={props.inputMode ?? 'text'}
          className={props.mono === true ? 'mono' : undefined}
          aria-invalid={props.error !== undefined}
          aria-describedby={describedBy === '' ? undefined : describedBy}
          placeholder={props.placeholder}
          autoComplete={props.autoComplete ?? 'off'}
          spellCheck={false}
        />
        {props.suffix === undefined ? null : <span className="input-suffix">{props.suffix}</span>}
      </div>
      {props.help === undefined ? null : (
        <p className="help" id={helpId}>
          {props.help}
        </p>
      )}
      {props.error === undefined ? null : (
        <p className="error-text" id={errorId}>
          {props.error}
        </p>
      )}
    </div>
  );
}

export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => {
      setCopied(false);
    }, 2000);
    return () => {
      clearTimeout(t);
    };
  }, [copied]);
  return (
    <button
      type="button"
      className="btn btn-small"
      onClick={() => {
        void navigator.clipboard.writeText(text).then(
          () => {
            setCopied(true);
          },
          () => {
            setCopied(false);
          },
        );
      }}
    >
      {copied ? 'Copied' : label}
      <span className="sr-only" aria-live="polite">
        {copied ? 'Copied to the clipboard' : ''}
      </span>
    </button>
  );
}

/** A modal that asks once more before something that cannot be undone. */
export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel,
  danger = false,
  busy = false,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  children: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const d = ref.current;
    if (d === null) return;
    if (open && !d.open) {
      if (typeof d.showModal === 'function') d.showModal();
      else d.setAttribute('open', '');
    }
    if (!open && d.open) {
      if (typeof d.close === 'function') d.close();
      else d.removeAttribute('open');
    }
  }, [open]);
  return (
    <dialog
      ref={ref}
      className="dialog"
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onCancel();
      }}
    >
      <h2 id={titleId}>{title}</h2>
      <div className="dialog-body">{children}</div>
      <div className="actions">
        <button type="button" className="btn" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button
          type="button"
          className={danger ? 'btn btn-danger' : 'btn btn-primary'}
          onClick={onConfirm}
          disabled={busy}
        >
          {busy ? <Spinner /> : null}
          {confirmLabel}
        </button>
      </div>
    </dialog>
  );
}

export function SoonTag() {
  return <span className="soon">Soon</span>;
}
