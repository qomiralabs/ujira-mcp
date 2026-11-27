// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

import { useEffect, useId, useRef, useState, type ReactNode } from 'react';

import { explorerTx, useApp } from '../app/context';
import { formatAmount } from '../lib/money';
import type { TokenAmount } from '../lib/v1Schemas';
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
      <use href={`${import.meta.env.BASE_URL}icons.svg#ujira-${name}`} />
    </svg>
  );
}

const LINE_ICONS = {
  home: 'M3.5 9 10 3.5 16.5 9v7a1 1 0 0 1-1 1h-3v-5h-5v5h-3a1 1 0 0 1-1-1z',
  code: 'M7 6 3 10l4 4M13 6l4 4-4 4',
  key: 'M9.5 10 16 3.5M13.5 6l2 2M7 16a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z',
  activity: 'M2.5 10h3l2-5 4 10 2-5h4',
  proof: 'M12.2 12.2 16.5 16.5M6.5 8.6l1.5 1.5 2.6-2.8M8.5 13.5a5 5 0 1 0 0-10 5 5 0 0 0 0 10z',
  lock: 'M5.5 9h9a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1zM7 9V6.5a3 3 0 0 1 6 0V9',
  copy: 'M7.5 7.5h8v9h-8zM12.5 7.5v-4h-8v9h3',
  check: 'M4.5 10.5 8 14l7.5-8',
  info: 'M10 17a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM10 9.2v4.3M10 6.6v.1',
  external:
    'M11.5 3.5h5v5M16.5 3.5 9 11M14.5 11.5v4a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1h4',
  plus: 'M10 4v12M4 10h12',
  arrow: 'M4 10h11.5M11 5.5l4.5 4.5-4.5 4.5',
  back: 'M16 10H4.5M9 5.5 4.5 10 9 14.5',
  sun: 'M10 13.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM10 2v1.5M10 16.5V18M2 10h1.5M16.5 10H18M4.3 4.3l1.1 1.1M14.6 14.6l1.1 1.1M4.3 15.7l1.1-1.1M14.6 5.4l1.1-1.1',
  moon: 'M16.5 12.2A6.8 6.8 0 0 1 7.8 3.5a6.8 6.8 0 1 0 8.7 8.7z',
  auto: 'M10 17a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM10 3v14',
  more: 'M4 6h12M4 10h12M4 14h12',
  close: 'M5 5l10 10M15 5 5 15',
  power: 'M10 3v6.5M6 5.6a6 6 0 1 0 8 0',
  chevron: 'M6 8l4 4 4-4',
  download: 'M10 3.5v9M6 8.5l4 4 4-4M4 16.5h12',
} as const;

export type IconName = keyof typeof LINE_ICONS;

/** A simple line icon for what the nine brand icons do not cover. */
export function Icon({ name, size = 20 }: { name: IconName; size?: number }) {
  return (
    <svg
      className="icon line-icon"
      width={size}
      height={size}
      viewBox="0 0 20 20"
      aria-hidden="true"
      focusable="false"
    >
      <path d={LINE_ICONS[name]} />
    </svg>
  );
}

/** The UJIRA lockup, drawn inline so it takes the ink of the current theme. */
export function Logo({ height = 26 }: { height?: number }) {
  return (
    <svg
      className="logo-svg"
      viewBox="-2 12 290 76"
      height={height}
      width={Math.round((height * 290) / 76)}
      aria-hidden="true"
      focusable="false"
    >
      <path
        className="logo-ink"
        d="M34 46C30 38 22 32 14 32C14 56 30 68 50 68C70 68 86 56 86 32C78 32 70 38 66 46"
        fill="none"
        strokeWidth="7.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="50" cy="40" r="11" fill="#F4A300" />
      <g transform="translate(104,32) scale(0.9)">
        <g
          className="logo-ink"
          fill="none"
          strokeWidth="7"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M3.5 3.5V22a14.5 14.5 0 0 0 29 0V3.5" />
          <path d="M73 3.5V25a11.5 11.5 0 0 1-23 0" />
          <path d="M89 3.5V36.5" />
          <path d="M105.5 36.5V3.5H119a9 9 0 0 1 0 18H105.5M118 21.5L130 36.5" />
          <path d="M142 36.5L157.5 3.5L173 36.5M148 25H167" />
        </g>
        <circle cx="18" cy="17" r="5.5" fill="#F4A300" />
      </g>
    </svg>
  );
}

const TONE_PATHS: Record<Tone, string> = {
  paid: 'M3.5 8.3 6.6 11.4 12.5 5',
  waiting: 'M8 4.8V8l2 1.5',
  blocked: 'M5 5l6 6M11 5l-6 6',
  neutral: 'M5 8h6',
};

/** A status always carries a word and a mark, never colour alone. */
export function StatusPill({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span className={`pill pill-${tone}`}>
      <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        {tone === 'waiting' ? <circle cx="8" cy="8" r="6" /> : null}
        <path d={TONE_PATHS[tone]} />
      </svg>
      {children}
    </span>
  );
}

type AmountSize = 'md' | 'lg' | 'xl';

/** An amount from minor units: a USDC string from /api, or a token amount from /v1. */
export function Amount(
  props: { minor: string; size?: AmountSize } | { token: TokenAmount; size?: AmountSize },
) {
  const size = props.size ?? 'md';
  const [digits, code] =
    'token' in props
      ? [formatAmount(props.token.amount, { decimals: props.token.scale }), props.token.asset]
      : [formatAmount(props.minor), 'USDC'];
  return (
    <span className={`amount amount-${size}`}>
      {digits}
      <span className="amount-code"> {code}</span>
    </span>
  );
}

export function TxLink({ hash, label }: { hash: string; label?: string }) {
  const { config } = useApp();
  return (
    <a
      className="mono-link"
      href={explorerTx(config, hash)}
      target="_blank"
      rel="noreferrer"
      title={hash}
    >
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

export function ErrorNotice({
  error,
  onRetry,
  requestId,
}: {
  error: string;
  onRetry?: () => void;
  /** The server's id for the failed request, to quote when asking for help. */
  requestId?: string | null;
}) {
  return (
    <Notice tone="blocked" title="That did not work">
      <p>{error}</p>
      {requestId === undefined || requestId === null ? null : (
        <p className="notice-ref">
          Reference <span className="mono">{requestId}</span>
        </p>
      )}
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

/**
 * A small "i" that shows a line of explanation on hover, focus or tap. The
 * text stays in the page for screen readers and is placed on screen with
 * fixed coordinates, so a scrolling table never clips it.
 */
export function Tip({ text, label = 'More about this' }: { text: ReactNode; label?: string }) {
  const id = useId();
  const ref = useRef<HTMLButtonElement>(null);
  const [at, setAt] = useState<{ top: number; left: number } | null>(null);
  const show = () => {
    const r = ref.current?.getBoundingClientRect();
    if (r === undefined) return;
    const left = Math.min(Math.max(r.left + r.width / 2, 150), window.innerWidth - 150);
    setAt({ top: r.bottom + 8, left });
  };
  const hide = () => {
    setAt(null);
  };
  useEffect(() => {
    if (at === null) return;
    const close = () => {
      setAt(null);
    };
    window.addEventListener('scroll', close, { passive: true, capture: true });
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('scroll', close, { capture: true });
      window.removeEventListener('resize', close);
    };
  }, [at]);
  return (
    <span className="tip">
      <button
        ref={ref}
        type="button"
        className="tip-btn"
        aria-describedby={id}
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
        onClick={() => {
          if (at === null) show();
          else hide();
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') hide();
        }}
      >
        <Icon name="info" size={16} />
        <span className="sr-only">{label}</span>
      </button>
      <span
        role="tooltip"
        id={id}
        className={`tip-pop${at === null ? '' : ' tip-on'}`}
        style={at === null ? undefined : { top: at.top, left: at.left }}
      >
        {text}
      </span>
    </span>
  );
}

export interface FieldProps {
  readonly label: string;
  /** One short line under the field, only where it is needed while typing. */
  readonly help?: ReactNode;
  /** The longer explanation, behind an info button next to the label. */
  readonly tip?: ReactNode;
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
  const numeric = props.inputMode === 'decimal' || props.inputMode === 'numeric';
  return (
    <div className={`field${props.error === undefined ? '' : ' field-invalid'}`}>
      <div className="field-top">
        <label htmlFor={id}>{props.label}</label>
        {props.tip === undefined ? null : <Tip text={props.tip} label={`About ${props.label}`} />}
      </div>
      <div className="input-wrap">
        <input
          id={id}
          value={props.value}
          onChange={(e) => {
            props.onChange(e.target.value);
          }}
          inputMode={props.inputMode ?? 'text'}
          className={props.mono === true ? 'mono' : numeric ? 'num' : undefined}
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

/**
 * Copies a value. With `icon` it is a small square button for table cells and
 * IDs; the label is still read out.
 */
export function CopyButton({
  text,
  label = 'Copy',
  icon = false,
}: {
  text: string;
  label?: string;
  icon?: boolean;
}) {
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
  const copy = () => {
    void navigator.clipboard.writeText(text).then(
      () => {
        setCopied(true);
      },
      () => {
        setCopied(false);
      },
    );
  };
  if (icon) {
    return (
      <button
        type="button"
        className={`copy-icon${copied ? ' copy-done' : ''}`}
        onClick={copy}
        title={copied ? 'Copied' : label}
      >
        <Icon name={copied ? 'check' : 'copy'} size={15} />
        <span className="sr-only">{label}</span>
        <span className="sr-only" aria-live="polite">
          {copied ? 'Copied to the clipboard' : ''}
        </span>
      </button>
    );
  }
  return (
    <button type="button" className="btn btn-small" onClick={copy}>
      <Icon name={copied ? 'check' : 'copy'} size={16} />
      {copied ? 'Copied' : label}
      <span className="sr-only" aria-live="polite">
        {copied ? 'Copied to the clipboard' : ''}
      </span>
    </button>
  );
}

/** A long ID or hash cut to fit one line, with the whole value one click away. */
export function IdText({
  value,
  keep = 6,
  copyLabel,
}: {
  value: string;
  keep?: number;
  copyLabel: string;
}) {
  return (
    <span className="id-text">
      <span className="mono" title={value}>
        {shortAddress(value, keep)}
      </span>
      <CopyButton text={value} label={copyLabel} icon />
    </span>
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
  confirmDisabled = false,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  children: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  busy?: boolean;
  /** Holds the confirm button until the person has done what the dialog asks. */
  confirmDisabled?: boolean;
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
          disabled={busy || confirmDisabled}
        >
          {busy ? <Spinner /> : null}
          {confirmLabel}
        </button>
      </div>
    </dialog>
  );
}

/** Marks a feature that is visible but not built yet. Never a payment status. */
export function SoonTag({ label = 'Soon' }: { label?: 'Soon' | 'In progress' }) {
  return <span className="soon">{label}</span>;
}

/** What is planned next to a page, in one quiet row: a tag and the names. */
export function SoonRow({ title, items }: { title: string; items: readonly string[] }) {
  return (
    <section className="soon-row" aria-label={title}>
      <SoonTag />
      <span className="soon-row-title">{title}</span>
      <ul>
        {items.map((i) => (
          <li key={i}>{i}</li>
        ))}
      </ul>
    </section>
  );
}

/** A screen that is planned and on the way: shown, labelled, never hidden. */
export function ComingSoon({
  title,
  lede,
  items,
  children,
}: {
  title: string;
  lede: string;
  items: readonly string[];
  children?: ReactNode;
}) {
  const id = useId();
  return (
    <section className="card coming" aria-labelledby={id}>
      <div className="card-head">
        <h2 id={id} className="card-title">
          {title}
        </h2>
        <SoonTag label="In progress" />
      </div>
      <p className="muted">{lede}</p>
      <ul className="coming-items">
        {items.map((i) => (
          <li key={i}>
            <span>{i}</span>
            <SoonTag />
          </li>
        ))}
      </ul>
      {children}
    </section>
  );
}

/** An empty list: one line and, where there is one, the one thing to do. */
export function Empty({ text, action }: { text: string; action?: ReactNode }) {
  return (
    <div className="empty">
      <p>{text}</p>
      {action ?? null}
    </div>
  );
}
