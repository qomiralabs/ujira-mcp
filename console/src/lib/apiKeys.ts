// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// What the developers screen knows about a project's API keys: the scopes and
// bounds the server takes, the state of each key, and the examples a person
// copies. The server checks every one of these again; they are here so a
// mistake shows next to the field instead of after a round trip.

import { ApiError } from './api';
import type { V1Api } from './v1';
import type { ApiKey } from './v1Schemas';

/** Every scope the server accepts, in its order. */
export const API_SCOPES = [
  'payouts:read',
  'payouts:write',
  'approvals:write',
  'recipients:read',
  'recipients:write',
  'mandates:read',
  'mandates:write',
  'receipts:read',
  'webhooks:manage',
  'corridors:read',
] as const;
export type ApiScope = (typeof API_SCOPES)[number];

/** Active keys a project may hold at once. */
export const KEY_LIMIT = 20;
export const EXPIRY_MIN_DAYS = 1;
export const EXPIRY_MAX_DAYS = 730;
export const EXPIRY_DEFAULT_DAYS = 365;
export const KEY_NAME_MAX = 100;

const DAY_MS = 86_400_000;

export interface ScopeArea {
  readonly area: string;
  readonly scopes: readonly { readonly scope: ApiScope; readonly label: string }[];
  /** Shown, but not offered until the feature behind it ships. */
  readonly soon?: boolean;
}

export const SCOPE_AREAS: readonly ScopeArea[] = [
  {
    area: 'Payouts',
    scopes: [
      { scope: 'payouts:read', label: 'Read' },
      { scope: 'payouts:write', label: 'Write' },
    ],
  },
  {
    area: 'Recipients',
    scopes: [
      { scope: 'recipients:read', label: 'Read' },
      { scope: 'recipients:write', label: 'Write' },
    ],
  },
  {
    area: 'Mandates',
    scopes: [
      { scope: 'mandates:read', label: 'Read' },
      { scope: 'mandates:write', label: 'Write' },
    ],
  },
  { area: 'Receipts', scopes: [{ scope: 'receipts:read', label: 'Read' }] },
  { area: 'Approvals', scopes: [{ scope: 'approvals:write', label: 'Write' }] },
  { area: 'Webhooks', scopes: [{ scope: 'webhooks:manage', label: 'Manage' }], soon: true },
  { area: 'Corridors', scopes: [{ scope: 'corridors:read', label: 'Read' }], soon: true },
];

/** What a new key can do unless the person changes it: pay and check payouts. */
export const DEFAULT_SCOPES: readonly ApiScope[] = ['payouts:read', 'payouts:write'];

/** Owners and admins manage keys; the server refuses everyone else. */
export function canManageKeys(role: string): boolean {
  return role === 'owner' || role === 'admin';
}

export type KeyState = 'active' | 'revoked' | 'expired';

/** As the server counts it: active until revoked or until its expiry passes. */
export function keyState(k: ApiKey, now: number = Date.now()): KeyState {
  if (k.revokedAt !== null) return 'revoked';
  const ends = Date.parse(k.expiresAt);
  return !Number.isNaN(ends) && ends <= now ? 'expired' : 'active';
}

/** Active keys first, then the newest. */
export function sortKeys(keys: readonly ApiKey[], now: number = Date.now()): ApiKey[] {
  const rank = (k: ApiKey) => (keyState(k, now) === 'active' ? 0 : 1);
  return [...keys].sort(
    (a, b) =>
      rank(a) - rank(b) ||
      (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : a.id < b.id ? -1 : 1),
  );
}

export function keyLabel(k: ApiKey): string {
  return k.name ?? 'Unnamed key';
}

/** A name the server will take: trimmed, 1 to 100 characters, no control characters. */
export function checkKeyName(raw: string): { name: string } | { error: string } {
  const name = raw.trim();
  if (name === '') return { error: 'Name the key.' };
  // Counted as the server counts, in UTF-16 units.
  if (name.length > KEY_NAME_MAX) return { error: `Up to ${KEY_NAME_MAX} characters.` };
  if (/\p{Cc}/u.test(name)) return { error: 'Use letters, numbers and punctuation only.' };
  return { name };
}

/** Whole days from 1 to 730. */
export function checkExpiryDays(raw: string): { days: number } | { error: string } {
  const text = raw.trim();
  const days = /^\d{1,4}$/.test(text) ? Number.parseInt(text, 10) : Number.NaN;
  if (Number.isNaN(days) || days < EXPIRY_MIN_DAYS || days > EXPIRY_MAX_DAYS) {
    return { error: `Between ${EXPIRY_MIN_DAYS} and ${EXPIRY_MAX_DAYS} days.` };
  }
  return { days };
}

/** The day a key made now with `days` stops working. */
export function expiryDate(days: number, now: number = Date.now()): Date {
  return new Date(now + days * DAY_MS);
}

export type KeyList =
  | { readonly kind: 'forbidden' }
  | { readonly kind: 'keys'; readonly items: readonly ApiKey[]; readonly truncated: boolean };

// The server sends at most 100 a page; revoked keys stay listed, so a project
// can collect many over time.
const KEY_PAGE = 100;
const KEY_PAGES = 10;

/**
 * Every key in the open project. A member whose role cannot manage keys gets
 * a FORBIDDEN from the server, which is an answer here, not a failure.
 */
export async function readKeys(v1: V1Api): Promise<KeyList> {
  const seen = new Set<string>();
  const items: ApiKey[] = [];
  let cursor: string | undefined;
  try {
    for (let n = 0; n < KEY_PAGES; n += 1) {
      const page = await v1.apiKeys({ cursor, limit: KEY_PAGE });
      for (const k of page.items) {
        if (seen.has(k.id)) continue;
        seen.add(k.id);
        items.push(k);
      }
      if (page.nextCursor === null) return { kind: 'keys', items, truncated: false };
      cursor = page.nextCursor;
    }
  } catch (e) {
    if (e instanceof ApiError && e.code === 'FORBIDDEN') return { kind: 'forbidden' };
    throw e;
  }
  return { kind: 'keys', items, truncated: true };
}

/** The connector address of one mandate, as the server serves it. */
export function mandateMcpUrl(origin: string, contractId: string): string {
  return `${origin}/m/${contractId}/mcp`;
}

export interface SnippetMandate {
  readonly id: string;
  readonly network: string;
  readonly asset: string;
  readonly scale: number;
}

/** A payout request with an idempotency key, ready to paste in a terminal. */
export function payoutCurl(origin: string, m: SnippetMandate): string {
  const amount = (2n * 10n ** BigInt(m.scale)).toString();
  const body = [
    '{',
    `    "mandateId": "${m.id}",`,
    '    "recipientId": "RECIPIENT_ID",',
    `    "amount": { "amount": "${amount}", "asset": "${m.asset}", "network": "${m.network}", "scale": ${String(m.scale)} },`,
    '    "taskId": "task-42"',
    '  }',
  ].join('\n');
  return [
    `curl -X POST ${origin}/v1/payouts \\`,
    '  -H "Authorization: Bearer $UJIRA_API_KEY" \\',
    '  -H "Idempotency-Key: task-42" \\',
    '  -H "Content-Type: application/json" \\',
    `  -d '${body}'`,
  ].join('\n');
}

/** An MCP client entry for the project endpoint, which takes an API key. */
export function keyMcpConfig(origin: string): string {
  return JSON.stringify(
    {
      mcpServers: {
        ujira: {
          url: `${origin}/v1/mcp`,
          headers: { Authorization: 'Bearer ${UJIRA_API_KEY}' },
        },
      },
    },
    null,
    2,
  );
}
