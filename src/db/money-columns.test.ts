// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// A money column is an amount, the currency or the asset and chain, and a
// scale, tied to the reference data by a foreign key. This file builds one
// table of each shape, the way every money table does, and shows the
// database refusing money at a scale its currency or token does not allow.

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { createTestDatabase, type TestDatabase } from './testing/harness.js';

const adminUrl = inject('dbAdminUrl');

let database: TestDatabase;
let client: pg.Client;

beforeAll(async () => {
  database = await createTestDatabase(adminUrl, import.meta.url);
  client = new pg.Client({ connectionString: database.url });
  await client.connect();
  await client.query(`
    create table public.token_money (
      amount ujira.amount not null,
      asset text not null,
      chain text not null,
      scale ujira.scale not null,
      foreign key (asset, chain, scale)
        references ujira.settlement_tokens (asset, chain, token_scale)
    );
    create table public.fiat_money (
      amount ujira.amount not null,
      currency text not null,
      scale ujira.scale not null,
      foreign key (currency, scale) references ujira.currency_scales (currency, scale)
    );
  `);
});

afterAll(async () => {
  await client.end();
  await database.drop();
});

async function refusal(sql: string, values: unknown[]): Promise<string | undefined> {
  try {
    await client.query(sql, values);
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

const insertToken =
  'insert into public.token_money (amount, asset, chain, scale) values ($1, $2, $3, $4)';
const insertFiat = 'insert into public.fiat_money (amount, currency, scale) values ($1, $2, $3)';

describe('token money columns', () => {
  it('accepts USDC at scale 7 on stellar', async () => {
    expect(await refusal(insertToken, ['10000000', 'USDC', 'stellar', 7])).toBeUndefined();
  });

  it('USDC at scale 6 on stellar is rejected', async () => {
    expect(await refusal(insertToken, ['1000000', 'USDC', 'stellar', 6])).toBe('23503');
  });

  it('rejects a chain or an asset the reference data does not have', async () => {
    expect(await refusal(insertToken, ['1', 'USDC', 'celo', 7])).toBe('23503');
    expect(await refusal(insertToken, ['1', 'USDT', 'stellar', 7])).toBe('23503');
  });

  it('rejects an amount the domain refuses even when the token is right', async () => {
    expect(await refusal(insertToken, ['1.5', 'USDC', 'stellar', 7])).toBe('23514');
  });
});

describe('fiat money columns', () => {
  it('accepts a currency at its minor units and at every finer scale up to 18', async () => {
    expect(await refusal(insertFiat, ['100', 'USD', 2])).toBeUndefined();
    expect(await refusal(insertFiat, ['100', 'NGN', 18])).toBeUndefined();
  });

  it('rejects a scale coarser than the minor units, and an unknown currency', async () => {
    expect(await refusal(insertFiat, ['1', 'USD', 1])).toBe('23503');
    expect(await refusal(insertFiat, ['1', 'XXX', 2])).toBe('23503');
  });

  it('rejects a scale beyond 18 before the foreign key is reached', async () => {
    expect(await refusal(insertFiat, ['1', 'USD', 19])).toBe('23514');
  });
});
