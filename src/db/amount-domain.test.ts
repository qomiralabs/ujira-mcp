// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { createTestDatabase, type TestDatabase } from './testing/harness.js';

const adminUrl = inject('dbAdminUrl');

// The signed 128 bit range Soroban stores amounts in. Written out here
// rather than imported, so the database bound is checked against the
// definition itself and not against another copy of it.
const I128_MIN = -(2n ** 127n);
const I128_MAX = 2n ** 127n - 1n;

let database: TestDatabase;
let client: pg.Client;

beforeAll(async () => {
  database = await createTestDatabase(adminUrl, import.meta.url);
  client = new pg.Client({ connectionString: database.url });
  await client.connect();
});

afterAll(async () => {
  await client.end();
  await database.drop();
});

// Each value is sent as text, the way the mapper sends it, and cast to the
// domain on the server.
async function cast(domain: string, value: string): Promise<string> {
  const result = await client.query<{ value: string }>(
    `select ($1::text)::${domain}::text as value`,
    [value],
  );
  return result.rows[0]?.value ?? '';
}

async function refusal(domain: string, value: string): Promise<string | undefined> {
  try {
    await cast(domain, value);
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

describe('ujira.amount', () => {
  it.each([
    ['the lower bound', I128_MIN.toString()],
    ['the upper bound', I128_MAX.toString()],
    ['zero', '0'],
    ['one minor unit', '1'],
    ['minus one minor unit', '-1'],
  ])('accepts %s', async (_, value) => {
    expect(await cast('ujira.amount', value)).toBe(value);
  });

  it.each([
    ['one below the lower bound', (I128_MIN - 1n).toString()],
    ['one above the upper bound', (I128_MAX + 1n).toString()],
    ['a fraction', '1.5'],
    ['an integer written with a decimal point', '2.0'],
    ['NaN', 'NaN'],
    ['Infinity', 'Infinity'],
    ['minus Infinity', '-Infinity'],
  ])('rejects %s', async (_, value) => {
    expect(await refusal('ujira.amount', value)).toBe('23514');
  });
});

describe('ujira.scale', () => {
  it('accepts 0 to 18', async () => {
    expect(await cast('ujira.scale', '0')).toBe('0');
    expect(await cast('ujira.scale', '18')).toBe('18');
  });

  it.each(['-1', '19'])('rejects %s', async (value) => {
    expect(await refusal('ujira.scale', value)).toBe('23514');
  });
});

describe('ujira.hash32', () => {
  it('accepts exactly 32 bytes', async () => {
    const hex = `\\x${'ab'.repeat(32)}`;
    expect(await cast('ujira.hash32', hex)).toBe(hex);
  });

  it.each([
    ['31 bytes', `\\x${'ab'.repeat(31)}`],
    ['33 bytes', `\\x${'ab'.repeat(33)}`],
    ['none', '\\x'],
  ])('rejects %s', async (_, value) => {
    expect(await refusal('ujira.hash32', value)).toBe('23514');
  });
});
