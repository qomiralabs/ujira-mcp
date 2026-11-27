// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// What the recipient screens say about a recipient on /v1: a word for its
// status, why it cannot be paid and what fixes it, and the invite link that
// lets the person add and prove their own wallet in the embed widget.

import type { EmbedSession, V1Recipient } from './v1Schemas';
import type { Tone } from './words';

export interface RecipientWord {
  readonly label: string;
  readonly tone: Tone;
  /** Why a payout cannot go to them now; null when it can. */
  readonly why: string | null;
  /** The one thing that fixes it; null when there is nothing to do here. */
  readonly todo: string | null;
  /** True when looking again on the chain can change it. */
  readonly recheck: boolean;
  /** True when an invite link is the fix. */
  readonly invite: boolean;
}

const WORDS: Record<string, RecipientWord> = {
  active: { label: 'Ready', tone: 'paid', why: null, todo: null, recheck: false, invite: false },
  needs_wallet: {
    label: 'No wallet',
    tone: 'waiting',
    why: 'No wallet yet.',
    todo: 'Send them an invite link to add one.',
    recheck: false,
    invite: true,
  },
  no_account: {
    label: 'Wallet not open',
    tone: 'blocked',
    why: 'This wallet is not open on Stellar yet.',
    todo: 'Ask them to send it a little XLM, then check again.',
    recheck: true,
    invite: false,
  },
  no_trustline: {
    label: 'No USDC',
    tone: 'blocked',
    why: 'This wallet cannot hold USDC yet.',
    todo: 'Ask them to add USDC in their wallet, then check again.',
    recheck: true,
    invite: false,
  },
  unchecked: {
    label: 'Not checked',
    tone: 'waiting',
    why: 'Stellar did not answer when we checked this wallet.',
    todo: 'Check again in a moment.',
    recheck: true,
    invite: false,
  },
  suspended: {
    label: 'On hold',
    tone: 'blocked',
    why: 'Payouts to them are on hold.',
    todo: 'Write to support@ujira.co to lift it.',
    recheck: false,
    invite: false,
  },
};

const UNKNOWN: RecipientWord = {
  label: 'Unknown',
  tone: 'neutral',
  why: 'This server sent a status the dashboard does not know yet.',
  todo: 'Reload the page.',
  recheck: true,
  invite: false,
};

/** The words for a recipient. A status with no words still gets an honest line. */
export function recipientWord(r: Pick<V1Recipient, 'status' | 'payable'>): RecipientWord {
  const word = Object.hasOwn(WORDS, r.status) ? WORDS[r.status] : undefined;
  if (word !== undefined) return word;
  return r.payable ? { ...UNKNOWN, label: 'Ready', tone: 'paid', why: null, todo: null } : UNKNOWN;
}

export const LABEL_MAX = 100;

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

/** Why a name cannot be used, or null. The server checks it too. */
export function recipientLabelProblem(raw: string): string | null {
  const name = raw.trim();
  if (name === '') return 'Enter a name.';
  if (name.length > LABEL_MAX) return `Keep it to ${String(LABEL_MAX)} characters.`;
  if (CONTROL.test(name)) return 'Use letters, numbers and spaces.';
  return null;
}

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;

/** Why an email cannot be used, or null. Empty is fine: it is optional. */
export function emailProblem(raw: string): string | null {
  const email = raw.trim();
  if (email === '') return null;
  if (email.length > 254 || !EMAIL.test(email)) return 'That is not an email address.';
  return null;
}

/** Where the embed widget opens for an invite. */
export const INVITE_PATH = '/embed/v1/invite';

/**
 * The link a recipient opens to add their wallet. The token rides in the
 * fragment, so the browser never sends it to a server, a log or a Referer.
 */
export function inviteLink(origin: string, token: string): string {
  return `${origin.replace(/\/+$/, '')}${INVITE_PATH}#token=${encodeURIComponent(token)}`;
}

export const INVITE_LIFETIMES = [
  { seconds: 60 * 60, label: '1 hour' },
  { seconds: 24 * 60 * 60, label: '1 day' },
  { seconds: 7 * 24 * 60 * 60, label: '7 days' },
] as const;

export const DEFAULT_INVITE_SECONDS = 24 * 60 * 60;

export type InviteState = 'live' | 'expired' | 'revoked';

export function inviteState(
  s: Pick<EmbedSession, 'expiresAt' | 'revokedAt'>,
  now: number = Date.now(),
): InviteState {
  if (s.revokedAt !== null) return 'revoked';
  const ends = Date.parse(s.expiresAt);
  return Number.isNaN(ends) || ends <= now ? 'expired' : 'live';
}

/** "28 Nov, 14:05" in the person's own time zone. */
export function whenText(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}
