// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

import { describe, expect, it } from 'vitest';

import { apiKey } from '../test/v1Recorded';
import { ApiError } from './api';
import {
  API_SCOPES,
  SCOPE_AREAS,
  canManageKeys,
  checkExpiryDays,
  checkKeyName,
  keyMcpConfig,
  keyState,
  mandateMcpUrl,
  payoutCurl,
  readKeys,
  sortKeys,
} from './apiKeys';
import type { V1Api } from './v1';
import type { ApiKey } from './v1Schemas';

const NOW = Date.parse('2026-11-27T12:00:00.000Z');

function key(patch: Partial<ApiKey>): ApiKey {
  return { ...apiKey, ...patch };
}

describe('API keys', () => {
  it('offers every scope the server takes, once', () => {
    const offered = SCOPE_AREAS.flatMap((a) => a.scopes.map((s) => s.scope));
    expect([...offered].sort()).toEqual([...API_SCOPES].sort());
  });

  it('lets only owners and admins manage keys', () => {
    expect(canManageKeys('owner')).toBe(true);
    expect(canManageKeys('admin')).toBe(true);
    expect(canManageKeys('developer')).toBe(false);
    expect(canManageKeys('viewer')).toBe(false);
  });

  it('counts a key as the server does: active until revoked or past its expiry', () => {
    expect(keyState(key({}), NOW)).toBe('active');
    expect(keyState(key({ revokedAt: '2026-11-26T00:00:00.000Z' }), NOW)).toBe('revoked');
    expect(keyState(key({ expiresAt: '2026-11-27T12:00:00.000Z' }), NOW)).toBe('expired');
  });

  it('lists active keys first, newest first', () => {
    const a = key({ id: 'a', createdAt: '2026-11-01T00:00:00.000Z' });
    const b = key({ id: 'b', createdAt: '2026-11-20T00:00:00.000Z' });
    const c = key({
      id: 'c',
      createdAt: '2026-11-25T00:00:00.000Z',
      revokedAt: '2026-11-26T00:00:00.000Z',
    });
    expect(sortKeys([a, c, b], NOW).map((k) => k.id)).toEqual(['b', 'a', 'c']);
  });

  it('checks a name as the server will', () => {
    expect(checkKeyName('  Payroll runner ')).toEqual({ name: 'Payroll runner' });
    expect(checkKeyName('   ')).toEqual({ error: 'Name the key.' });
    expect(checkKeyName('x'.repeat(100))).toEqual({ name: 'x'.repeat(100) });
    expect(checkKeyName('x'.repeat(101))).toHaveProperty('error');
    expect(checkKeyName('line\nbreak')).toHaveProperty('error');
  });

  it('takes an expiry of 1 to 730 whole days', () => {
    expect(checkExpiryDays('365')).toEqual({ days: 365 });
    expect(checkExpiryDays('1')).toEqual({ days: 1 });
    expect(checkExpiryDays('730')).toEqual({ days: 730 });
    for (const bad of ['0', '731', '1.5', '-3', '', 'ten', '1e3']) {
      expect(checkExpiryDays(bad)).toEqual({ error: 'Between 1 and 730 days.' });
    }
  });

  it('reads every page, 100 at a time', async () => {
    const seen: (string | undefined)[] = [];
    const v1 = {
      apiKeys: (q?: { cursor?: string | undefined; limit?: number | undefined }) => {
        seen.push(q?.cursor);
        expect(q?.limit).toBe(100);
        return Promise.resolve(
          q?.cursor === undefined
            ? { items: [key({ id: 'a' })], nextCursor: 'next' }
            : { items: [key({ id: 'a' }), key({ id: 'b' })], nextCursor: null },
        );
      },
    } as unknown as V1Api;
    const list = await readKeys(v1);
    expect(seen).toEqual([undefined, 'next']);
    expect(list).toMatchObject({ kind: 'keys', truncated: false });
    expect(list.kind === 'keys' ? list.items.map((k) => k.id) : []).toEqual(['a', 'b']);
  });

  it('reads a refusal for the role as an answer, and any other failure as a failure', async () => {
    const refusing = (code: string, status: number) =>
      ({
        apiKeys: () => Promise.reject(new ApiError(code, 'no', status)),
      }) as unknown as V1Api;
    await expect(readKeys(refusing('FORBIDDEN', 403))).resolves.toEqual({ kind: 'forbidden' });
    await expect(readKeys(refusing('DB_UNAVAILABLE', 503))).rejects.toMatchObject({
      code: 'DB_UNAVAILABLE',
    });
  });

  it('writes the examples with the real addresses and no key', () => {
    const contract = 'CB4AYBA5NVQPVPNOWUCSZQK6ZIGOF7KSCS6SF6UV6D2OKPDXLHEPD4V7';
    expect(mandateMcpUrl('https://ujira.co', contract)).toBe(`https://ujira.co/m/${contract}/mcp`);
    const curl = payoutCurl('https://ujira.co', {
      id: 'm-1',
      network: 'stellar:testnet',
      asset: 'USDC',
      scale: 7,
    });
    expect(curl).toContain('curl -X POST https://ujira.co/v1/payouts');
    expect(curl).toContain('Idempotency-Key: task-42');
    expect(curl).toContain('Bearer $UJIRA_API_KEY');
    expect(curl).toContain('"amount": "20000000"');
    expect(curl).not.toContain('ujk_');
    const body = /-d '([\s\S]*)'$/.exec(curl)?.[1] ?? '';
    expect(JSON.parse(body)).toMatchObject({ mandateId: 'm-1', taskId: 'task-42' });
    const mcp = JSON.parse(keyMcpConfig('https://ujira.co')) as {
      mcpServers: { ujira: { url: string } };
    };
    expect(mcp.mcpServers.ujira.url).toBe('https://ujira.co/v1/mcp');
  });
});
