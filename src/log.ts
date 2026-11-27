// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// Log lines. Code writes one line per event, `event=name key=value ...`,
// through a plain `(line: string) => void`, so a test can collect lines as
// strings. The process entry point hands that function `jsonLog`, which turns
// each line into one JSON object. That sink is the one place every line in
// the process passes through, so it is where secrets and personal data are
// taken out, whatever the code that wrote the line did.
//
// Correlation: a request runs inside `withLogContext`, and every line written
// while it runs carries the context's fields: the request id the HTTP server
// made, and the principal and project once a caller is known. A payout's
// lines carry its payout id, so one payout can be followed across requests
// and jobs.

import { AsyncLocalStorage } from 'node:async_hooks';

export type Log = (line: string) => void;

export type LogValue = string | number | bigint | boolean | null | undefined;
export type LogFields = Readonly<Record<string, LogValue>>;

/** The fields that tie lines together, written first in every JSON line that has them. */
export const CORRELATION_FIELDS = ['requestId', 'payoutId', 'principalId', 'projectId'] as const;
export type CorrelationField = (typeof CORRELATION_FIELDS)[number];

/** The alert lines an operator pages on. Each is written at level error with `alert` set. */
export const ALERT_EVENTS = [
  'payout_dead_letter',
  'fee_sponsor_low',
  'executor_low',
  'reconcile_stale',
] as const;
export type AlertEvent = (typeof ALERT_EVENTS)[number];

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export const REDACTED = '[redacted]';

const EVENT = /^[a-z][a-z0-9_]*$/;
const KEY = /^[A-Za-z][A-Za-z0-9_.]*$/;
const BARE = /^[^\s"\\]+$/;

/** Longer values are cut, so one line cannot flood the log. */
const MAX_VALUE = 512;
const MAX_MESSAGE = 4096;

function quote(value: string): string {
  if (BARE.test(value)) return value;
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, '\\n')}"`;
}

/**
 * One line in the `event=name key=value` form. Undefined fields are left
 * out; values with spaces or quotes are quoted, so the sink reads them back
 * exactly. Writing a line never throws, so a log call cannot fail a payout:
 * a malformed event name becomes `log_misnamed`, and a malformed field name
 * is dropped.
 */
export function logLine(event: string, fields: LogFields = {}): string {
  const parts = [`event=${EVENT.test(event) ? event : 'log_misnamed'}`];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || !KEY.test(key) || key === 'event') continue;
    parts.push(`${key}=${quote(value === null ? 'null' : String(value))}`);
  }
  return parts.join(' ');
}

/**
 * Reads a line `logLine` wrote. Anything else, including a line that only
 * starts like one, is undefined, and the sink keeps it as free text.
 */
export function parseLine(line: string): Map<string, string> | undefined {
  if (!line.startsWith('event=')) return undefined;
  const out = new Map<string, string>();
  let at = 0;
  while (at < line.length) {
    const eq = line.indexOf('=', at);
    if (eq < 0) return undefined;
    const key = line.slice(at, eq);
    if (!KEY.test(key) || out.has(key)) return undefined;
    let next = eq + 1;
    let value = '';
    if (line[next] === '"') {
      next += 1;
      let closed = false;
      while (next < line.length) {
        const ch = line.charAt(next);
        if (ch === '\\' && next + 1 < line.length) {
          const escaped = line.charAt(next + 1);
          value += escaped === 'n' ? '\n' : escaped;
          next += 2;
          continue;
        }
        next += 1;
        if (ch === '"') {
          closed = true;
          break;
        }
        value += ch;
      }
      if (!closed) return undefined;
    } else {
      const space = line.indexOf(' ', next);
      const end = space < 0 ? line.length : space;
      value = line.slice(next, end);
      next = end;
    }
    out.set(key, value);
    if (next < line.length) {
      if (line[next] !== ' ') return undefined;
      next += 1;
    }
    at = next;
  }
  const event = out.get('event');
  return event !== undefined && EVENT.test(event) ? out : undefined;
}

// Field names whose values are never written, whatever they hold.
const SECRET_KEY =
  /secret|passw|passphrase|token|authori[sz]ation|cookie|signature|signed|seed|mnemonic|private|credential|xdr|envelope|email|phone|label|metadata|body|header|memo|session|key$/i;
// Field names that name a person or where they are paid.
const PERSONAL_KEY = /^(recipient|destination|address|name|ip|clientIp|from|to)$/i;

function mask(account: string): string {
  return `${account.slice(0, 4)}...${account.slice(-4)}`;
}

/** Long runs in the base64 alphabets: signatures, envelopes, session tokens. */
function blob(run: string): string {
  const mixed = /[a-z]/.test(run) && /[A-Z]/.test(run) && /[0-9+/_=-]/.test(run);
  return mixed ? REDACTED : run;
}

// In order: each rule sees what the ones before it left.
const TEXT_RULES: readonly (readonly [RegExp, string | ((match: string) => string)])[] = [
  // Credentials in a URL, such as a database connection string.
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, `$1${REDACTED}@`],
  [/\b(bearer|basic)\s+[^\s"]+/gi, `$1 ${REDACTED}`],
  // JSON web tokens.
  [/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?/g, REDACTED],
  // UJIRA API keys.
  [/\bujk_[A-Za-z0-9_]+/g, REDACTED],
  // Stellar secret seeds.
  [/\bS[A-Z2-7]{55}\b/g, REDACTED],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g, REDACTED],
  [/\+[1-9]\d{7,14}\b/g, REDACTED],
  [/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, REDACTED],
  // Hex longer than a hash: a signature or key material. Hashes and payout ids are 64.
  [/\b[0-9a-fA-F]{96,}\b/g, REDACTED],
  [/[A-Za-z0-9+/_-]{32,}={0,2}/g, blob],
  // Stellar accounts and muxed accounts, which name a person. Contracts (C...) stay.
  [/\b(?:G[A-Z2-7]{55}|M[A-Z2-7]{68})\b/g, mask],
];

/** Takes secrets and personal data out of free text. */
export function redactText(text: string): string {
  let out = text;
  for (const [pattern, replace] of TEXT_RULES) {
    out =
      typeof replace === 'string' ? out.replace(pattern, replace) : out.replace(pattern, replace);
  }
  return out;
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

/** One field's value as it may be written. */
export function redactField(key: string, value: string): string {
  if (SECRET_KEY.test(key) || PERSONAL_KEY.test(key)) return REDACTED;
  return clip(redactText(value), MAX_VALUE);
}

const context = new AsyncLocalStorage<Record<string, string>>();

/** Runs `work` with these fields on every line written while it runs, added to any already set. */
export function withLogContext<T>(fields: Readonly<Record<string, string>>, work: () => T): T {
  return context.run({ ...context.getStore(), ...fields }, work);
}

/** Adds fields to the context already running, such as the principal once a caller is known. */
export function addLogContext(fields: Readonly<Partial<Record<CorrelationField, string>>>): void {
  const store = context.getStore();
  if (store === undefined) return;
  for (const [key, value] of Object.entries(fields)) store[key] = value;
}

/** The fields the running context adds to a line. */
export function logContext(): Readonly<Record<string, string>> {
  return { ...context.getStore() };
}

const ALERTS: ReadonlySet<string> = new Set(ALERT_EVENTS);
const LEVELS: ReadonlySet<string> = new Set(LOG_LEVELS);
// Set by the sink itself; a line cannot overwrite them.
const RESERVED: ReadonlySet<string> = new Set(['time', 'service', 'message', 'alert', 'level']);

function levelOf(event: string, asked: string | undefined): LogLevel {
  if (asked !== undefined && LEVELS.has(asked)) return asked as LogLevel;
  if (ALERTS.has(event)) return 'error';
  return /(^|_)(failed|error)$/.test(event) ? 'error' : 'info';
}

/** Integers read back as numbers; everything else stays a string. */
function typed(value: string): string | number {
  return /^-?(?:0|[1-9]\d{0,14})$/.test(value) ? Number.parseInt(value, 10) : value;
}

export interface JsonLogOptions {
  /** Receives one JSON object per call, without a newline. */
  readonly write: (json: string) => void;
  /** Which process wrote the line, such as ujira-mcp-http. */
  readonly service: string;
  readonly now?: () => Date;
}

/** The record one line becomes; exported for the tests. */
export function logRecord(
  line: string,
  service: string,
  time: Date,
  ctx: Readonly<Record<string, string>> = {},
): Record<string, string | number> {
  const parsed = parseLine(line);
  if (parsed === undefined) {
    const text = clip(redactText(line), MAX_MESSAGE);
    const record: Record<string, string | number> = {
      time: time.toISOString(),
      level: /\b(fail|failed|error)\b/i.test(line) ? 'error' : 'info',
      service,
      event: 'log',
      message: text,
    };
    for (const [key, value] of Object.entries(ctx)) {
      if (!RESERVED.has(key) && key !== 'event') record[key] = redactField(key, value);
    }
    return record;
  }

  const event = parsed.get('event') ?? 'log';
  const merged = new Map<string, string>();
  for (const name of CORRELATION_FIELDS) {
    const value = parsed.get(name) ?? ctx[name];
    if (value !== undefined) merged.set(name, value);
  }
  for (const [key, value] of Object.entries(ctx)) {
    if (!merged.has(key)) merged.set(key, value);
  }
  for (const [key, value] of parsed) {
    if (key !== 'event' && !merged.has(key)) merged.set(key, value);
  }

  const level = levelOf(event, parsed.get('level'));
  const record: Record<string, string | number> = {
    time: time.toISOString(),
    level,
    service,
    event,
    ...(ALERTS.has(event) ? { alert: event } : {}),
    message: '',
  };
  const shown: Record<string, string> = {};
  for (const [key, value] of merged) {
    if (RESERVED.has(key) || key === 'event') continue;
    const safe = redactField(key, value);
    shown[key] = safe;
    record[key] = typed(safe);
  }
  record['message'] = clip(logLine(event, shown), MAX_MESSAGE);
  return record;
}

/**
 * The process sink: every line becomes one JSON object, with the time, the
 * level, the service, the correlation fields of the running context, and
 * nothing secret or personal.
 */
export function jsonLog(options: JsonLogOptions): Log {
  const now = options.now ?? (() => new Date());
  return (line) => {
    options.write(JSON.stringify(logRecord(line, options.service, now(), logContext())));
  };
}

/** The code an error is logged by: its own code or class, never its message. */
export function errorCode(error: unknown): string {
  if (!(error instanceof Error)) return 'non_error';
  const code: unknown = (error as { code?: unknown }).code;
  if (typeof code === 'string' && /^[A-Za-z0-9_]{1,48}$/.test(code)) return code;
  return /^[A-Za-z][A-Za-z0-9]{0,47}$/.test(error.name) ? error.name : 'Error';
}
