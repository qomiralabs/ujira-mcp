// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// Which parts of the server one process runs. The same image runs as `web`
// (the site, the console, the API and the MCP routes), as `worker` (queued
// jobs, no HTTP listener) or as both, which is what a single service runs.

import { EngineError } from '../errors.js';

export const ROLES = ['web', 'worker'] as const;
export type Role = (typeof ROLES)[number];

/** Unset means both, so a deploy that does not name the roles keeps serving as before. */
export const DEFAULT_ROLES: readonly Role[] = ['web', 'worker'];

const USAGE = 'UJIRA_ROLES must be web, worker or web,worker';

function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}

/** Names a bad entry only when it is short and plain, so a pasted secret is never echoed. */
function shown(entry: string): string {
  return /^[A-Za-z0-9_.-]{1,32}$/.test(entry) ? `"${entry}"` : 'an entry';
}

/**
 * Reads `UJIRA_ROLES`. Entries are comma separated and trimmed; an empty
 * entry, an unknown role or a repeated one refuses to start, since a typo
 * that quietly ran nothing would look like a healthy deploy. The result is
 * always in the order of `ROLES`.
 */
export function parseRoles(raw: string | undefined): readonly Role[] {
  if (raw === undefined || raw.trim() === '') return DEFAULT_ROLES;
  const chosen = new Set<Role>();
  for (const part of raw.split(',')) {
    const entry = part.trim();
    if (entry === '') throw new EngineError('config_invalid', `${USAGE}, with no empty entry`);
    if (!isRole(entry)) {
      throw new EngineError('config_invalid', `${USAGE}; ${shown(entry)} is not a role`);
    }
    if (chosen.has(entry)) {
      throw new EngineError('config_invalid', `${USAGE}; "${entry}" is named twice`);
    }
    chosen.add(entry);
  }
  return ROLES.filter((role) => chosen.has(role));
}
