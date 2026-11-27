// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The key format, the closed list of scopes and what each member role may do
// with them. All in memory: none of this touches a database.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { scopePermission } from '../src/api/authenticate.js';
import { API_SCOPES } from '../src/auth/scopes.js';
import { can } from '../src/tenancy/roles.js';
import {
  base32,
  formatToken,
  hashSecret,
  issueToken,
  parseToken,
  tokenEnvironmentFor,
} from '../src/auth/token.js';

describe('the key format', () => {
  it.each(['live', 'test'] as const)('issues a %s key in the documented shape', (environment) => {
    const { token, prefix, secretSha256 } = issueToken(environment);
    expect(token).toMatch(new RegExp(`^ujk_${environment}_[a-z2-7]{16}_[a-z2-7]{59}$`));
    expect(prefix).toBe(token.slice(0, `ujk_${environment}_`.length + 16));
    // The prefix fits the column's format, and the security event's.
    expect(prefix).toMatch(/^[A-Za-z0-9_]{8,40}$/);
    expect(secretSha256).toHaveLength(32);
  });

  it('holds 256 bits of secret and 80 of id, freshly random each time', () => {
    const issued = Array.from({ length: 50 }, () => issueToken('test'));
    expect(new Set(issued.map((key) => key.prefix)).size).toBe(50);
    expect(new Set(issued.map((key) => key.token)).size).toBe(50);
  });

  it('parses what it issues, and keeps only the hash of the secret', () => {
    const { token, prefix, secretSha256 } = issueToken('live');
    const parsed = parseToken(token);
    expect(parsed).toMatchObject({ environment: 'live', prefix });
    const secret = parsed?.secret ?? '';
    expect(secret).toHaveLength(52);
    expect(hashSecret(secret)).toEqual(secretSha256);
    expect(hashSecret(secret)).toEqual(createHash('sha256').update(secret).digest());
    expect(secretSha256.toString('utf8')).not.toContain(secret);
    expect(formatToken(prefix, secret)).toBe(token);
  });

  it('refuses every single character change, so a typo never reaches the database', () => {
    const { token } = issueToken('test');
    const bodyStart = 'ujk_test_'.length;
    for (let at = bodyStart; at < token.length; at += 1) {
      if (token[at] === '_') continue;
      const swapped = token[at] === 'a' ? 'b' : 'a';
      expect(parseToken(`${token.slice(0, at)}${swapped}${token.slice(at + 1)}`), String(at)).toBe(
        null,
      );
    }
  });

  it.each([
    ['empty', ''],
    ['another scheme', 'sk_live_abc'],
    ['upper case', issueToken('test').token.toUpperCase()],
    ['an unknown environment', issueToken('test').token.replace('_test_', '_prod_')],
    ['too short', issueToken('test').token.slice(0, -1)],
    ['too long', `${issueToken('test').token}a`],
    ['surrounding space', ` ${issueToken('test').token}`],
    ['a digit base32 does not use', issueToken('test').token.replace(/_[a-z2-7]/, '_1')],
  ])('refuses %s', (_name, text) => {
    expect(parseToken(text)).toBeNull();
  });

  it('writes base32 without padding, as RFC 4648 lower case', () => {
    expect(base32(Buffer.from(''))).toBe('');
    expect(base32(Buffer.from('f'))).toBe('my');
    expect(base32(Buffer.from('foobar'))).toBe('mzxw6ytboi');
  });

  it('issues test keys on testnet and live keys only on the public network', () => {
    expect(tokenEnvironmentFor('testnet')).toBe('test');
    expect(tokenEnvironmentFor('pubnet')).toBe('live');
  });
});

describe('scopes', () => {
  it('are exactly the list the database check accepts', () => {
    const sql = readFileSync(
      new URL('../db/migrations/1800000000004_api_token_format.sql', import.meta.url),
      'utf8',
    );
    const up = sql.slice(0, sql.indexOf('-- Down Migration'));
    const list = /scopes <@ array\[([^\]]+)\]/.exec(up)?.[1] ?? '';
    const inDatabase = [...list.matchAll(/'([a-z_]+:[a-z_]+)'/g)].map((m) => m[1]);
    expect(inDatabase).toEqual([...API_SCOPES]);
  });

  it('let every member read, keep writes from viewers, and keep manage scopes to owners and admins', () => {
    const allowed = (role: string, scope: (typeof API_SCOPES)[number]) =>
      can(role, scopePermission(scope));
    for (const scope of API_SCOPES) {
      expect(allowed('owner', scope), scope).toBe(true);
      expect(allowed('admin', scope), scope).toBe(true);
    }
    expect(allowed('viewer', 'payouts:read')).toBe(true);
    expect(allowed('viewer', 'payouts:write')).toBe(false);
    expect(allowed('developer', 'payouts:write')).toBe(true);
    expect(allowed('developer', 'webhooks:manage')).toBe(false);
    expect(allowed('viewer', 'webhooks:manage')).toBe(false);
  });

  it('give a role this code does not know nothing at all', () => {
    for (const scope of API_SCOPES) {
      expect(can('auditor', scopePermission(scope)), scope).toBe(false);
    }
  });
});
